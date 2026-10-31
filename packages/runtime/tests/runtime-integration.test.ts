import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockBusyError, startRuntime, type StartedRuntime } from "../src/index.js";

const runtimes: StartedRuntime[] = [];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-int-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Runtime 装配与生命周期", () => {
  it("同一配置目录双入口并发启动被拒绝，退出后可再次启动（单实例 + 恢复）", async () => {
    const dir = makeTempDir();
    const first = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(first);
    await expect(startRuntime({ configDir: dir, log: () => undefined })).rejects.toBeInstanceOf(LockBusyError);
    await first.stop();
    const again = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(again);
    expect(again.instanceId).toBe(first.instanceId);
    await again.stop();
  });

  it("启动失败（坏配置）不留下实例锁，修好配置后可启动", async () => {
    const dir = makeTempDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ schemaVersion: 2, limits: {} }), "utf8");
    await expect(startRuntime({ configDir: dir, log: () => undefined })).rejects.toThrow(/schemaVersion 2/);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        limits: { proactiveDailyTokenLimit: 100_000, interactiveDailyTokenLimit: null, maxNotificationsPerHour: 30 },
      }),
      "utf8",
    );
    const retry = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(retry);
    expect(retry.state()).toBe("ready");
  });
});

describe("CLI 启动器（无桌宠窗口、SIGTERM 优雅退出）", () => {
  const runtimeRoot = join(import.meta.dirname, "..");
  const distCli = join(runtimeRoot, "dist", "cli.js");

  it("从构建产物启动、健康可达、SIGTERM 退出码 0", async () => {
    if (!existsSync(distCli)) {
      const { execSync } = await import("node:child_process");
      execSync("corepack pnpm build", { cwd: runtimeRoot, stdio: "ignore" });
    }
    const dir = makeTempDir();
    const child: ChildProcess = spawn(process.execPath, [distCli, "--config-dir", dir, "--port", "0"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    const readyLine = await new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        const line = stderr.join("").split("\n").find((entry) => entry.includes("ready: port="));
        if (line) {
          clearInterval(timer);
          resolve(line);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`cli did not become ready: ${stderr.join("")}`));
      }, 15_000);
    });
    const port = Number(/port=(\d+)/.exec(readyLine)?.[1]);
    expect(port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { protocolVersion: number };
    expect(body.protocolVersion).toBe(1);

    // Windows 上 kill(SIGTERM) 是强制终止；优雅退出经受信管理入口触发。
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    const shutdown = await fetch(`http://127.0.0.1:${port}/v1/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // 未带根令牌的管理动作必须被拒绝，然后带令牌执行。
    expect(shutdown.status).toBe(401);

    const cliDir = dir;
    const { readFileSync } = await import("node:fs");
    const rootToken = readFileSync(join(cliDir, "root-token"), "utf8").trim();
    const authedShutdown = await fetch(`http://127.0.0.1:${port}/v1/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${rootToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(authedShutdown.status).toBe(200);

    const exitCode = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000))]);
    expect(exitCode).toBe(0);
  }, 30_000);
});
