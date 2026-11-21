import { manageNamedClient } from "./named-client-access.mjs";

await manageNamedClient({
  capability: "reminder-read", scope: "reminder_read", revokePath: "/v1/admin/reminders/read/revoke", label: "查询提醒",
  disclosure: "由本机用户运行。授权后该 agent 可读取同名创建身份的待投递提醒正文、时间和版本。它可能将这些内容交给自己的模型。",
});
