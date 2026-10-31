mod ui_text;

use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

#[derive(Default)]
struct NativeSettings {
    do_not_disturb: bool,
    click_through: bool,
    always_on_top: bool,
}

struct SharedSettings(Mutex<NativeSettings>);

// MutexGuard 不能跨过 State 临时值返回，改为在闭包作用域内完成读写。
fn with_settings<R>(app: &AppHandle, apply: impl FnOnce(&mut NativeSettings) -> R) -> R {
    let state = app.state::<SharedSettings>();
    let mut guard = state.0.lock().expect("native settings mutex poisoned");
    apply(&mut guard)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SharedSettings(Mutex::new(NativeSettings {
            always_on_top: true,
            ..NativeSettings::default()
        })))
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running Maneki");
}
