import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { on, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const repo = fileURLToPath(new URL("../../", import.meta.url));
const suggested = join(process.env.APPDATA ?? "", "npm/node_modules/@deepseek-ai/dsh/lib/bin.js");
const dshCli = resolve(process.argv[2] ?? suggested);
assert.ok(process.argv.length <= 3 && existsSync(dshCli),
  "请将已安装的 dsh/lib/bin.js 路径作为唯一的可选参数");

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

export function writeProfile(dshHome, extraPlugins) {
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
  writeFileSync(join(profile, "cordis.patch.yml"), JSON.stringify([{ insert: [...plugins, ...extraPlugins] }]));
}

export async function exerciseHost(cwd, env, patches, revoke, signal) {
  const patchArgs = [].concat(patches).flatMap(patch => ["--patch", patch]);
  const child = fork(dshCli, ["--profile", "acceptance", ...patchArgs], {
    cwd, env, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const closed = once(child, "close");
  let result;
  let revoked = false;
  try {
    for await (const [message] of on(child, "message", { close: ["close"], signal })) {
      if (message.type === "revoke") {
        assert.ok(revoke && !revoked, "本轮无法撤销或已经撤销");
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
    assert.ok(result, "dsh 未完成工具调用");
    if (revoke) assert.ok(revoked, "dsh 未完成撤销检查");
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

export async function withFixture(scenario, exercise) {
  const tempParent = realpathSync(tmpdir());
  const prefix = `maneki-${scenario}-acceptance-`;
  const lab = mkdtempSync(join(tempParent, prefix));
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const env = fixtureEnvironment(lab);
    const cwd = join(lab, "fixture-project");
    mkdirSync(cwd);
    const configDir = join(lab, "runtime");
    const runNode = (...args) => exec(process.execPath, args, {
      cwd, env, windowsHide: true, timeout: 10000, signal: cancel.signal,
    });
    const version = (await runNode(dshCli, "--version")).stdout.trim();
    return await exercise({ lab, env, cwd, configDir, runNode, dshCli, version, signal: cancel.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // 仅回收本次 mkdtemp 创建的直接子目录。
    const actual = realpathSync(lab);
    assert.equal(dirname(actual), tempParent);
    assert.equal(actual, lab);
    assert.ok(basename(lab).startsWith(prefix));
    rmSync(lab, { recursive: true, maxRetries: 5, retryDelay: 200 });
  }
}
