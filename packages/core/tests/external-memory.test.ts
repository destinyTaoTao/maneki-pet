import { describe, expect, it } from "vitest";

import {
  defaultExternalMemoryConfig,
  MemoryContextService,
  type AssistantMemoryRecord,
  type CallContext,
  type ExternalMemoryConfig,
  type ExternalMemoryProvider,
  type MemoryItem,
} from "../src/index.js";

const providerInfo = { id: "user-memory", apiVersion: 1 as const, locality: "local" as const };

const callContext: CallContext = {
  requestId: "req-1",
  signal: new AbortController().signal,
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
};

const mixedItems: MemoryItem[] = [
  { id: "m1", text: "用户偏好简洁回复", source: "explicit" },
  { id: "m2", text: "上周讨论过编译方案", source: "implicit" },
];

class FakeMemoryProvider implements ExternalMemoryProvider {
  readonly info = providerInfo;
  readonly written: AssistantMemoryRecord[] = [];
  retrieveError: Error | null = null;

  async retrieve(): Promise<{ items: MemoryItem[] }> {
    if (this.retrieveError) {
      throw this.retrieveError;
    }
    return { items: mixedItems };
  }

  async write(record: AssistantMemoryRecord): Promise<void> {
    this.written.push(record);
  }
}

describe("MemoryContextService 检索注入", () => {
  it("正常检索返回条目", async () => {
    const service = new MemoryContextService({ provider: new FakeMemoryProvider() });
    const result = await service.retrieveContext({ text: "偏好" }, callContext);
    expect(result).toEqual({ outcome: "ok", items: mixedItems });
  });

  it("读取关闭时不调用 Provider，核心流程照常", async () => {
    const provider = new FakeMemoryProvider();
    const service = new MemoryContextService({
      provider,
      config: { ...defaultExternalMemoryConfig, readEnabled: false },
    });
    const result = await service.retrieveContext({ text: "偏好" }, callContext);
    expect(result.outcome).toBe("skipped");
    expect(provider.info.id).toBe("user-memory");
  });

  it("显式记忆与隐式引用分别开关：关闭隐式后只保留显式条目", async () => {
    const service = new MemoryContextService({
      provider: new FakeMemoryProvider(),
      config: { ...defaultExternalMemoryConfig, implicitReferenceEnabled: false },
    });
    const result = await service.retrieveContext({ text: "偏好" }, callContext);
    expect(result).toEqual({ outcome: "ok", items: [mixedItems[0]] });
  });

  it("Provider 失败时降级：返回空结果与 degraded，核心流程不受影响", async () => {
    const provider = new FakeMemoryProvider();
    provider.retrieveError = new Error("memory backend down");
    const service = new MemoryContextService({ provider });
    const result = await service.retrieveContext({ text: "偏好" }, callContext);
    expect(result.outcome).toBe("degraded");
    if (result.outcome === "degraded") {
      expect(result.reason).toContain("retrieve failed");
    }
  });

  it("超过 deadline 的迟到检索结果被丢弃", async () => {
    let nowMs = 1_000;
    let resolveRetrieval: (value: { items: MemoryItem[] }) => void = () => undefined;
    const lateProvider: ExternalMemoryProvider = {
      info: providerInfo,
      retrieve: async () => new Promise((resolve) => { resolveRetrieval = resolve; }),
      write: async () => undefined,
    };
    const service = new MemoryContextService({ provider: lateProvider, clock: () => nowMs });
    const pending = service.retrieveContext(
      { text: "偏好" },
      { requestId: "req-1", signal: new AbortController().signal, deadlineAtMs: 2_000 },
    );
    nowMs = 3_000;
    resolveRetrieval({ items: mixedItems });
    await expect(pending).resolves.toMatchObject({ outcome: "degraded" });
  });
});

describe("MemoryContextService 写回", () => {
  const record: AssistantMemoryRecord = {
    kind: "main_chat",
    summary: "用户确认了三层限额方案",
    content: "完整对话原文……",
    occurredAt: "2026-10-31T12:00:00Z",
  };

  it("默认全量原始：写回包含 content", async () => {
    const provider = new FakeMemoryProvider();
    const service = new MemoryContextService({ provider });
    const result = await service.writeback(record, callContext);
    expect(result.outcome).toBe("ok");
    expect(provider.written[0]?.content).toBe("完整对话原文……");
  });

  it("仅摘要档：写回剥离 content，保留 summary", async () => {
    const provider = new FakeMemoryProvider();
    const service = new MemoryContextService({
      provider,
      config: { ...defaultExternalMemoryConfig, writebackGranularity: "summary" },
    });
    await service.writeback(record, callContext);
    const written = provider.written[0];
    expect(written?.summary).toBe("用户确认了三层限额方案");
    expect(written?.content).toBeUndefined();
  });

  it("粒度关闭或写入关闭时不调用 Provider", async () => {
    const offGranularity = new FakeMemoryProvider();
    const offService = new MemoryContextService({
      provider: offGranularity,
      config: { ...defaultExternalMemoryConfig, writebackGranularity: "off" },
    });
    expect((await offService.writeback(record, callContext)).outcome).toBe("skipped");
    expect(offGranularity.written).toHaveLength(0);

    const disabled = new FakeMemoryProvider();
    const disabledService = new MemoryContextService({
      provider: disabled,
      config: { ...defaultExternalMemoryConfig, writeEnabled: false },
    });
    expect((await disabledService.writeback(record, callContext)).outcome).toBe("skipped");
    expect(disabled.written).toHaveLength(0);
  });

  it("Provider 写入失败时降级且不抛出，核心流程不受影响", async () => {
    const provider: ExternalMemoryProvider = {
      info: providerInfo,
      retrieve: async () => ({ items: [] }),
      write: async () => {
        throw new Error("disk full");
      },
    };
    const service = new MemoryContextService({ provider });
    const result = await service.writeback(record, callContext);
    expect(result.outcome).toBe("degraded");
  });

  it("写回记录只覆盖助理侧来源（四种 kind），不含 harness 会话存储", async () => {
    const provider = new FakeMemoryProvider();
    const service = new MemoryContextService({ provider });
    const kinds: AssistantMemoryRecord["kind"][] = ["main_chat", "sub_session", "task", "note"];
    for (const kind of kinds) {
      await service.writeback({ kind, summary: `${kind} 摘要`, occurredAt: "2026-10-31T12:00:00Z" }, callContext);
    }
    expect(provider.written.map((written) => written.kind)).toEqual(kinds);
  });
});

describe("外挂记忆出厂默认", () => {
  it("默认全量原始写回、读写开启、显式与隐式引用开启", () => {
    const config: ExternalMemoryConfig = defaultExternalMemoryConfig;
    expect(config.writebackGranularity).toBe("raw");
    expect(config.readEnabled).toBe(true);
    expect(config.writeEnabled).toBe(true);
    expect(config.explicitMemoryEnabled).toBe(true);
    expect(config.implicitReferenceEnabled).toBe(true);
  });
});
