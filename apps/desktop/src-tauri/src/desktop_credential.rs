use std::process::{Command, Stdio};
use tauri::AppHandle;

/// 固定管理模式只输出客户端凭证；root 不越过 native 边界。
#[tauri::command]
pub async fn desktop_client_token(app: AppHandle) -> Result<String, String> {
    client_token(app, "--desktop-credential").await
}

#[tauri::command]
pub async fn assistant_client_token(app: AppHandle, create: bool) -> Result<String, String> {
    client_token(
        app,
        if create {
            "--assistant-credential"
        } else {
            "--assistant-credential-existing"
        },
    )
    .await
}

async fn client_token(app: AppHandle, mode: &'static str) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe_dir = std::env::current_exe()
            .map_err(|_| "app location unavailable")?
            .parent()
            .ok_or("app directory unavailable")?
            .to_path_buf();
        let sidecar = exe_dir.join("maneki-runtime.exe");
        let bundle = exe_dir.join("resources").join("maneki-runtime-bundle.js");
        if !sidecar.is_file() || !bundle.is_file() {
            return Err(super::ui_text::runtime_error("not_installed").to_string());
        }
        let mut cmd = Command::new(sidecar);
        cmd.arg(bundle)
            .arg("--config-dir")
            .arg(super::runtime_config_dir(&app)?)
            .arg("--port")
            .arg(super::RUNTIME_PORT.to_string())
            .arg(mode)
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(super::CREATE_NO_WINDOW);
        }
        let output = cmd
            .output()
            .map_err(|_| super::ui_text::runtime_error("runtime_unavailable"))?;
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| super::ui_text::runtime_error("invalid_config"))?;
        if !output.status.success() {
            if mode != "--desktop-credential" {
                let code = match value.get("error").and_then(|v| v.as_str()) {
                    Some("credential_rejected") => "credential_rejected",
                    Some("pairing_busy") => "pairing_busy",
                    Some("identity_mismatch") => "identity_mismatch",
                    Some("runtime_unavailable") => "runtime_unavailable",
                    Some("protocol_mismatch") => "protocol_mismatch",
                    Some("pairing_required") => "pairing_required",
                    _ => "invalid_config",
                };
                return Err(format!("assistant_credential_{code}"));
            }
            return Err(super::ui_text::runtime_error(
                value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("invalid_config"),
            )
            .to_string());
        }
        value
            .get("token")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "desktop client token missing".to_string())
    })
    .await
    .map_err(|_| "desktop pairing helper failed".to_string())?
}
