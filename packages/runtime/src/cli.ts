/**
 * 已安装固定入口启动器（M2）：不打开桌宠窗口即可启动共享 Runtime。
 * stdout 仅协议消息（供 MCP stdio 桥），运行日志一律走 stderr。
 */
import { startRuntime } from "./runtime.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configDir = argValue("--config-dir");
if (!configDir) {
  process.stderr.write("usage: node cli.js --config-dir <dir> [--port <n>]\n");
  process.exit(2);
}

const portArg = argValue("--port");
const originArg = argValue("--origin-allowlist");
const management = argValue("--assistant-manager");
if (management) {
  try {
    const { manageAssistant, assistantActions } = await import("./assistant-manager.js");
    const action = assistantActions.find((item) => item === management);
    if (!action) throw new Error("invalid action");
    process.stdout.write(JSON.stringify(await manageAssistant(configDir, Number(portArg), process.argv[1]!, action, argValue("--client") ?? "web")));
  } catch (error) {
    const { DesktopCredentialError } = await import("./admin-session.js");
    process.stdout.write(JSON.stringify({ error: error instanceof DesktopCredentialError ? error.code : "invalid_config" }));
    process.exitCode = 1;
  }
} else if (process.argv.includes("--desktop-credential")) {
  try {
    const { desktopCredential } = await import("./desktop-credential.js");
    process.stdout.write(JSON.stringify(await desktopCredential(configDir, Number(portArg))));
  } catch (error) {
    // 管理凭证、响应正文与文件内容不能出现在错误日志中。
    const { DesktopCredentialError } = await import("./desktop-credential.js");
    process.stdout.write(JSON.stringify({ error: error instanceof DesktopCredentialError ? error.code : "invalid_config" }));
    process.exitCode = 1;
  }
} else {
  const log = (line: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  };

  const runtime = await startRuntime({
    configDir,
    port: portArg ? Number(portArg) : 0,
    originAllowlist: originArg ? originArg.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0) : [],
    log,
  });

  if (!process.argv.includes("--background")) await runtime.startMcpStdioBridge();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`received ${signal}, stopping`);
    void runtime.stop().then(() => process.exit(0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  setInterval(() => undefined, 60_000).unref();

}
