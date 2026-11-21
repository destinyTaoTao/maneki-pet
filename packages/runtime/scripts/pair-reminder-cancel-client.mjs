import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "reminder-cancel", scope: "reminder_cancel", revokePath: "/v1/admin/reminders/cancel/revoke", label: "取消提醒",
  disclosure: "由本机用户运行。授权后该 agent 可取消同名创建身份的待投递提醒，需要提供该条提醒的 ID 和版本。",
});
