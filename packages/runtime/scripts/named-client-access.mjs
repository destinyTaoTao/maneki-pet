import { isAbsolute, join } from "node:path";
import { DesktopCredentialError, openAdminSession } from "../dist/admin-session.js";
import { NAMED_CLIENT_NAME } from "../dist/auth.js";
import { clientCredential } from "../dist/desktop-credential.js";

/** 受信本机入口；每个调用脚本固定自己的能力、凭证文件前缀和管理路径。 */
export async function manageNamedClient({ capability, scope, revokePath, label, disclosure }) {
  const flag = scope.replaceAll("_", "-");
  const allowFlag = "--allow-" + flag;
  const revokeFlag = "--revoke-" + flag;
  const signature = `node pair-${capability}-client.mjs <absolute-runtime-dir> <port> <client-name>`;
  const usage = [disclosure, signature + " " + allowFlag, signature + " " + revokeFlag].join("\n") + "\n";
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(usage);
    return;
  }
  const [configDir, port, name, action] = args;
  if (args.length !== 4 || !isAbsolute(configDir) || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 ||
      !NAMED_CLIENT_NAME.test(name) || ![allowFlag, revokeFlag].includes(action)) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    if (action === allowFlag) {
      const fileId = `${capability}-client-${name}`;
      await clientCredential(configDir, Number(port), fileId, name, scope, true);
      process.stdout.write(join(configDir, fileId + ".json") + "\n");
    } else {
      const admin = await openAdminSession(configDir, Number(port));
      const reply = await admin.request(revokePath, { name });
      if (reply.status !== 200 || typeof reply.body.revoked !== "string" || !/^client-[0-9a-f]{12}$/.test(reply.body.revoked)) throw new Error();
      process.stdout.write(`已撤销 ${name} 的${label}权限。\n`);
    }
  } catch (error) {
    const code = error instanceof DesktopCredentialError ? error.code : capability + "_access_failed";
    process.stderr.write(`${label}授权操作失败（${code}）\n`);
    process.exitCode = 1;
  }
}
