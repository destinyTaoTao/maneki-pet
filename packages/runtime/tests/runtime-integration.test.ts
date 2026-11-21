import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LockBusyError, startRuntime, type StartedRuntime } from "../src/index.js";
import { AssistantService } from "../src/assistant-service.js";
import { WsHub } from "../src/ws.js";

const runtimes: StartedRuntime[] = [];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-int-"));
  tempDirs.push(dir);
  return dir;
}

function requestJson(port: number, path: string, method: "GET" | "POST", token?: string): Promise<{ status: number; body: { protocolVersion?: number } }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
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
  it("并发退出共享组件故障，仍然释放数据库、端口与锁，错误和审计只含阶段名", async () => {
    const dir = makeTempDir();
    const log = vi.fn();
    const runtime = await startRuntime({ configDir: dir, log });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = runtime.assistant.stop.bind(runtime.assistant);
    const stop = vi.spyOn(runtime.assistant, "stop").mockImplementation(async () => {
      await original();
      await gate;
      throw new Error("private provider details");
    });
    const audit = vi.spyOn(runtime.store, "audit");
    const first = runtime.stop();
    const second = runtime.stop();
    release();
    const results = await Promise.allSettled([first, second]);
    expect(second).toBe(first);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "runtime cleanup failed: assistant" } });
    expect(results[1]).toEqual(results[0]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.state()).toBe("stopped");
    expect(() => runtime.store.auditCount()).toThrow();
    expect(audit).toHaveBeenCalledWith("runtime.stop_failed", runtime.instanceId, { failedStages: ["assistant"] }, expect.any(String));
    expect(JSON.stringify([results, log.mock.calls, audit.mock.calls])).not.toContain("private provider details");
    await expect(runtime.stop()).rejects.toThrow("assistant");
    runtimes.push(await startRuntime({ configDir: dir, port: runtime.port }));
  });

  it("停止审计写入失败仍关闭 SQLite 并释放实例锁", async () => {
    const dir = makeTempDir();
    const runtime = await startRuntime({ configDir: dir });
    vi.spyOn(runtime.store, "audit").mockImplementation(() => { throw new Error("private sqlite details"); });
    await expect(runtime.stop()).rejects.toThrow("audit");
    expect(() => runtime.store.auditCount()).toThrow();
    runtimes.push(await startRuntime({ configDir: dir, port: runtime.port }));
  });

  it("管理入口应答后清理失败会通知宿主并允许重启", async () => {
    const dir = makeTempDir();
    let completed!: () => void;
    const failure = new Promise<void>((resolve) => { completed = resolve; });
    const runtime = await startRuntime({ configDir: dir, onShutdownError: () => {
      completed();
      throw new Error("private host details");
    } });
    vi.spyOn(runtime.store, "audit").mockImplementation((kind) => {
      if (kind === "runtime.stopped") throw new Error("private sqlite details");
    });
    expect((await requestJson(runtime.port, "/v1/shutdown", "POST", runtime.rootToken)).status).toBe(200);
    await failure;
    await expect(runtime.stop()).rejects.toThrow("runtime cleanup failed: audit, host");
    expect(runtime.state()).toBe("stopped");
    runtimes.push(await startRuntime({ configDir: dir, port: runtime.port }));
  });

  it("HTTP 绑定后启动失败，回滚半初始化的 WS 并允许同目录同端口重启", async () => {
    const dir = makeTempDir();
    const log = vi.fn();
    let port: number | undefined;
    const originalStop = AssistantService.prototype.stop;
    const stop = vi.spyOn(AssistantService.prototype, "stop").mockImplementationOnce(async function (this: AssistantService) {
      await originalStop.call(this);
      throw new Error("private rollback details");
    });
    const detach = vi.spyOn(WsHub.prototype, "detach");
    const originalAttach = WsHub.prototype.attach;
    const attach = vi.spyOn(WsHub.prototype, "attach").mockImplementationOnce(function (this: WsHub, server) {
      originalAttach.call(this, server);
      const address = server.address();
      if (address && typeof address === "object") port = address.port;
      throw new Error("attach failed");
    });
    try {
      await expect(startRuntime({ configDir: dir, log })).rejects.toThrow("attach failed");
      expect(port).toBeGreaterThan(0);
      expect(detach).toHaveBeenCalledTimes(1);
      expect(log.mock.calls).toEqual([["runtime cleanup failed: assistant"]]);
      runtimes.push(await startRuntime({ configDir: dir, port: port! }));
    } finally {
      stop.mockRestore();
      attach.mockRestore();
      detach.mockRestore();
    }
  });

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

