import { isAbsolute, join } from "node:path";
import { clientCredential } from "../dist/desktop-credential.js";
import { DesktopCredentialError } from "../dist/admin-session.js";

// 本机管理员显式运行。stdout 只返回当前客户端的文件路径。
const [configDir, port, name] = process.argv.slice(2);
if (process.argv.length !== 5 || !isAbsolute(configDir ?? "") ||
    !/^[1-9]\d{0,4}$/.test(port ?? "") || Number(port) > 65535 ||
    !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name ?? "")) {
  process.stderr.write("usage: node pair-expression-client.mjs <absolute-runtime-dir> <port> <client-name>\n");
  process.exitCode = 2;
} else {
  const fileId = `expression-client-${name}`;
  try {
    await clientCredential(configDir, Number(port), fileId, name, "express", true);
    process.stdout.write(`${join(configDir, fileId + ".json")}\n`);
  } catch (error) {
    const code = error instanceof DesktopCredentialError ? error.code : "pairing_failed";
    process.stderr.write(`表达客户端配对失败（${code}）\n`);
    process.exitCode = 1;
  }
}
