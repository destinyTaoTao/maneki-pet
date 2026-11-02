/** #58：只报告离线证据边界，不接受凭证或启用发布。 */
export function douyinReadiness() {
  return {
    platform: "douyin",
    mode: "offline",
    documentationCheckedOn: "2026-11-02",
    status: "restricted",
    publishingEnabled: false,
    liveChecksPerformed: false,
    evidenceFile: "docs/audits/2026-11-02-douyin-publishing-readiness.md",
    checks: [
      { id: "official_documentation", status: "available", detail: "存在官方发布资料，文档存在不表示应用或账号已获准发布。" },
      { id: "subject_eligibility", status: "unknown", detail: "需在平台核实开发者主体及目标应用类型的资格。" },
      { id: "application_permission", status: "unknown", detail: "未核实目标应用的发布权限申请及审批结果。" },
      { id: "account_authorization", status: "unknown", detail: "未核实目标账号的有效 OAuth 授权及授权范围。" },
      { id: "state_reconciliation", status: "restricted", detail: "发布后审核与可见状态的查询证据不足，需补充协议验证。" },
      { id: "publication_verified", status: "unknown", detail: "未试发；本入口不登录、不调用发布接口。" },
    ],
    nextSteps: [
      "准备选题、脚本、视频、封面与文案，当前由用户在平台官方入口人工发布。",
      "核对开发者主体、应用类型、权限审批及目标账号 OAuth 授权。",
      "另行完成最终作品、账号和发布范围绑定的逐次确认契约。",
      "明确作品标识和状态核查；提交结果未知时先对账，不自动重试发布。",
    ],
  };
}
