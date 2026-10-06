#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod diag;
mod wake;

use reqwest::blocking::Client;
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const LAN: &str = "https://panel.example.com";
const TAIL: &str = "https://panel.your-tailnet.ts.net";
static HAS_DOCUMENT: AtomicBool = AtomicBool::new(false);
static PAGE_LOADED: AtomicBool = AtomicBool::new(false);
const PANEL_SCRIPT: &str = include_str!("panel.js");

fn allowed(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("panel.example.com" | "panel.your-tailnet.ts.net")
        )
}

// Window title carries the connection (LAN/Tailscale + host). Until 06.10 panel.js also showed it
// as a fixed footer, which covered the Dispatcher's input field.
fn panel_title(host: Option<&str>) -> String {
    match host {
        Some("panel.example.com") => "CC Panel · LAN panel.example.com".into(),
        Some("panel.your-tailnet.ts.net") => {
            "CC Panel · Tailscale panel.your-tailnet.ts.net".into()
        }
        Some(h) => format!("CC Panel · {h}"),
        None => "CC Panel · offline".into(),
    }
}

// Chat windows (claude.ai, chatgpt.com): one per service, opened by intercepting the panel's
// links, so public/ needs no knowledge of the shell. No capability lists these labels, no
// initialization script runs in them, and they never load the panel.
struct Chat {
    label: &'static str,
    title: &'static str,
    home: &'static str,
    hosts: &'static [&'static str],
    // Native macOS app tried first, like the universal links on iPhone; the window is the fallback.
    bundle: &'static str,
}
const CHATS: [Chat; 2] = [
    Chat {
        label: "chat-claude",
        title: "Claude",
        home: "https://claude.ai/",
        hosts: &["claude.ai"],
        bundle: "com.anthropic.claudefordesktop",
    },
    Chat {
        label: "chat-chatgpt",
        title: "ChatGPT",
        home: "https://chatgpt.com/",
        hosts: &["chatgpt.com", "chat.openai.com"],
        bundle: "com.openai.codex",
    },
];
// Login and bot-check hosts a chat window may load. wry asks for every frame (iframes too),
// so anything else is refused silently; links opening a new window go to the default browser.
const CHAT_HOSTS: &[&str] = &[
    "accounts.google.com",
    "appleid.apple.com",
    "auth.openai.com",
    "login.microsoftonline.com",
    "login.live.com",
    "challenges.cloudflare.com",
];
const CHAT_SUFFIXES: &[&str] = &[
    ".claude.ai",
    ".chatgpt.com",
    ".openai.com",
    ".arkoselabs.com",
];
// Separate persistent WKWebsiteDataStore (macOS 14+; older macOS falls back to the default
// persistent store): chat logins survive restarts and never share a store with the panel.
const CHAT_STORE: [u8; 16] = [
    0xc0, 0x3d, 0x0e, 0x4e, 0xd9, 0x4b, 0x41, 0x2a, 0x83, 0xb1, 0xcb, 0x51, 0xbb, 0xb5, 0xde, 0x7b,
];
// Plain WKWebView UA lacks the Safari token; Google sign-in rejects it (disallowed_useragent).
const CHAT_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
static LAST_CHAT: AtomicUsize = AtomicUsize::new(0);
// Paths on the chat hosts that carry login state (codes, magic links): open the home page instead.
const AUTH_PATHS: &[&str] = &[
    "/login",
    "/logout",
    "/auth",
    "/api/",
    "/magic-link",
    "/oauth",
    "/sso",
];
// Google's refusal page: /signin/oauth/error?authError=<base64 protobuf naming the error>.
// Plain text plus the three base64 alignments of "disallowed_useragent".
const UA_BLOCKED: [&str; 4] = [
    "disallowed_useragent",
    "ZGlzYWxsb3dlZF91c2VyYWdl",
    "aXNhbGxvd2VkX3VzZXJhZ2Vu",
    "c2FsbG93ZWRfdXNlcmFnZW50",
];
static BLOCKED_AT: AtomicU64 = AtomicU64::new(0);
// App menu item "Otwórz w przeglądarce": enabled only while a chat window has focus.
struct ChatBrowserItem(MenuItem<tauri::Wry>);

