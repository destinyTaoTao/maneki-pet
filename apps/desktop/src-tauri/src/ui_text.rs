pub const SHOW: &str = "显示小招";
pub const DO_NOT_DISTURB: &str = "勿扰";
pub const ALWAYS_ON_TOP: &str = "保持置顶";
pub const CLICK_THROUGH: &str = "鼠标穿透（在此恢复）";
pub const QUIT: &str = "退出小招";
pub const TOOLTIP: &str = "小招 · Maneki";

pub fn runtime_error(code: &str) -> &'static str {
    match code {
        "not_installed" => "Runtime 安装文件缺失，请重新安装小招",
        "timeout" => "Runtime 连接超时，请检查后台进程",
        "runtime_unavailable" => "Runtime 未就绪，请从受信入口启动后重试",
        "protocol_mismatch" => "Runtime 协议版本不兼容，请更新安装",
        "identity_mismatch" => "端口上的服务身份不符，已停止配对，请检查端口占用",
        "credential_rejected" => "桌面凭证已失效或撤销，请从受信管理入口重新配对",
        "pairing_busy" => "另一配对操作正在进行，请稍后重试",
        "pairing_failed" => "Runtime 拒绝配对，请检查管理凭证",
        _ => "Runtime 配置或客户端凭证无效，请从受信管理入口检查",
    }
}
