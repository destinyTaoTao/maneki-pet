use std::process::{Command, Stdio};
use tauri::AppHandle;

/// 固定管理模式只输出客户端凭证；root 不越过 native 边界。
#[tauri::command]
pub async fn desktop_client_token(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe_dir = std::env::current_exe()
            .map_err(|_| "app location unavailable")?
            .parent()
            .ok_or("app directory unavailable")?
            .to_path_buf();
        let mut cmd = Command::new(exe_dir.join("maneki-runtime.exe"));
        cmd.arg(exe_dir.join("resources").join("maneki-runtime-bundle.js"))
            .arg("--config-dir")
            .arg(super::runtime_config_dir(&app)?)
            .arg("--port")
            .arg(super::RUNTIME_PORT.to_string())
            .arg("--desktop-credential")
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(super::CREATE_NO_WINDOW);
        }
        let output = cmd
            .output()
            .map_err(|_| "desktop pairing helper unavailable")?;
        if !output.status.success() {
            return Err(
                "desktop credential revoked, unavailable or runtime incompatible".to_string(),
            );
        }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "invalid desktop credential response")?;
        value
            .get("token")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "desktop client token missing".to_string())
    })
    .await
    .map_err(|_| "desktop pairing helper failed".to_string())?
}
