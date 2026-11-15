import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const runtimeRoot = join(import.meta.dirname, "..");
const tauriRoot = join(runtimeRoot, "../../apps/desktop/src-tauri");
const dirs: string[] = [];
const children: ChildProcess[] = [];
let layout: string;
let node: string;
let cli: string;
function directory() { const dir = mkdtempSync(join(tmpdir(), "maneki-发行 layout ")); dirs.push(dir); return dir; }

describe.skipIf(process.platform !== "win32")("Windows bundled Node native lock layout", () => {
  beforeAll(async () => {
    await exec(process.execPath, [join(runtimeRoot, "scripts/build-runtime-bundle.mjs")], { timeout: 30_000, windowsHide: true });
    layout = directory(); node = join(layout, "maneki-runtime.exe"); cli = join(layout, "resources/maneki-runtime-bundle.js");
    mkdirSync(join(layout, "resources"));
    copyFileSync(join(tauriRoot, "binaries/maneki-runtime-x86_64-pc-windows-msvc.exe"), node);
    copyFileSync(join(tauriRoot, "resources/maneki-runtime-bundle.js"), cli);
    copyFileSync(join(tauriRoot, "resources/maneki-instance-lock.node"), join(layout, "resources/maneki-instance-lock.node"));
  }, 35_000);
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    }
  });
  afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  async function start(config: string) {
    const child = spawn(node, [cli, "--config-dir", config, "--port", "0", "--background"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("bundled Runtime ready timeout")), 10_000);
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const match = /runtime ready: port=(\d+)/.exec(stderr);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`bundled Runtime exited ${code}: ${stderr}`)); });
    });
    return { child, port };
  }
  it("自带重命名 Node 从含空格中文目录无 UI 运行，拒绝第二进程，退出与崩溃均可恢复", async () => {
    const config = directory();
    const first = await start(config);
    expect((await fetch(`http://127.0.0.1:${first.port}/v1/health`)).ok).toBe(true);
    const token = readFileSync(join(config, "root-token"), "utf8").trim();
    const failed = await exec(node, [cli, "--config-dir", config, "--background"], { timeout: 10_000, windowsHide: true }).catch((error: { code: number; stderr: string }) => error);
    expect(failed).toMatchObject({ code: 1 });
    expect((failed as { stderr: string }).stderr).toContain("LockBusyError");
    const exited = once(first.child, "exit");
    expect((await fetch(`http://127.0.0.1:${first.port}/v1/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).ok).toBe(true);
    await exited;
    expect(existsSync(join(config, "runtime.lock"))).toBe(false);
    const second = await start(config);
    const killed = once(second.child, "exit"); second.child.kill("SIGKILL"); await killed;
    expect(existsSync(join(config, "runtime.lock"))).toBe(true);
    const third = await start(config);
    expect((await fetch(`http://127.0.0.1:${third.port}/v1/health`)).ok).toBe(true);
    expect(readFileSync(join(config, "root-token"), "utf8").trim()).toBe(token);
  }, 30_000);
  it("发行目录缺失原生绑定时明确拒绝，不创建数据库或退回 PID 锁", async () => {
    const broken = directory(); const config = directory();
    const brokenCli = join(broken, "maneki-runtime-bundle.js"); copyFileSync(cli, brokenCli);
    const result = await exec(node, [brokenCli, "--config-dir", config, "--background"], { timeout: 10_000, windowsHide: true }).catch((error: { code: number; stderr: string }) => error);
    expect(result).toMatchObject({ code: 1 });
    expect((result as { stderr: string }).stderr).toContain("instance lock native binding unavailable");
    expect(existsSync(join(config, "runtime.db"))).toBe(false);
    expect(existsSync(join(config, "runtime.lock"))).toBe(false);
  });
});
