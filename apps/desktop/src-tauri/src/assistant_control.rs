use std::path::PathBuf;
use std::process::{Command, Stdio};

pub(crate) fn config_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("com.manekipet.desktop").join("runtime"))
            .ok_or("invalid_config".into());
    }
    #[cfg(not(windows))]
    {
        Err("unsupported_platform".into())
    }
}

fn executable() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|_| "not_installed".into())
}

fn helper(action: &str, client: &str) -> Result<serde_json::Value, String> {
    let exe = executable()?;
    let directory = exe.parent().ok_or("not_installed")?;
    let sidecar = directory.join("maneki-runtime.exe");
    let bundle = directory.join("resources/maneki-runtime-bundle.js");
    if !sidecar.is_file() || !bundle.is_file() {
        return Err("not_installed".into());
    }
    let mut command = Command::new(sidecar);
    command
        .arg(bundle)
        .arg("--config-dir")
        .arg(config_dir()?)
        .arg("--port")
        .arg(super::RUNTIME_PORT.to_string())
        .arg("--assistant-manager")
        .arg(action)
        .arg("--client")
        .arg(client)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(super::CREATE_NO_WINDOW);
    }
    let output = command.output().map_err(|_| "runtime_unavailable")?;
    if output.stdout.len() > 16_384 {
        return Err("protocol_mismatch".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "protocol_mismatch")?;
    if !output.status.success() {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("invalid_config")
            .to_string());
    }
    Ok(value)
}

pub fn register_installation() -> Result<(), String> {
    let exe = executable()?;
    let directory = exe.parent().ok_or("not_installed")?;
    if !directory.join("maneki-runtime.exe").is_file()
        || !directory
            .join("resources/maneki-runtime-bundle.js")
            .is_file()
    {
        return Err("not_installed".into());
    }
    let parent = config_dir()?
        .parent()
        .ok_or("invalid_config")?
        .to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|_| "invalid_config")?;
    let pending = parent.join(format!("installation.{}.pending", std::process::id()));
    let data = serde_json::json!({"schemaVersion": 1, "protocolVersion": 1, "executable": exe});
    std::fs::write(&pending, data.to_string()).map_err(|_| "invalid_config")?;
    let result = std::fs::rename(&pending, parent.join("installation.json"))
        .map_err(|_| "invalid_config".to_string());
    let _ = std::fs::remove_file(pending);
    result
}

fn launch_view(close: bool) -> Result<(), String> {
    let mut command = Command::new(executable()?);
    command
        .arg(if close { "--close-view" } else { "--show" })
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(super::CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|_| "runtime_unavailable")?;
    Ok(())
}

#[cfg(windows)]
fn message(text: &str, confirm: bool) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "小招 · Maneki".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            if confirm { 0x0000_0124 } else { 0 },
        ) == 6
    }
}

#[cfg(not(windows))]
fn message(_text: &str, _confirm: bool) -> bool {
    false
}

fn confirm_exit() -> bool {
    message(super::ui_text::QUIT_CONFIRM, true)
}

fn authorized_action(
    action: &str,
    client: &str,
    confirm: impl FnOnce(&str) -> bool,
    manage: impl FnOnce() -> Result<serde_json::Value, String>,
) -> Result<serde_json::Value, String> {
    let prompt = match action {
        "pair" => Some(super::ui_text::pair_confirm(client)),
        "quit" => Some(super::ui_text::QUIT_CONFIRM.to_string()),
        _ => None,
    };
    if prompt.is_some_and(|text| !confirm(&text)) {
        return Err("user_denied".into());
    }
    manage()
}

pub fn quit_from_tray(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if !confirm_exit() {
            return;
        }
        match helper("quit", "desktop") {
            Ok(_) => app.exit(0),
            Err(code) => {
                message(super::ui_text::runtime_error(&code), false);
            }
        }
    });
}

/// 原生管理在创建 WebView 前执行，插件只获得独立 express 凭证。
pub fn dispatch_cli() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--assistant") {
        return false;
    }
    let result = (|| -> Result<serde_json::Value, String> {
        let action = args.get(1).ok_or("invalid_config")?.as_str();
        let client = if args.len() == 4 && args[2] == "--client" {
            args[3].as_str()
        } else if args.len() == 2 {
            "web"
        } else {
            return Err("invalid_config".into());
        };
        if client.is_empty()
            || client.len() > 64
            || !client
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err("invalid_config".into());
        }
        if action == "register" {
            register_installation()?;
            return Ok(serde_json::json!({"registered": true}));
        }
        if !["connect", "pair", "status", "show", "quit"].contains(&action) {
            return Err("invalid_config".into());
        }
        let result = authorized_action(
            action,
            client,
            |text| message(text, true),
            || helper(action, client),
        )?;
        if action == "show" {
            launch_view(false)?;
        }
        if action == "quit" {
            launch_view(true)?;
        }
        Ok(result)
    })();
    let (value, code) = match result {
        Ok(value) => (value, 0),
        Err(error) => (serde_json::json!({"error": error}), 1),
    };
    println!("{}", value);
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejecting_pair_or_quit_never_reaches_privileged_helper() {
        for action in ["pair", "quit"] {
            let result = authorized_action(
                action,
                "web",
                |_| false,
                || panic!("denied action reached helper"),
            );
            assert_eq!(result.unwrap_err(), "user_denied");
        }
    }

    #[test]
    fn approval_is_required_once_and_helper_failure_is_preserved() {
        let result = authorized_action(
            "pair",
            "work",
            |text| {
                assert!(text.contains("work"));
                assert!(text.contains("仅授予状态表达权限"));
                true
            },
            || Err("identity_mismatch".into()),
        );
        assert_eq!(result.unwrap_err(), "identity_mismatch");
        let result = authorized_action(
            "status",
            "work",
            |_| panic!("status asked for new privileges"),
            || Ok(serde_json::json!({"state":"stopped"})),
        );
        assert_eq!(result.unwrap()["state"], "stopped");
    }
}
