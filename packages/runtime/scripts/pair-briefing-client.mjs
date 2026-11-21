import { isAbsolute, join } from "node:path";
import { DesktopCredentialError, openAdminSession } from "../dist/admin-session.js";
import { clientCredential } from "../dist/desktop-credential.js";
import { BRIEFING_CLIENT_NAME } from "../dist/auth.js";

const usage = [
  "由本机用户运行。简报会向指定 agent 提供跨项目的到期待办标题、日期和 dsh 等待会话标识；该 agent 可能将这些数据交给自己的模型。",
  "node pair-briefing-client.mjs <absolute-runtime-dir> <port> <client-name> --allow-briefing-read",
  "node pair-briefing-client.mjs <absolute-runtime-dir> <port> <client-name> --revoke-briefing-read",
].join("\n");

const [configDir, port, name, action] = process.argv.slice(2);
if (configDir === "--help" && process.argv.length === 3) {
  process.stdout.write(usage + "\n");
} else if (process.argv.length !== 6 || !isAbsolute(configDir ?? "") ||
    !/^[1-9]\d{0,4}$/.test(port ?? "") || Number(port) > 65535 ||
    !BRIEFING_CLIENT_NAME.test(name ?? "") ||
    !["--allow-briefing-read", "--revoke-briefing-read"].includes(action)) {
  process.stderr.write(usage + "\n");
  process.exitCode = 2;
} else {
  const fileId = `briefing-client-${name}`;
  const allow = action === "--allow-briefing-read";
  try {
    if (allow) {
      await clientCredential(configDir, Number(port), fileId, name, "briefing_read", true);
      process.stdout.write(join(configDir, fileId + ".json") + "\n");
    } else {
      const admin = await openAdminSession(configDir, Number(port));
      const reply = await admin.request("/v1/admin/briefing/revoke", { name });
      if (reply.status !== 200 || typeof reply.body.revoked !== "string" || !/^client-[0-9a-f]{12}$/.test(reply.body.revoked)) throw new Error();
      process.stdout.write(`已撤销 ${name} 的开工简报权限。\n`);
    }
  } catch (error) {
    const code = error instanceof DesktopCredentialError ? error.code : "briefing_access_failed";
    process.stderr.write(`简报授权操作失败（${code}）\n`);
    process.exitCode = 1;
  }
}
