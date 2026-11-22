import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "reminder-recurring-reschedule", scope: "reminder_recurring_reschedule",
  revokePath: "/v1/admin/recurring-reminders/reschedule/revoke", label: "重复提醒改期",
  disclosure: "由本机用户运行。授权后该 agent 可查看同名身份的每日、工作日和指定星期改期目标，按系列 ID 和版本修改时刻。",
});
