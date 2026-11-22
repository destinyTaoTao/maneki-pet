import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "reminder-recurring", scope: "reminder_recurring",
  revokePath: "/v1/admin/recurring-reminders/revoke", label: "重复提醒",
  disclosure: "由本机用户运行。授权后该 agent 可创建、查询和取消自己安排的每日、工作日和指定星期提醒。撤销权限后已安排的规则仍继续调度。",
});
