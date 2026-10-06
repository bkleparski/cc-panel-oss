// NSWorkspace notifications are delivered on the AppKit main thread. The callback
// only sets a flag; HTTP and cookie access run on the worker thread.
use std::sync::atomic::AtomicBool;
pub static WOKE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
pub fn install() {
    use objc::declare::ClassDecl;
    use objc::runtime::{Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::atomic::Ordering;

    extern "C" fn did_wake(_: &Object, _: Sel, _: *mut Object) {
        WOKE.store(true, Ordering::Release);
    }
    // AppKit is initialized by Tauri. The observer is retained for the lifetime
    // of this process, so notification delivery cannot reference a freed object.
    unsafe {
        let mut declaration = ClassDecl::new("CCPanelWakeObserver", class!(NSObject))
            .expect("unique wake observer class");
        declaration.add_method(
            sel!(didWake:),
            did_wake as extern "C" fn(&Object, Sel, *mut Object),
        );
        let observer: *mut Object = msg_send![declaration.register(), new];
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let center: *mut Object = msg_send![workspace, notificationCenter];
        let name: *mut Object = msg_send![class!(NSString), stringWithUTF8String: c"NSWorkspaceDidWakeNotification".as_ptr()];
        let _: () = msg_send![center, addObserver: observer selector: sel!(didWake:) name: name object: std::ptr::null_mut::<Object>()];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install() {}