fn https_host(url: &tauri::Url) -> Option<&str> {
    if url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
    {
        url.host_str()
    } else {
        None
    }
}

fn chat_index(url: &tauri::Url) -> Option<usize> {
    let host = https_host(url)?;
    CHATS.iter().position(|c| c.hosts.contains(&host))
}

fn chat_navigation(url: &tauri::Url) -> bool {
    if matches!(url.scheme(), "about" | "blob") {
        return true;
    }
    if allowed(url) {
        return false;
    }
    let Some(host) = https_host(url) else {
        return false;
    };
    chat_index(url).is_some()
        || CHAT_HOSTS.contains(&host)
        || CHAT_SUFFIXES.iter().any(|s| host.ends_with(s))
}

fn open_in_browser(url: &tauri::Url) {
    if https_host(url).is_none() || allowed(url) {
        return;
    }
    diag::log(&format!("przeglądarka: {}", log_url(url)));
    spawn_open(url.as_str());
}

// What the diagnostic log may say about a URL: never query, fragment or userinfo. Paths only
// for panel and chat hosts, cut at auth paths (magic-link tokens can sit in the path).
fn log_url(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or("");
    let path = url.path();
    let path = if !allowed(url) && chat_index(url).is_none() {
        String::new()
    } else if let Some(p) = AUTH_PATHS.iter().find(|p| path.starts_with(*p)) {
        format!("{p}…")
    } else {
        path.chars().take(80).collect()
    };
    format!("{}://{host}{path}", url.scheme())
}

#[cfg(target_os = "macos")]
fn spawn_open(url: &str) {
    // No shell: the URL is a single argv entry, already checked to be https.
    if let Ok(mut child) = std::process::Command::new("/usr/bin/open").arg(url).spawn() {
        std::thread::spawn(move || child.wait());
    }
}

#[cfg(not(target_os = "macos"))]
fn spawn_open(_: &str) {}

// `open -b` exits non-zero when no app with that bundle id is installed.
#[cfg(target_os = "macos")]
fn open_native(bundle: &str) -> bool {
    std::process::Command::new("/usr/bin/open")
        .args(["-b", bundle])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn open_native(_: &str) -> bool {
    false
}

const AUTH_POPUP_HOSTS: &[&str] = &[
    "accounts.google.com",
    "appleid.apple.com",
    "auth.openai.com",
    "login.microsoftonline.com",
    "login.live.com",
];
static POPUP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn auth_popup(
    app: &AppHandle,
    idx: usize,
    url: &tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> Option<tauri::WebviewWindow> {
    let host = https_host(url)?;
    if !AUTH_POPUP_HOSTS.contains(&host) {
        return None;
    }
    let label = format!(
        "{}-auth-{}",
        CHATS[idx].label,
        POPUP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    // WebKit loads the popup request itself into the returned view (opener config): starting
    // it at the URL again would race that load, so it starts blank as in the Tauri example.
    let blank: tauri::Url = "about:blank".parse().ok()?;
    let nav_label = label.clone();
    let load_label = label.clone();
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .window_features(features)
        .title(CHATS[idx].title)
        .inner_size(520.0, 680.0)
        .user_agent(CHAT_UA)
        .on_navigation(move |url| {
            let ok = chat_navigation(url);
            diag::log(&format!(
                "{nav_label}: nawigacja {} {}",
                log_url(url),
                if ok { "ok" } else { "ODRZUCONA" }
            ));
            ok
        })
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let loaded = payload.url();
                diag::log(&format!("{load_label}: załadowano {}", log_url(loaded)));
            }
        })
        .build();
    match built {
        Ok(window) => {
            diag::log(&format!("{label}: popup logowania {}", log_url(url)));
            Some(window)
        }
        Err(e) => {
            diag::log(&format!("{label}: popup nieudany ({e}) -> przeglądarka"));
            None
        }
    }
}

