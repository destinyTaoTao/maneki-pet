import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "reminder", scope: "reminder_create", revokePath: "/v1/admin/reminders/revoke", label: "创建提醒",
  disclosure: "由本机用户运行。授权后指定 agent 可以安排多条一次性本机提醒。提醒文字会显示在你的通知中；撤销后已安排的提醒仍会到点投递。",
});
