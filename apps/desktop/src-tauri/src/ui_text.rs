pub const SHOW: &str = "显示小招";
pub const ASSISTANT: &str = "文字助手与待办提醒";
pub const DO_NOT_DISTURB: &str = "勿扰";
pub const ALWAYS_ON_TOP: &str = "保持置顶";
pub const CLICK_THROUGH: &str = "鼠标穿透（在此恢复）";
pub const CLOSE_VIEW: &str = "关闭桌宠（后台继续）";
pub const QUIT: &str = "退出助理";
pub const QUIT_CONFIRM: &str =
    "退出助理将停止后台服务及任务跟踪。外部 dsh 任务可能继续运行，不会被自动取消。\n确定退出吗？";
pub fn pair_confirm(client: &str) -> String {
    format!("允许 dsh 配置 {} 连接小招并驱动宠物状态吗？\n仅授予状态表达权限，不包含工程派发、设置或退出权限。", client)
}
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
