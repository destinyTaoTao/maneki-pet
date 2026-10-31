mod ui_text;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

/// 共享 Runtime 固定端口：Shell 健康发现与 sidecar 启动共用。
const RUNTIME_PORT: u16 = 18100;
/// Windows：隐藏 sidecar 控制台窗口。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct NativeSettings {
    do_not_disturb: bool,
    click_through: bool,
    always_on_top: bool,
}

struct SharedSettings(Mutex<NativeSettings>);
/// 持有 sidecar 子进程：stdin 管道保持打开（MCP 桥等待客户端），
/// Shell 退出时不杀 Runtime（关闭窗口只断开客户端，后台继续跟踪）。
struct RuntimeChild(Mutex<Option<Child>>);
struct TrayDndItem(Mutex<Option<CheckMenuItem<tauri::Wry>>>);

// MutexGuard 不能跨过 State 临时值返回，改为在闭包作用域内完成读写。
fn with_settings<R>(app: &AppHandle, apply: impl FnOnce(&mut NativeSettings) -> R) -> R {
    let state = app.state::<SharedSettings>();
    let mut guard = state.0.lock().expect("native settings mutex poisoned");
    apply(&mut guard)
}

fn runtime_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 拉起共享 Runtime sidecar（不依赖系统 Node：二进制即运行时本身）。
/// 单实例由 Runtime 自身的实例锁与固定端口保证；重复拉起会立即退出。
fn spawn_runtime_child(app: &AppHandle) -> Result<(), String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or_else(|| "app exe has no parent dir".to_string())?
        .to_path_buf();
    let sidecar = exe_dir.join("maneki-runtime.exe");
    let bundle = exe_dir.join("resources").join("maneki-runtime-bundle.js");
    if !sidecar.exists() {
        return Err(format!("runtime sidecar missing: {}", sidecar.display()));
    }
    if !bundle.exists() {
        return Err(format!("runtime bundle missing: {}", bundle.display()));
    }
    let config_dir = runtime_config_dir(app)?;
    let mut cmd = Command::new(&sidecar);
    cmd.arg(&bundle)
        .arg("--config-dir")
        .arg(&config_dir)
        .arg("--port")
        .arg(RUNTIME_PORT.to_string())
        .arg("--origin-allowlist")
        .arg("http://tauri.localhost")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("spawn runtime failed: {e}"))?;
    let runtime_state = app.state::<RuntimeChild>();
    let mut state = runtime_state.0.lock().expect("runtime child mutex poisoned");
    if let Some(existing) = state.as_mut() {
        // 理论上不发生（锁保证单实例）；释放旧 stdin 管道防句柄泄漏。
        let _ = existing.stdin.take();
    }
    *state = Some(child);
    Ok(())
}

#[derive(serde::Serialize)]
struct RuntimeInfo {
    port: u16,
    config_dir: String,
}

#[tauri::command]
fn runtime_info(app: AppHandle) -> Result<RuntimeInfo, String> {
    Ok(RuntimeInfo {
        port: RUNTIME_PORT,
        config_dir: runtime_config_dir(&app)?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn read_root_token(app: AppHandle) -> Result<String, String> {
    let path = runtime_config_dir(&app)?.join("root-token");
    std::fs::read_to_string(&path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("root token unreadable: {e}"))
}

#[tauri::command]
fn spawn_runtime(app: AppHandle) -> Result<(), String> {
    spawn_runtime_child(&app)
}

/// 运行时勿扰状态同步回托盘勾选（Shell 连接后对齐）。
#[tauri::command]
fn sync_tray_dnd(app: AppHandle, enabled: bool) -> Result<(), String> {
    let item = app
        .state::<TrayDndItem>()
        .0
        .lock()
        .expect("tray dnd mutex poisoned")
        .clone();
    if let Some(item) = item {
        item.set_checked(enabled).map_err(|e| e.to_string())?;
    }
    with_settings(&app, |settings| settings.do_not_disturb = enabled);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SharedSettings(Mutex::new(NativeSettings {
            always_on_top: true,
            ..NativeSettings::default()
        })))
        .manage(RuntimeChild(Mutex::new(None)))
        .manage(TrayDndItem(Mutex::new(None)))
        .setup(|app| {
            let _ = spawn_runtime_child(app.handle());
            let show = MenuItem::with_id(app, "show", ui_text::SHOW, true, None::<&str>)?;
            let dnd = CheckMenuItem::with_id(
                app,
                "dnd",
                ui_text::DO_NOT_DISTURB,
                true,
                false,
                None::<&str>,
            )?;
            let always_on_top = CheckMenuItem::with_id(
                app,
                "always_on_top",
                ui_text::ALWAYS_ON_TOP,
                true,
                true,
                None::<&str>,
            )?;
            let click_through = CheckMenuItem::with_id(
                app,
                "click_through",
                ui_text::CLICK_THROUGH,
                true,
                false,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", ui_text::QUIT, true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&show, &dnd, &always_on_top, &click_through, &quit])?;
            let dnd_for_event = dnd.clone();
            let always_on_top_for_event = always_on_top.clone();
            let click_through_for_event = click_through.clone();
            app.manage(TrayDndItem(Mutex::new(Some(dnd.clone()))));
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .expect("window icon missing")
                        .clone(),
                )
                .tooltip(ui_text::TOOLTIP)
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "dnd" => {
                        let enabled = with_settings(app, |settings| {
                            settings.do_not_disturb = !settings.do_not_disturb;
                            settings.do_not_disturb
                        });
                        let _ = dnd_for_event.set_checked(enabled);
                        // 托盘为用户开关的事实来源；Runtime 侧由 Shell 订阅后转写。
                        let _ = app.emit("maneki://dnd-changed", enabled);
                    }
                    "always_on_top" => {
                        let enabled = with_settings(app, |settings| {
                            settings.always_on_top = !settings.always_on_top;
                            settings.always_on_top
                        });
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_always_on_top(enabled);
                        }
                        let _ = always_on_top_for_event.set_checked(enabled);
                    }
                    "click_through" => {
                        let enabled = with_settings(app, |settings| {
                            settings.click_through = !settings.click_through;
                            settings.click_through
                        });
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_ignore_cursor_events(enabled);
                        }
                        let _ = click_through_for_event.set_checked(enabled);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            read_root_token,
            spawn_runtime,
            sync_tray_dnd
        ])
        .run(tauri::generate_context!())
        .expect("error while running Maneki");
}
