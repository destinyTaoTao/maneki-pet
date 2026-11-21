import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { on, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientCredential } from "../packages/runtime/dist/desktop-credential.js";
import { startRuntime } from "../packages/runtime/dist/runtime.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const suggested = join(process.env.APPDATA ?? "", "npm/node_modules/@deepseek-ai/dsh/lib/bin.js");
const dshCli = resolve(process.argv[2] ?? suggested);
assert.ok(process.argv.length <= 3 && existsSync(dshCli),
  "用法：node scripts/acceptance-dsh-briefing.mjs [已安装的 dsh/lib/bin.js 路径]");

function fixtureEnvironment(lab) {
  const env = {};
  for (const key of ["SystemRoot", "COMSPEC", "PATH", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, directory] of Object.entries({
    APPDATA: "appdata", LOCALAPPDATA: "localappdata", DSH_HOME: "dsh-home",
    USERPROFILE: "user", HOME: "user", TEMP: "tmp", TMP: "tmp",
  })) {
    env[key] = join(lab, directory);
    mkdirSync(env[key], { recursive: true });
  }
  env.DSH_TELEMETRY_DISABLED = "1";
  return env;
}

function writeProfile(dshHome, url, observerTokenFile) {
  const profile = join(dshHome, "profiles", "acceptance");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-acceptance", private: true, version: "1.0.0", dsh: { profile: { bundles: [] } },
  }));
  // 加载原生 Agent、问答与工具执行器，不加载模型提供方或其它联网插件。
  const plugins = [
    "session", "typert-registry", "commands", "system-prompt", "tools", "tool-executor-native",
    "session-projection", "agent", "llm", "agent-loop", "user-questions", "tool-ask-user",
  ].map(id => ({ id, name: "@deepseek-ai/dsh-" + id }));
  plugins.push({
    id: "maneki-observer", name: join(repo, "apps/dsh-plugin/dist/index.js"),
    config: { baseUrl: url, tokenFile: observerTokenFile, profileId: "acceptance", showOnConnect: false },
  }, { id: "probe", name: join(repo, "scripts/fixtures/dsh-briefing-probe.mjs") });
  writeFileSync(join(profile, "cordis.patch.yml"), JSON.stringify([{ insert: plugins }]));
}

async function exerciseHost(cwd, env, revoke, signal) {
  const child = fork(dshCli, ["--profile", "acceptance", "--patch",
    join(repo, "apps/dsh-plugin/briefing.patch.example.yml")], {
    cwd, env, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const closed = once(child, "close");
  let result;
  let revoked = false;
  try {
    for await (const [message] of on(child, "message", { close: ["close"], signal })) {
      if (message.type === "revoke") {
        assert.equal(revoked, false);
        await revoke();
        revoked = true;
        child.send("revoked");
      } else if (message.type === "passed") {
        result = message.result;
      } else {
        throw new Error(message.error ?? "未知的验收消息");
      }
    }
    assert.equal((await closed)[0], 0, "dsh 未正常退出");
    assert.ok(revoked && result, "dsh 未完成简报调用和撤销检查");
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send("stop", () => {});
      await Promise.race([closed, delay(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  }
}

const tempParent = realpathSync(tmpdir());
const prefix = "maneki-briefing-acceptance-";
const lab = mkdtempSync(join(tempParent, prefix));
const cancel = new AbortController();
const stop = () => cancel.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let runtime;
let summary;
try {
  const env = fixtureEnvironment(lab);
  const cwd = join(lab, "fixture-project");
  mkdirSync(cwd);
  const configDir = join(lab, "runtime");
  const runNode = (...args) => exec(process.execPath, args, {
    cwd, env, windowsHide: true, timeout: 10000, signal: cancel.signal,
  });
  const version = (await runNode(dshCli, "--version")).stdout.trim();
  runtime = await startRuntime({ configDir, port: 0 });
  const url = "http://127.0.0.1:" + runtime.port;
  runtime.assistant.mutation("fixture", { requestId: "fixture-due", action: "todo.create",
    title: "Fixture due item", notes: "excluded fixture notes", dueDate: "2024-01-03" });
  runtime.assistant.mutation("fixture", { requestId: "fixture-future", action: "todo.create",
    title: "Fixture future", dueDate: "2099-01-03" });

  const observer = await clientCredential(configDir, runtime.port, "fixture-observer", "fixture-observer", "express", true);
  const observerTokenFile = join(lab, "observer.token");
  writeFileSync(observerTokenFile, observer.token, { mode: 0o600 });
  writeProfile(env.DSH_HOME, url, observerTokenFile);

  const pair = action => runNode(join(repo, "packages/runtime/scripts/pair-briefing-client.mjs"),
    configDir, String(runtime.port), "dsh-fixture", action);
  env.MANEKI_BRIEFING_URL = url;
  env.MANEKI_BRIEFING_BRIDGE = join(repo, "packages/cli/dist/briefing-mcp.js");
  env.MANEKI_BRIEFING_TOKEN_FILE = (await pair("--allow-briefing-read")).stdout.trim();

  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(30000)]);
  const result = await exerciseHost(cwd, env, () => pair("--revoke-briefing-read"), signal);
  assert.equal(result.waiting[0].clientId, observer.clientId);
  const sources = runtime.assistant.snapshot().observations;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].connected, false);
  assert.ok(Date.now() - sources[0].lastSeenAt < 10000, "应由插件显式上报离线");
  summary = { dsh: version, node: process.version, ...result, observerDisconnected: true };
} finally {
  try {
    await runtime?.stop();
  } finally {
    // 仅回收本次 mkdtemp 创建的直接子目录。
    const actual = realpathSync(lab);
    assert.equal(dirname(actual), tempParent);
    assert.equal(actual, lab);
    assert.ok(basename(lab).startsWith(prefix));
    rmSync(lab, { recursive: true, maxRetries: 5, retryDelay: 200 });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
console.log(JSON.stringify(summary, null, 2));
