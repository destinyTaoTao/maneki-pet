import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemoryContextService,
  defaultExternalMemoryConfig,
  type AssistantMemoryRecord,
  type CallContext,
} from "@maneki-pet/core";

import { McpMemoryClient } from "../src/index.js";

const tempDirs: string[] = [];
const clients: McpMemoryClient[] = [];
const STUB = join(import.meta.dirname, "fixtures", "memory-stub-server.mjs");

function makeCtx(deadlineInMs: number): CallContext {
  return { requestId: `req-${Math.random()}`, signal: new AbortController().signal, deadlineAtMs: Date.now() + deadlineInMs };
}

function makeClient(env: Record<string, string> = {}): McpMemoryClient {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-mem-"));
  tempDirs.push(dir);
  const client = new McpMemoryClient({ command: process.execPath, args: [STUB], env });
  clients.push(client);
  return client;
}

const record: AssistantMemoryRecord = {
  kind: "task",
  summary: "README 翻译任务完成",
  content: "完整任务记录……",
  occurredAt: "2026-10-31T12:00:00Z",
};

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP 记忆客户端 × 替身契约", () => {
  it("取消在途读取后丢弃迟到响应，后续请求仍可完成", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-mem-cancel-"));
    tempDirs.push(dir);
    const log = join(dir, "calls.log");
    const client = makeClient({ MEMORY_STUB_TOOL_DELAY_MS: "500", MEMORY_STUB_TOOL_LOG: log });
    const controller = new AbortController();
    try {
      const pending = client.retrieve({ text: "first" }, { requestId: "first", signal: controller.signal, deadlineAtMs: Date.now() + 5000 });
      const cancelled = expect(pending).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(existsSync(log)).toBe(true));
      controller.abort();
      await cancelled;
      await expect(client.retrieve({ text: "second" }, makeCtx(5000))).resolves.toEqual({ items: [] });
    } finally { await client.stop(); }
  });
  it("可执行文件不存在时记忆降级，调用者继续工作", async () => {
    const client = new McpMemoryClient({ command: join(tmpdir(), "maneki-nonexistent-executable-51") });
    const service = new MemoryContextService({ provider: client });
    try {
      expect((await service.retrieveContext({ text: "x" }, makeCtx(2000))).outcome).toBe("degraded");
    } finally { await client.stop(); }
  });

  it("停止时结束在途请求并禁止后续调用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-mem-stop-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "pid");
    const client = makeClient({ MEMORY_STUB_DELAY_MS: "5000", MEMORY_STUB_PID_FILE: pidFile });
    const pending = client.retrieve({ text: "x" }, makeCtx(10000));
    const assertion = expect(pending).rejects.toThrow(/stopped/);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    await client.stop();
    await assertion;
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(client.retrieve({ text: "x" }, makeCtx(1000))).rejects.toThrow(/stopped/);
  });
  it("写入成功后丢失回执时不重放并报告结果未知", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-mem-write-"));
    tempDirs.push(dir);
    const log = join(dir, "writes.log");
    const client = makeClient({ MEMORY_STUB_WRITE_LOG: log });
    const service = new MemoryContextService({ provider: client });
    try {
      const result = await service.writeback(record, makeCtx(5000));
      expect(result.outcome).toBe("degraded");
      if (result.outcome === "degraded") expect(result.reason).toMatch(/unknown/i);
      expect(readFileSync(log, "utf8")).toBe("write\n");
    } finally {
      await client.stop();
    }
  });
  it("写回与检索：全量记录透传，命中条目按约定形状返回", async () => {
    const client = makeClient();
    await client.write(record, makeCtx(5_000));
    const { items } = await client.retrieve({ text: "README" }, makeCtx(5_000));
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("README 翻译任务完成");
    expect(items[0]?.source).toBe("explicit");
  });

  it("服务端工具错误按错误语义上抛（而非静默空结果）", async () => {
    const retrieveFail = makeClient({ MEMORY_STUB_FAIL: "retrieve" });
    await expect(retrieveFail.retrieve({ text: "x" }, makeCtx(5_000))).rejects.toThrow(/stub retrieve failure/);

    const writeFail = makeClient({ MEMORY_STUB_FAIL: "write" });
    await expect(writeFail.write(record, makeCtx(5_000))).rejects.toThrow(/stub write failure/);
  });

  it("超时可区分：deadline 内未响应即超时拒绝，宽限期内恢复", async () => {
    const client = makeClient({ MEMORY_STUB_DELAY_MS: "800" });
    await expect(client.retrieve({ text: "x" }, makeCtx(100))).rejects.toThrow(/timeout/);
    await expect(client.retrieve({ text: "x" }, makeCtx(5_000))).resolves.toMatchObject({ items: [] });
  });

  it("Core MemoryContextService 组合：客户端失败降级为空结果，核心流程不受影响", async () => {
    const client = makeClient({ MEMORY_STUB_FAIL: "retrieve" });
    const service = new MemoryContextService({ provider: client, config: defaultExternalMemoryConfig });
    const result = await service.retrieveContext({ text: "x" }, makeCtx(5_000));
    expect(result.outcome).toBe("degraded");
  });

  it("stop 后拒绝新调用（关闭后端到端零调用）", async () => {
    const client = makeClient();
    await client.stop();
    await expect(client.retrieve({ text: "x" }, makeCtx(5_000))).rejects.toThrow(/client stopped/);
  });

  it("服务进程崩溃后在途读取失败，后续调用重启并恢复可用", async () => {
    // 替身在第 2 个请求后退出，不重放结果未知的在途请求。
    const client = makeClient({ MEMORY_STUB_EXIT_AFTER: "2" });
    await client.write(record, makeCtx(5_000));
    await expect(client.retrieve({ text: "README" }, makeCtx(5_000))).rejects.toThrow(/exited/);
    const after = await client.write({ ...record, kind: "note", summary: "崩溃后的写入" }, makeCtx(5_000));
    expect(after).toBeUndefined();
  });
});
