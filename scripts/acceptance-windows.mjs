import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile),
  repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const marker = join(repo, "dist/acceptance-current.json");
const release = read(
  join(repo, "apps/desktop/src-tauri/tauri.conf.json"),
).version;
async function run(file, args, env = process.env, extra = {}) {
  return exec(file, args, {
    env,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    ...extra,
  });
}
async function installer(file, destination, env, expected = 0) {
  const result = await run(
    file,
    ["/S", "/NS", "/UPDATE", `/D=${destination}`],
    env,
    { windowsVerbatimArguments: true },
  ).then(
    () => 0,
    (error) => error.code,
  );
  assert.equal(result, expected, "isolated installer exit code");
}
async function health() {
  return fetch("http://127.0.0.1:18100/v1/health", {
    signal: AbortSignal.timeout(1000),
  })
    .then((r) => r.json())
    .catch(() => undefined);
}
async function waitFor(fn, label) {
  const until = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`);
    await delay(100);
  }
}
function validatedMetadata() {
  const meta = read(marker);
  const lab = realpathSync(meta.lab);
  assert.equal(dirname(lab), realpathSync(tmpdir()));
  assert.match(basename(lab), /^maneki-install-acceptance-[A-Za-z0-9]{6}$/);
  assert.equal(meta.install, join(meta.lab, "安装 目录"));
  assert.match(meta.binary, /^maneki-acceptance-[0-9a-f]{8}\.exe$/);
  assert.equal(meta.current, join(meta.lab, "current.exe"));
  const appdata = meta.appdata ?? join(meta.lab, "appdata");
  assert.equal(dirname(appdata), meta.lab);
  assert.match(basename(appdata), /^appdata(?:-repeat-[0-9a-f]{8})?$/);
  assert.equal(dirname(realpathSync(appdata)), lab);
  return meta;
}
async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  const mode = process.argv[2] ?? "prepare";
  if (mode === "finish") {
    const meta = validatedMetadata(),
      lab = meta.lab;
    const env = {
      ...process.env,
      APPDATA: meta.appdata ?? join(lab, "appdata"),
      DSH_HOME: join(lab, "dsh-home"),
    };
    const config = join(env.APPDATA, "com.manekipet.desktop/runtime");
    // 仅关闭本次验收可执行文件的视图；不是原生退出/授权验收。
    await run(join(meta.install, meta.binary), ["--close-view"], env);
    const root = readFileSync(join(config, "root-token"), "utf8").trim();
    if (await health())
      await fetch("http://127.0.0.1:18100/v1/shutdown", {
        method: "POST",
        headers: {
          authorization: `Bearer ${root}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
    await waitFor(
      async () => !existsSync(join(config, "runtime.lock")),
      "test Runtime shutdown",
    );
    const database = digest(join(config, "runtime.db"));
    // close-view 的 IPC 应答可能早于 WebView 释放句柄；32 表示安装器未改文件。
    await waitFor(async () => {
      try {
        await run(
          join(meta.install, "uninstall.exe"),
          ["/S", `_?=${meta.install}`],
          env,
          { windowsVerbatimArguments: true },
        );
        return true;
      } catch (error) {
        if (error.code !== 32) throw error;
        return false;
      }
    }, "test view file handles released before uninstall");
    assert(!existsSync(join(meta.install, meta.binary)));
    assert(!existsSync(join(meta.install, "maneki-runtime.exe")));
    assert(
      !existsSync(join(env.APPDATA, "com.manekipet.desktop/installation.json")),
    );
    assert.equal(digest(join(config, "runtime.db")), database);
    meta.evidence.uninstallRetainsDatabase = true;
    meta.evidence.nativeWindowManual =
      "see audit; no permission prompts automated";
    writeFileSync(marker, JSON.stringify(meta, null, 2));
    writeFileSync(
      join(lab, "evidence.json"),
      JSON.stringify(meta.evidence, null, 2),
    );
    console.log(`PASS: isolated uninstall preserved data; evidence ${lab}`);
    return;
  }
  assert(["prepare", "repeat"].includes(mode));
  assert.equal(
    await health(),
    undefined,
    "Leave the user's running Runtime untouched; free port 18100 before this isolated test",
  );
  const prior = mode === "repeat" ? validatedMetadata() : undefined;
  const id = prior
      ? prior.binary.slice("maneki-acceptance-".length, -4)
      : randomUUID().slice(0, 8),
    lab =
      prior?.lab ?? mkdtempSync(join(tmpdir(), "maneki-install-acceptance-")),
    install = join(lab, "安装 目录"),
    binary = `maneki-acceptance-${id}.exe`,
    product = `Maneki Acceptance ${id}`;
  const env = {
    ...process.env,
    APPDATA: join(
      lab,
      prior ? `appdata-repeat-${randomUUID().slice(0, 8)}` : "appdata",
    ),
    DSH_HOME: join(lab, "dsh-home"),
  };
  const config = join(env.APPDATA, "com.manekipet.desktop/runtime"),
    override = join(lab, "acceptance.config.json");
  const base = {
    productName: product,
    identifier: `com.manekipet.acceptance.${id}`,
    mainBinaryName: binary.slice(0, -4),
  };
  assert(
    !existsSync(join(install, binary)),
    "Finish the previous isolated installation before repeating",
  );
  if (!prior) {
    writeFileSync(override, JSON.stringify(base));
    console.log("Building installer with independent acceptance identity...");
    await run(
      process.execPath,
      [cli, "build", "--bundles", "nsis", "--config", override],
      process.env,
      { cwd: join(repo, "apps/desktop"), timeout: 240000 },
    );
    const { copyFileSync } = await import("node:fs");
    copyFileSync(
      join(
        repo,
        "apps/desktop/src-tauri/target/release/bundle/nsis",
        `${product}_${release}_x64-setup.exe`,
      ),
      join(lab, "current.exe"),
    );
    writeFileSync(override, JSON.stringify({ ...base, version: "0.1.9" }));
    await run(
      process.execPath,
      [cli, "bundle", "--bundles", "nsis", "--config", override],
      process.env,
      { cwd: join(repo, "apps/desktop"), timeout: 240000 },
    );
    copyFileSync(
      join(
        repo,
        "apps/desktop/src-tauri/target/release/bundle/nsis",
        `${product}_0.1.9_x64-setup.exe`,
      ),
      join(lab, "previous.exe"),
    );
  }
  const current = join(lab, "current.exe"),
    previous = join(lab, "previous.exe");
  const evidence = {
    product,
    release,
    previousInstallerMetadata: "0.1.9 (same current source)",
    productionIdentityUntouched: true,
  };
  mkdirSync(dirname(marker), { recursive: true });
  const meta = {
    lab,
    install,
    binary,
    current,
    appdata: env.APPDATA,
    evidence,
  };
  writeFileSync(marker, JSON.stringify(meta, null, 2));
  await installer(previous, install, env);
  console.log("PASS initial installation / entry registration");
  assert.equal(
    read(
      join(env.APPDATA, "com.manekipet.desktop/installation.json"),
    ).executable.toLowerCase(),
    join(install, binary).toLowerCase(),
  );
  assert(existsSync(join(install, "resources/licenses/Node-LICENSE.txt")));
  const native = async (action) =>
    JSON.parse(
      (
        await run(
          join(install, binary),
          ["--assistant", action, "--client", "acceptance"],
          env,
        )
      ).stdout,
    );
  assert.equal((await native("status")).state, "stopped");
  try {
    await native("connect");
    assert.fail("native connect must not authorize pairing");
  } catch (error) {
    assert.equal(JSON.parse(error.stdout).error, "pairing_required");
  }
  const sidecar = join(install, "maneki-runtime.exe"),
    bundle = join(install, "resources/maneki-runtime-bundle.js");
  const credential = async () =>
    JSON.parse(
      (
        await run(
          sidecar,
          [
            bundle,
            "--config-dir",
            config,
            "--port",
            "18100",
            "--assistant-credential",
          ],
          env,
        )
      ).stdout,
    ).token;
  let token = await credential();
  console.log("PASS bundled Runtime first personal credential");
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:18100/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    assert(response.ok, `formal API ${path}: ${response.status}`);
    return response.json();
  };
  const first = await api("/assistant/snapshot");
  assert.equal(first.settings.chat.enabled, false);
  assert.equal(first.settings.voice.microphoneEnabled, false);
  assert.equal(first.settings.cloudEnabled, false);
  await api("/assistant/chat", {
    requestId: "acceptance-todo",
    text: "待办：安装验收保留事项",
  });
  await waitFor(
    async () => (await api("/assistant/snapshot")).todos.length === 1,
    "text todo persistence",
  );
  await api("/assistant/mutations", {
    requestId: "acceptance-reminder",
    action: "reminder.create",
    message: "安装验收提醒（不实际到期）",
    remindAt: Date.now() + 86400000,
  });
  const snapshot = await api("/assistant/snapshot");
  console.log("PASS formal text assistant / todo / reminder");
  const before = digest(sidecar);
  await installer(current, install, env, 32);
  assert.equal(digest(sidecar), before);
  assert.equal((await native("status")).state, "ready");
  const blockedUninstall = await run(
    join(install, "uninstall.exe"),
    ["/S", `_?=${install}`],
    env,
    { windowsVerbatimArguments: true },
  ).then(
    () => 0,
    (error) => error.code,
  );
  assert.equal(blockedUninstall, 32);
  console.log(
    "PASS running install and uninstall rejected without killing Runtime",
  );
  const root = readFileSync(join(config, "root-token"), "utf8").trim();
  await fetch("http://127.0.0.1:18100/v1/shutdown", {
    method: "POST",
    headers: {
      authorization: `Bearer ${root}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  await waitFor(
    async () => !existsSync(join(config, "runtime.lock")),
    "shutdown before upgrade",
  );
  // 锁在关库后释放，仍等待监听端口关闭，避免把同 PID 的关闭阶段当作新服务。
  await waitFor(async () => !(await health()), "old listener close");
  await run(
    sidecar,
    [
      "-e",
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('ALTER TABLE assistant_reminders DROP COLUMN seen_at;DELETE FROM schema_migrations WHERE version=6');d.close()",
      join(config, "runtime.db"),
    ],
    env,
  );
  await installer(current, install, env);
  console.log("PASS installer upgrade; reconnecting...");
  try {
    await native("connect");
    assert.fail("native pairing remains manual");
  } catch (error) {
    assert.equal(JSON.parse(error.stdout).error, "pairing_required");
  }
  token = await credential();
  console.log("PASS upgraded Runtime personal credential reuse");
  const restored = await api("/assistant/snapshot");
  assert.equal(restored.todos[0].id, snapshot.todos[0].id);
  assert.equal(restored.reminders[0].id, snapshot.reminders[0].id);
  assert(existsSync(join(config, "runtime.db.bak-5")));
  evidence.installedWithSpacesAndChinese = true;
  evidence.automaticEntryRegistration = true;
  evidence.runningInstallAndUninstallRejected = true;
  evidence.upgradeDataAndV5MigrationPreserved = true;
  evidence.personalAssistantFromBundledNode = true;
  evidence.voiceAndCloudDisabledByDefault = true;
  const dshEntry =
    process.env.MANEKI_DSH_ENTRY ??
    join(process.env.APPDATA, "npm/node_modules/@deepseek-ai/dsh/lib/bin.js");
  assert(
    existsSync(dshEntry),
    "Set MANEKI_DSH_ENTRY to installed dsh lib/bin.js",
  );
  assert.equal(
    read(join(dirname(dshEntry), "../package.json")).version,
    "0.2.1-rc.5",
  );
  const plugin = join(lab, "maneki-pet-dsh-plugin-0.3.0.tgz");
  const manager = process.env.npm_execpath;
  assert(manager, "Run with pnpm acceptance:windows");
  await run(
    process.execPath,
    [
      manager,
      "--filter",
      "@maneki-pet/dsh-plugin",
      "pack",
      "--pack-destination",
      lab,
    ],
    process.env,
    { cwd: repo, timeout: 60000 },
  );
  await run(
    process.execPath,
    [dshEntry, "plugin", "--profile", "web", "add", plugin],
    env,
    { timeout: 60000 },
  );
  console.log("PASS actual dsh local plugin install");
  const probe = join(lab, "probe.mjs"),
    patch = join(lab, "probe.patch.yml"),
    proof = join(lab, "dsh-status.json");
  writeFileSync(
    probe,
    `import {writeFileSync} from 'node:fs';export const name='maneki-preview-probe';export const inject=['commands'];export function apply(ctx){let busy=false;const timer=setInterval(async()=>{if(busy)return;const command=ctx.commands.find(undefined,'maneki');if(!command)return;busy=true;try{const result=await command.handler({rawInput:' status',signal:new AbortController().signal});if(result.kind==='success'){writeFileSync(${JSON.stringify(proof)},JSON.stringify({registered:true,recordInput:command.recordInput,result}));clearInterval(timer);}}finally{busy=false;}},200);ctx.on('dispose',()=>clearInterval(timer));}`,
  );
  writeFileSync(
    patch,
    `- id: maneki-observer\n  config:\n    profileId: acceptance\n    showOnConnect: false\n- insert:\n    - id: maneki-preview-probe\n      name: ${JSON.stringify(probe.replaceAll("\\", "/"))}\n`,
  );
  const host = spawn(
    process.execPath,
    [
      dshEntry,
      "--profile",
      "web",
      "--patch",
      patch,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  host.stdout.on("data", (c) => (log += c));
  host.stderr.on("data", (c) => (log += c));
  try {
    await waitFor(async () => existsSync(proof), "actual dsh command registry");
    assert.equal(read(proof).recordInput, false);
    assert.match(read(proof).result.text, /正在运行/);
    evidence.actualDshInstalledAndStatusHandler = true;
  } finally {
    host.kill();
    await new Promise((done) =>
      host.exitCode !== null ? done() : host.once("exit", done),
    );
    writeFileSync(join(lab, "dsh.log"), log);
  }
  assert.equal((await native("status")).state, "ready");
  evidence.hostExitPreservesRuntime = true;
  writeFileSync(marker, JSON.stringify(meta, null, 2));
  writeFileSync(join(lab, "evidence.json"), JSON.stringify(evidence, null, 2));
  const view = spawn(join(install, binary), ["--assistant-view"], {
    env,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    view.once("spawn", resolve);
    view.once("error", reject);
  });
  view.unref();
  console.log(
    `PASS: isolated installer, upgrade, Runtime and actual dsh. Inspect native view, then pnpm acceptance:windows finish. Evidence ${lab}`,
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
