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
const log = (line: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

const runtime = await startRuntime({
  configDir,
  port: portArg ? Number(portArg) : 0,
  originAllowlist: originArg ? originArg.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0) : [],
  log,
});

await runtime.startMcpStdioBridge();

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