fn open_chat(app: &AppHandle, idx: usize, source: &'static str) {
    diag::log(&format!("{}: otwieranie ({source})", CHATS[idx].label));
    let handle = app.clone();
    // Callers include WebKit navigation callbacks on the main thread, where run_on_main_thread
    // runs the task inline (tauri-runtime-wry 2.12 send_user_message). Queued from a helper
    // thread, the window is built on a later event-loop turn, after WebKit's decision returns.
    std::thread::spawn(move || {
        if open_native(CHATS[idx].bundle) {
            diag::log(&format!("{}: natywna aplikacja", CHATS[idx].label));
            return;
        }
        let runner = handle.clone();
        let queued = runner.run_on_main_thread(move || {
            let chat = &CHATS[idx];
            LAST_CHAT.store(idx, Ordering::Release);
            if let Some(window) = handle.get_webview_window(chat.label) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                diag::log(&format!("{}: pokazane istniejące okno", chat.label));
                return;
            }
            let Ok(home) = chat.home.parse::<tauri::Url>() else {
                return;
            };
            let built = WebviewWindowBuilder::new(&handle, chat.label, WebviewUrl::External(home))
                .title(chat.title)
                .inner_size(1100.0, 850.0)
                .min_inner_size(420.0, 400.0)
                .user_agent(CHAT_UA)
                .data_store_identifier(CHAT_STORE)
                .on_navigation(move |url| {
                    if google_blocked(url) {
                        diag::log(&format!(
                            "{}: blokada Google (disallowed_useragent)",
                            CHATS[idx].label
                        ));
                        blocked_in_browser(idx);
                    }
                    chat_navigation(url)
                })
                .on_new_window({
                    let popups = handle.clone();
                    move |url, features| {
                        // OAuth popups (Google/Apple/MS) report back via window.opener: they must
                        // stay in-app with the opener's WebView configuration, not go to the browser.
                        if let Some(window) = auth_popup(&popups, idx, &url, features) {
                            return NewWindowResponse::Create { window };
                        }
                        diag::log(&format!(
                            "{}: nowe okno {} -> przeglądarka",
                            CHATS[idx].label,
                            log_url(&url)
                        ));
                        open_in_browser(&url);
                        NewWindowResponse::Deny
                    }
                })
                .build();
            match built {
                Ok(window) => {
                    diag::log(&format!("{}: okno utworzone", chat.label));
                    let hide = window.clone();
                    let events = handle.clone();
                    window.on_window_event(move |event| match event {
                        // Red X keeps the conversation: the next tile click shows the same window.
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = hide.hide();
                        }
                        WindowEvent::Focused(true) => {
                            LAST_CHAT.store(idx, Ordering::Release);
                            chat_menu_enabled(&events, true);
                        }
                        // Switching chat windows may report the new focus first: check them all.
                        WindowEvent::Focused(false) => {
                            let focused = CHATS.iter().any(|c| {
                                events
                                    .get_webview_window(c.label)
                                    .and_then(|w| w.is_focused().ok())
                                    .unwrap_or(false)
                            });
                            chat_menu_enabled(&events, focused);
                        }
                        _ => {}
                    });
                }
                Err(e) => {
                    diag::log(&format!("{}: okno nie powstało: {e}", chat.label));
                    eprintln!("CC Panel: okno {} nie powstało: {e}", chat.title);
                }
            }
        });
        if let Err(e) = queued {
            diag::log(&format!(
                "{}: zadanie nie trafiło do pętli zdarzeń: {e}",
                CHATS[idx].label
            ));
        }
    });
}

fn chat_menu_enabled(app: &AppHandle, enabled: bool) {
    if let Some(item) = app.try_state::<ChatBrowserItem>() {
        let _ = item.0.set_enabled(enabled);
    }
}

// What "Otwórz w przeglądarce" opens: the chat's current page (conversation, project) without
// query or fragment; login hosts and auth paths fall back to the home page, so OAuth codes,
// state and magic-link tokens never reach the browser's command line or history.
fn browser_url(idx: usize, current: Option<tauri::Url>) -> Option<tauri::Url> {
    let chat = &CHATS[idx];
    if let Some(mut url) = current {
        if https_host(&url).is_some_and(|h| chat.hosts.contains(&h))
            && !AUTH_PATHS.iter().any(|p| url.path().starts_with(p))
        {
            url.set_query(None);
            url.set_fragment(None);
            return Some(url);
        }
    }
    chat.home.parse().ok()
}