describe("外挂记忆装配（#46 的 Runtime 层）", () => {
  it.skipIf(process.platform !== "win32")("独立记忆进程关闭管道读端后明确降级，Runtime 与第二客户端仍健康", async () => {
    const dir = makeTempDir();
    const pidFile = join(dir, "memory.pid");
    const fixture = join(import.meta.dirname, "fixtures", "memory-pipe-fault.mjs");
    const serverExe = join(dir, "memory-pipe-fault.exe");
    const compiler = join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    await promisify(execFile)(compiler, ["/nologo", "/out:" + serverExe, join(import.meta.dirname, "fixtures", "memory-pipe-fault.cs")]);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, limits: { proactiveDailyTokenLimit: 100000, interactiveDailyTokenLimit: null, maxNotificationsPerHour: 30 }, externalMemory: { command: serverExe, args: [pidFile] }, dsh: { baseUrl: "http://127.0.0.1:1", token: "test-token" } }));
    const { stdout } = await promisify(execFile)(process.execPath, [fixture, dir], { timeout: 10000 });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ outcome: "degraded", reason: expect.stringMatching(/pipe error/), health: 200, other: 200, taskBefore: 409, taskAfter: 409 });
    const pid = Number((await import("node:fs")).readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
  it("独立 Runtime 中缺失记忆程序只降级记忆，健康接口继续可用", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, limits: { proactiveDailyTokenLimit: 100000, interactiveDailyTokenLimit: null, maxNotificationsPerHour: 30 }, externalMemory: { command: join(dir, "missing-executable") }, dsh: { baseUrl: "http://127.0.0.1:1", token: "test-token" } }));
    const fixture = join(import.meta.dirname, "fixtures", "memory-fault-process.mjs");
    const { stdout } = await promisify(execFile)(process.execPath, [fixture, dir], { timeout: 10000 });
    expect(JSON.parse(stdout)).toEqual({ outcome: "degraded", health: 200, taskBefore: 409, taskAfter: 409, secondClient: 200 });
  }, 15000);
  it("配置 externalMemory 后 runtime.memory 可用并经真实子进程检索", async () => {
    const dir = makeTempDir();
    const { writeFileSync } = await import("node:fs");
    const stub = join(import.meta.dirname, "fixtures", "memory-stub-server.mjs");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        limits: { proactiveDailyTokenLimit: 100_000, interactiveDailyTokenLimit: null, maxNotificationsPerHour: 30 },
        externalMemory: { command: process.execPath, args: [stub] },
      }),
      "utf8",
    );
    const runtime = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(runtime);
    expect(runtime.memory).toBeDefined();
    const writeCtx = { requestId: "w1", signal: new AbortController().signal, deadlineAtMs: Date.now() + 5_000 };
    const written = await runtime.memory!.writeback(
      { kind: "note", summary: "装配层检索验证", occurredAt: "2026-10-31T14:00:00Z" },
      writeCtx,
    );
    expect(written.outcome).toBe("ok");
    const result = await runtime.memory!.retrieveContext(
      { text: "装配层" },
      { requestId: "r1", signal: new AbortController().signal, deadlineAtMs: Date.now() + 5_000 },
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.items[0]?.text).toBe("装配层检索验证");
    }
    await runtime.stop();
  });

  it("未配置 externalMemory 时 memory 为 undefined，启动照常", async () => {
    const runtime = await startRuntime({ configDir: makeTempDir(), log: () => undefined });
    runtimes.push(runtime);
    expect(runtime.memory).toBeUndefined();
  });
});

describe("CLI 启动器（无桌宠窗口、SIGTERM 优雅退出）", () => {
  const runtimeRoot = join(import.meta.dirname, "..");
  const distCli = join(runtimeRoot, "dist", "cli.js");

  beforeAll(async () => {
    if (!existsSync(distCli)) {
      const { execSync } = await import("node:child_process");
      execSync("corepack pnpm build", { cwd: runtimeRoot, stdio: "ignore" });
    }
  }, 30_000);

  it("信号处理器在组件停止抛错时清理并以状态 1 退出，stderr 保留脱敏的阶段", async () => {
    const dir = makeTempDir();
    const fixture = join(import.meta.dirname, "fixtures", "cli-stop-fault.mjs");
    const result = promisify(execFile)(process.execPath, [fixture, "--config-dir", dir, "--background"], {
      timeout: 8_000, windowsHide: true,
    });
    await expect(result).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("runtime cleanup failed: assistant") });
    await expect(result).rejects.toMatchObject({ stderr: expect.not.stringContaining("private provider details") });
    expect(existsSync(join(dir, "runtime.lock"))).toBe(false);
    runtimes.push(await startRuntime({ configDir: dir }));
  });

  it("从构建产物启动、健康可达、SIGTERM 退出码 0", async () => {
    const dir = makeTempDir();
    const child: ChildProcess = spawn(process.execPath, [distCli, "--config-dir", dir, "--port", "0"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    try {
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

      const health = await requestJson(port, "/v1/health", "GET");
      expect(health.status).toBe(200);
      expect(health.body.protocolVersion).toBe(1);

      // Windows 上 kill(SIGTERM) 是强制终止；优雅退出经受信管理入口触发。
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      expect((await requestJson(port, "/v1/shutdown", "POST")).status).toBe(401);

      const { readFileSync } = await import("node:fs");
      const rootToken = readFileSync(join(dir, "root-token"), "utf8").trim();
      expect((await requestJson(port, "/v1/shutdown", "POST", rootToken)).status).toBe(200);

      const exitCode = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000))]);
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await stopped;
      }
    }
  }, 30_000);
});
