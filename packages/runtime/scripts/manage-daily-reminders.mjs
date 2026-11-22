import { isAbsolute } from "node:path";
import { DesktopCredentialError, openAdminSession } from "../dist/admin-session.js";
import { NAMED_CLIENT_NAME } from "../dist/auth.js";

const usage = "node manage-daily-reminders.mjs <absolute-runtime-dir> <port> <client-name> list|list-weekdays|list-weekly|cancel <series-id> <request-id>|cancel-weekday <series-id> <request-id>|cancel-weekly <series-id> <request-id>\n";
const args = process.argv.slice(2);
const [configDir, port, name, operation, seriesId, requestId] = args;
const routes = {
  list: "list",
  "list-weekdays": "weekdays/list",
  "list-weekly": "weekly/list",
  cancel: "cancel",
  "cancel-weekday": "weekdays/cancel",
  "cancel-weekly": "weekly/cancel",
};
const route = Object.hasOwn(routes, operation) ? routes[operation] : undefined;
const listing = route === "list" || route?.endsWith("/list");
const cancelling = route === "cancel" || route?.endsWith("/cancel");
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(usage);
} else if (!configDir || !isAbsolute(configDir) || !/^[1-9]\d{0,4}$/.test(port ?? "") ||
    Number(port) > 65535 || !NAMED_CLIENT_NAME.test(name ?? "") ||
    !((listing && args.length === 4) || (cancelling && args.length === 6))) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  try {
    const admin = await openAdminSession(configDir, Number(port));
    const result = await admin.request(`/v1/admin/recurring-reminders/${route}`,
      listing ? { name } : { name, seriesId, requestId });
    if (result.status === 200) process.stdout.write(JSON.stringify(result.body) + "\n");
    else {
      process.stderr.write(`管理重复提醒失败 (HTTP ${result.status})\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof DesktopCredentialError ? error.code : "recurring_reminder_access_failed";
    process.stderr.write(`管理重复提醒失败（${code}）\n`);
    process.exitCode = 1;
  }
}
