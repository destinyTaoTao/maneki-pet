import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "briefing", scope: "briefing_read", revokePath: "/v1/admin/briefing/revoke", label: "开工简报",
  disclosure: "由本机用户运行。简报会向指定 agent 提供跨项目的到期待办标题、日期和 dsh 等待会话标识；该 agent 可能将这些数据交给自己的模型。",
});