// Escape hatch when a login is refused inside WKWebView: same chat in the default browser.
fn chat_in_browser(app: &AppHandle) {
    let idx = LAST_CHAT.load(Ordering::Acquire) % CHATS.len();
    let current = app
        .get_webview_window(CHATS[idx].label)
        .and_then(|w| w.url().ok());
    if let Some(url) = browser_url(idx, current) {
        open_in_browser(&url);
    }
}

fn google_blocked(url: &tauri::Url) -> bool {
    https_host(url) == Some("accounts.google.com")
        && url.path().contains("/oauth/error")
        && url
            .query()
            .is_some_and(|q| UA_BLOCKED.iter().any(|s| q.contains(s)))
}

// Google refused the WebView: open the service's home page in the browser, at most every 30 s
// (wry asks per frame, and a retry would land on the same error page).
fn blocked_in_browser(idx: usize) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now.saturating_sub(BLOCKED_AT.swap(now, Ordering::AcqRel)) < 30 {
        return;
    }
    if let Some(url) = browser_url(idx, None) {
        open_in_browser(&url);
    }
}

fn show(app: &AppHandle, shell: bool) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval(&format!("window.CCPDesktop?.show({shell})"));
    }
}

// Menu "Panel" (Cmd+T terminal, Cmd+D Dyspozytor, Cmd+S sesje, 06.10). Same channel as show(): eval of a fixed
// string into the panel window, nothing exposed to the remote page (no IPC). The view switch itself lives in
// the page (public/nav-keys.js), so it changes without rebuilding the app. Cmd+T toggles the shell dock like
// Ctrl+` only when the panel already had focus; from a chat window it brings the panel up with the dock open.
fn go_view(app: &AppHandle, target: &'static str) {
    if let Some(window) = app.get_webview_window("panel") {
        let focused = window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval(&format!("window.CCPDesktop?.nav('{target}', {focused})"));
    }
}

fn reconnect(app: &AppHandle, origin: &str) {
    if let Some(window) = app.get_webview_window("panel") {
        if !HAS_DOCUMENT.load(Ordering::Acquire) {
            if let Ok(url) = format!("{origin}/#/mozg").parse() {
                let _ = window.navigate(url);
            }
            return;
        }
        let script = format!(
            "window.CCPDesktop?.reconnect({})",
            serde_json::to_string(origin).unwrap()
        );
        let _ = window.eval(&script);
    }
}

fn reachable(client: &Client, origin: &str) -> bool {
    // 401 is healthy: do not mistake the ordinary login screen for an outage.
    client
        .get(format!("{origin}/api/usage"))
        .send()
        .map(|r| r.status().is_success() || r.status().as_u16() == 401)
        .unwrap_or(false)
}

