// Diagnostic log: ~/Library/Logs/cc-panel-desktop/desktop.log, UTC timestamps, one previous
// file kept as desktop.log.1. Callers pass URLs only through main.rs `log_url` (no query,
// fragment or userinfo); cookies and tokens never reach this module.
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 256 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Logs/cc-panel-desktop/desktop.log"))
}

pub fn log(msg: &str) {
    let Some(file) = path() else {
        return;
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::metadata(&file).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(&file, file.with_extension("log.1"));
    }
    if let Ok(mut out) = fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(out, "{} {}", utc(SystemTime::now()), msg.replace('\n', " "));
    }
}

// ISO 8601 UTC without a date crate (Howard Hinnant's civil_from_days).
pub fn utc(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}
