use std::sync::atomic::{AtomicBool, Ordering};

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows_core::Interface;

static FOCUS_WARNING: AtomicBool = AtomicBool::new(false);
static DISPATCH_WARNING: AtomicBool = AtomicBool::new(false);
static COM_WARNING: AtomicBool = AtomicBool::new(false);

fn warn_once(warned: &AtomicBool, stage: &str, error: impl std::fmt::Display) {
    if !warned.swap(true, Ordering::Relaxed) {
        eprintln!("WebView memory target {stage} failed: {error}");
    }
}

pub fn sync_focus(window: &WebviewWindow) {
    let focused = window.is_focused().unwrap_or_else(|error| {
        warn_once(&FOCUS_WARNING, "focus query", error);
        // 无法取得焦点时保留正常模式，不推断窗口处于后台。
        true
    });
    request_for_focus(window, focused);
}

pub fn request_for_focus(window: &WebviewWindow, focused: bool) {
    let dispatched = window.with_webview(move |platform| {
        // 仅在平台闭包中使用 COM 句柄；Low 不挂起脚本或可见动画。
        let applied: windows_core::Result<()> = (|| unsafe {
            let core = platform.controller().CoreWebView2()?;
            let core19 = core.cast::<ICoreWebView2_19>()?;
            let target = if focused {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            };
            core19.SetMemoryUsageTargetLevel(target)
        })();
        if let Err(error) = applied {
            warn_once(&COM_WARNING, "COM setter", error);
        }
    });
    // 分派成功不代表 COM setter 成功，更不代表私有内存已经下降。
    if let Err(error) = dispatched {
        warn_once(&DISPATCH_WARNING, "dispatch", error);
    }
}
