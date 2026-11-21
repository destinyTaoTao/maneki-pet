import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "reminder-reschedule", scope: "reminder_reschedule",
  revokePath: "/v1/admin/reminders/reschedule/revoke", label: "改期提醒",
  disclosure: "由本机用户运行。授权后该 agent 可更改同名创建身份尚未开始投递的提醒时间，需要提供该条提醒的 ID 和版本。",
});