// Menu bar title shows no sample age (06.10); the age goes to the tooltip only.
fn provider(value: &Value, with_age: bool) -> String {
    let Some(windows) = value["windows"].as_array() else {
        return "brak danych".into();
    };
    windows
        .iter()
        .map(|w| {
            let key = w["key"].as_str().unwrap_or("?");
            match w["state"].as_str() {
                Some("ok") => {
                    let pct = w["pct"]
                        .as_f64()
                        .map(|v| format!("{v:.0}%"))
                        .unwrap_or_else(|| "?".into());
                    let age = w["age"]
                        .as_f64()
                        .map(|v| format!("{:.0}m", v / 60.0))
                        .unwrap_or_else(|| "?".into());
                    let stale = if w["stale"].as_bool() == Some(true) {
                        " stara"
                    } else {
                        ""
                    };
                    if with_age {
                        format!("{key} {pct} ({age}{stale})")
                    } else if stale.is_empty() {
                        format!("{key} {pct}")
                    } else {
                        format!("{key} {pct} (stara)")
                    }
                }
                Some("expired") => format!("{key} reset / wygasła próbka"),
                _ => format!("{key} brak danych"),
            }
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

fn tray_text(app: &AppHandle, text: &str) {
    tray_texts(app, text, text);
}

fn tray_texts(app: &AppHandle, title: &str, tooltip: &str) {
    if let Some(tray) = app.tray_by_id("usage") {
        let _ = tray.set_title(Some(title));
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn poll_usage(app: &AppHandle, client: &Client, origin: &str) {
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    let Ok(url) = format!("{origin}/api/usage").parse() else {
        return;
    };
    // Cookies stay in WKWebView's persistent store. Only this transient request
    // holds the HttpOnly cookie in memory; never log, persist or expose it to JS.
    let Ok(cookies) = window.cookies_for_url(url) else {
        tray_text(app, "C/X · magazyn cookies niedostępny");
        return;
    };
    let Some(cookie) = cookies.iter().find(|c| c.name() == "ccp") else {
        tray_text(app, "C/X · zaloguj się");
        return;
    };
    let response = client
        .get(format!("{origin}/api/usage"))
        .header(reqwest::header::COOKIE, format!("ccp={}", cookie.value()))
        .send();
    match response {
        Ok(r) if r.status().is_success() => match r.json::<Value>() {
            Ok(v) => tray_texts(
                app,
                &format!(
                    "C {} | X {}",
                    provider(&v, false),
                    provider(&v["codex"], false)
                ),
                &format!(
                    "C {} | X {}",
                    provider(&v, true),
                    provider(&v["codex"], true)
                ),
            ),
            Err(_) => tray_text(app, "C/X · błędna odpowiedź"),
        },
        Ok(r) if r.status().as_u16() == 401 => tray_text(app, "C/X · zaloguj się"),
        _ => tray_text(app, "C/X · offline (brak aktualnych danych)"),
    }
}

fn worker(app: AppHandle) {
    // No redirects: an authenticated cookie must never follow an HTTP redirect.
    let client = Client::builder()
        .timeout(Duration::from_secs(4))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTPS client");
    let mut last = SystemTime::now();
    let mut ticks = 12;
    loop {
        let now = SystemTime::now();
        let gap = now.duration_since(last).unwrap_or_default() > Duration::from_secs(40);
        last = now;
        let woke = wake::WOKE.swap(false, Ordering::AcqRel) || gap;
        let loaded = PAGE_LOADED.swap(false, Ordering::AcqRel);
        if ticks >= 12 || woke || loaded {
            ticks = 0;
            if let Some(window) = app.get_webview_window("panel") {
                if let Ok(url) = window.url() {
                    if allowed(&url) {
                        let origin = if url.host_str() == Some("panel.example.com") {
                            LAN
                        } else {
                            TAIL
                        };
                        let healthy = reachable(&client, origin);
                        if !healthy && origin == LAN && reachable(&client, TAIL) {
                            reconnect(&app, TAIL);
                            tray_text(&app, "C/X · przełączanie na Tailscale");
                        } else if woke && healthy {
                            reconnect(&app, origin);
                        } else if healthy {
                            poll_usage(&app, &client, origin);
                        } else {
                            tray_text(&app, "C/X · offline (brak aktualnych danych)");
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(10));
        ticks += 1;
    }
}

fn main() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        diag::log(&format!("panic: {info}"));
        default_hook(info);
    }));
    // Binary time tells which build runs; a second "start" line followed by "druga instancja"
    // means the old process is still alive in the menu bar and the new build never ran.
    let built = std::env::current_exe()
        .and_then(|p| p.metadata())
        .and_then(|m| m.modified())
        .map(diag::utc)
        .unwrap_or_else(|_| "?".into());
    diag::log(&format!(
        "start: CC Panel {} (pid {}, binarka z {built})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    let dysp = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
    let shell = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Backquote);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            diag::log(&format!(
                "druga instancja: pokazuję okno działającego procesu (pid {}); nowa binarka ruszy po „Zakończ CC Panel”",
                std::process::id()
            ));
            show(app, false)
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if shortcut == &dysp {
                            show(app, false);
                        }
                        if shortcut == &shell {
                            show(app, true);
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // First origin is selected before WebView navigation: failed LAN pages
            // cannot execute the DOM helper used for later reconnects.
            let probe = Client::builder()
                .timeout(Duration::from_secs(4))
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
            let initial = if reachable(&probe, LAN) { LAN } else { TAIL };
            let nav = app.handle().clone();
            let popup = app.handle().clone();
            let window = WebviewWindowBuilder::new(
                app,
                "panel",
                WebviewUrl::External(format!("{initial}/#/mozg").parse()?),
            )
            .title(panel_title(initial.strip_prefix("https://")))
            .inner_size(1200.0, 850.0)
            .min_inner_size(700.0, 500.0)
            .initialization_script(PANEL_SCRIPT)
            // Tauri's drop handler consumes Finder drags (DragDropEvent) and WKWebView never sees
            // HTML5 dragenter/drop. The panel handles drops itself: images attached to the Dispatcher.
            .disable_drag_drop_handler()
            .on_navigation(move |url| {
                // CHAT tiles: claude.ai / chatgpt.com open in their own window, never in the panel.
                if let Some(idx) = chat_index(url) {
                    diag::log(&format!("panel: nawigacja {} odrzucona -> okno czatu", log_url(url)));
                    open_chat(&nav, idx, "panel, nawigacja");
                    return false;
                }
                let ok = allowed(url);
                if !ok {
                    diag::log(&format!("panel: nawigacja {} odrzucona (poza allowlistą)", log_url(url)));
                }
                ok
            })
            .on_new_window(move |url, _| {
                match chat_index(&url) {
                    Some(idx) => {
                        diag::log(&format!("panel: nowe okno {} odrzucone -> okno czatu", log_url(&url)));
                        open_chat(&popup, idx, "panel, nowe okno");
                    }
                    None => diag::log(&format!("panel: nowe okno {} odrzucone", log_url(&url))),
                }
                NewWindowResponse::Deny
            })
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    let _ = window.set_title(&panel_title(payload.url().host_str()));
                    // Refresh usage immediately after login/reload, in the worker.
                    HAS_DOCUMENT.store(true, Ordering::Release);
                    PAGE_LOADED.store(true, Ordering::Release);
                }
            })
            .build()?;
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = close_window.hide();
                }
            });
            let open = MenuItem::with_id(app, "open", "Dyspozytor", true, None::<&str>)?;
            let dock = MenuItem::with_id(app, "shell", "Dok shella", true, None::<&str>)?;
            let claude = MenuItem::with_id(app, "chat-claude", "Claude", true, None::<&str>)?;
            let chatgpt = MenuItem::with_id(app, "chat-chatgpt", "ChatGPT", true, None::<&str>)?;
            let browser = MenuItem::with_id(
                app,
                "chat-browser",
                "Czat w przeglądarce",
                true,
                None::<&str>,
            )?;
            let refresh = MenuItem::with_id(
                app,
                "refresh",
                "Odśwież / połącz ponownie",
                true,
                None::<&str>,
            )?;
            let lan = MenuItem::with_id(app, "lan", "Wróć do LAN", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Autostart",
                true,
                app.autolaunch().is_enabled().unwrap_or(false),
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Zakończ CC Panel", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &dock,
                    &PredefinedMenuItem::separator(app)?,
                    &claude,
                    &chatgpt,
                    &browser,
                    &PredefinedMenuItem::separator(app)?,
                    &refresh,
                    &lan,
                    &autostart,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            // App menu (top bar): the default one (Edit keeps copy/paste in every window) plus
            // "Czat". Same ids as the tray: the tray's menu handler is global and serves both.
            // Cmd+Shift+O is "new chat" on claude.ai and chatgpt.com, hence Cmd+Option+O.
            let in_browser = MenuItem::with_id(
                app,
                "chat-browser",
                "Otwórz w przeglądarce",
                false,
                Some("CmdOrCtrl+Alt+O"),
            )?;
            let chat_menu = Submenu::with_items(
                app,
                "Czat",
                true,
                &[
                    &MenuItem::with_id(app, "chat-claude", "Claude", true, None::<&str>)?,
                    &MenuItem::with_id(app, "chat-chatgpt", "ChatGPT", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &in_browser,
                ],
            )?;
            // Menu "Panel": shortcuts in the menu bar work while xterm or a text field has focus (the menu
            // takes the key before WKWebView) and the menu doubles as the shortcut cheat sheet. Free in the
            // default menu (Cmd+H/Q/W/M/Z/X/C/V/A, Cmd+Ctrl+F), "Czat" (Cmd+Option+O), global Cmd+Shift+Space/`
            // and the page (Cmd+1..9, Cmd+K, Ctrl+`). Menu bar items work app-wide, chat windows included.
            let panel_menu = Submenu::with_items(
                app,
                "Panel",
                true,
                &[
                    &MenuItem::with_id(app, "nav-terminal", "Terminal (dok shella)", true, Some("CmdOrCtrl+T"))?,
                    &MenuItem::with_id(app, "nav-dysp", "Dyspozytor", true, Some("CmdOrCtrl+D"))?,
                    &MenuItem::with_id(app, "nav-sessions", "Sesje", true, Some("CmdOrCtrl+S"))?,
                ],
            )?;
            let app_menu = Menu::default(app.handle())?;
            let before_window = app_menu.items()?.len().saturating_sub(2);
            app_menu.insert(&chat_menu, before_window)?;
            app_menu.insert(&panel_menu, before_window)?;
            app.set_menu(app_menu)?;
            app.manage(ChatBrowserItem(in_browser));
            let toggle = autostart.clone();
            TrayIconBuilder::with_id("usage")
                .icon(tauri::image::Image::new_owned(
                    vec![255; 16 * 16 * 4],
                    16,
                    16,
                ))
                .icon_as_template(true)
                .title("C/X · oczekiwanie")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle(), false);
                    }
                })
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show(app, false),
                    "shell" => show(app, true),
                    "nav-terminal" => go_view(app, "terminal"),
                    "nav-dysp" => go_view(app, "dysp"),
                    "nav-sessions" => go_view(app, "sessions"),
                    "chat-claude" => open_chat(app, 0, "menu"),
                    "chat-chatgpt" => open_chat(app, 1, "menu"),
                    "chat-browser" => chat_in_browser(app),
                    "lan" => reconnect(app, LAN),
                    "refresh" => {
                        if let Some(window) = app.get_webview_window("panel") {
                            if let Ok(url) = window.url() {
                                if allowed(&url) {
                                    reconnect(
                                        app,
                                        if url.host_str() == Some("panel.example.com") {
                                            LAN
                                        } else {
                                            TAIL
                                        },
                                    );
                                }
                            }
                        }
                    }
                    "autostart" => {
                        let manager = app.autolaunch();
                        if let Ok(enabled) = manager.is_enabled() {
                            let result = if enabled {
                                manager.disable()
                            } else {
                                manager.enable()
                            };
                            let _ =
                                toggle.set_checked(if result.is_ok() { !enabled } else { enabled });
                            if result.is_err() {
                                tray_text(app, "Autostart: zmiana nie powiodła się");
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // A conflicting user shortcut must not make the entire panel unusable.
            if app.global_shortcut().register(dysp).is_err() {
                diag::log("skrót Cmd+Shift+Space niedostępny");
                eprintln!("CC Panel: Cmd+Shift+Space niedostępny; użyj menu bar");
            }
            if app.global_shortcut().register(shell).is_err() {
                diag::log("skrót Cmd+Shift+` niedostępny");
                eprintln!("CC Panel: Cmd+Shift+` niedostępny; użyj menu bar");
            }
            wake::install();
            let handle = app.handle().clone();
            std::thread::spawn(move || worker(handle));
            diag::log(&format!("gotowe: panel {initial} (pid {})", std::process::id()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CC Panel could not start")
        .run(|app, event| {
            // Dock click after the red X (window only hidden) must bring the panel back.
            // RunEvent::Reopen exists only on macOS; elsewhere there is no Dock to click.
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("panel") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
