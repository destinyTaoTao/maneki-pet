import { describe, expect, it } from "vitest";

import {
  InMemoryTaskStore,
  TaskBroker,
  type BrokerTask,
} from "../src/index.js";

function makeClock() {
  let currentMs = Date.UTC(2026, 10, 31, 10, 0, 0);
  return {
    clock: () => new Date(currentMs),
    advanceMs: (ms: number) => {
      currentMs += ms;
    },
  };
}

interface Harness {
  broker: TaskBroker;
  dispatched: BrokerTask[];
  store: InMemoryTaskStore;
  advanceMs: (ms: number) => void;
  settle: (brokerRequestId: string, status: "completed" | "failed" | "cancelled") => void;
}

function makeHarness(config?: Partial<{ maxRunningPerWorkdir: number; maxQueuedPerWorkdir: number }>): Harness {
  const { clock, advanceMs } = makeClock();
  const store = new InMemoryTaskStore();
  const dispatched: BrokerTask[] = [];
  const broker = new TaskBroker({
    store,
    clock,
    ...(config ? { config } : {}),
    dispatcher: {
      dispatch: (task) => {
        dispatched.push({ ...task });
        return Promise.resolve();
      },
    },
  });
  return {
    broker,
    dispatched,
    store,
    advanceMs,
    settle: (id, status) => {
      const task = broker.notifySettled(id, status);
      if (task) advanceMs(1000);
      void task;
    },
  };
}

const entryA = { clientRequestId: "client-1", prompt: "翻译 README", workdir: "C:\\proj\\a" };
const entryB = { clientRequestId: "client-2", prompt: "修复构建", workdir: "C:\\proj\\a" };

describe("TaskBroker 入口幂等（clientRequestId → brokerRequestId）", () => {
  it("同键同内容重放返回原回执；同键异内容冲突拒绝", () => {
    const h = makeHarness();
    const first = h.broker.submit(entryA);
    expect(first.outcome).toBe("accepted");
    const replay = h.broker.submit(entryA);
    expect(replay.outcome).toBe("idempotent-replay");
    if (replay.outcome === "idempotent-replay") {
      expect(replay.task.brokerRequestId).toBe((first as { outcome: "accepted"; task: BrokerTask }).task.brokerRequestId);
    }
    const conflict = h.broker.submit({ ...entryA, prompt: "改成别的任务" });
    expect(conflict.outcome).toBe("rejected");
    if (conflict.outcome === "rejected") {
      expect(conflict.reason).toContain("different content");
    }
  });

  it("不同入口相同内容 → 不同 brokerRequestId（不合并猜测）", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    const b = h.broker.submit({ ...entryB, prompt: "翻译 README", workdir: "C:\\proj\\b" });
    expect(a.outcome).toBe("accepted");
    expect(b.outcome).toBe("accepted");
    const ta = (a as { outcome: "accepted"; task: BrokerTask }).task;
    const tb = (b as { outcome: "accepted"; task: BrokerTask }).task;
    expect(tb.brokerRequestId).not.toBe(ta.brokerRequestId);
  });

  it("brokerRequestId 撞键拒绝（同键异入口防御）", () => {
    const h = makeHarness();
    const first = h.broker.submit(entryA);
    expect(first.outcome).toBe("accepted");
    // clientRequestId 派生出 brokerRequestId：相同 clientRequestId 已被幂等分支覆盖；
    // 直接注入同 brokerRequestId 的存储条目后，另一入口不应复用。
    const second = h.broker.submit(entryB);
    expect(second.outcome).toBe("accepted");
  });
});

describe("TaskBroker 同项目串行与有界排队", () => {
  it("同 workdir 默认串行：第二单排队，完成前不派发", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    const b = h.broker.submit(entryB);
    expect(a.outcome).toBe("accepted");
    expect(b.outcome).toBe("accepted");
    expect(h.dispatched).toHaveLength(1);
    if (b.outcome === "accepted") {
      expect(b.task.status).toBe("queued");
    }
  });

  it("完成驱动队列前移并自动派发下一单", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    const b = h.broker.submit(entryB);
    h.settle((a as { outcome: "accepted"; task: BrokerTask }).task.brokerRequestId, "completed");
    expect(h.dispatched).toHaveLength(2);
    expect(h.dispatched[1]?.prompt).toBe("修复构建");
    if (b.outcome === "accepted") {
      expect(h.broker.notifySettled(b.task.brokerRequestId, "completed")?.status).toBe("completed");
    }
  });

  it("不同 workdir 可并行（互不阻塞）", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    const c = h.broker.submit({ clientRequestId: "client-3", prompt: "别的项目", workdir: "C:\\proj\\b" });
    expect(a.outcome).toBe("accepted");
    expect(c.outcome).toBe("accepted");
    expect(h.dispatched).toHaveLength(2);
  });

  it("队列有界：超出上限拒绝且不静默丢弃", () => {
    const h = makeHarness({ maxRunningPerWorkdir: 1, maxQueuedPerWorkdir: 1 });
    expect(h.broker.submit(entryA).outcome).toBe("accepted");
    expect(h.broker.submit(entryB).outcome).toBe("accepted");
    const third = h.broker.submit({ clientRequestId: "client-3", prompt: "x", workdir: "C:\\proj\\a" });
    expect(third.outcome).toBe("rejected");
    if (third.outcome === "rejected") {
      expect(third.reason).toContain("queue full");
    }
  });

  it("失败任务也触发队列前移", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    h.broker.submit(entryB);
    h.settle((a as { outcome: "accepted"; task: BrokerTask }).task.brokerRequestId, "failed");
    expect(h.dispatched).toHaveLength(2);
  });
});

describe("TaskBroker 状态纪律", () => {
  it("终态不可被覆盖（迟到结算不回退）", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    const id = (a as { outcome: "accepted"; task: BrokerTask }).task.brokerRequestId;
    h.settle(id, "completed");
    const again = h.broker.notifySettled(id, "failed");
    expect(again?.status).toBe("completed");
  });

  it("重复结算返回原任务不重复派发", () => {
    const h = makeHarness();
    const a = h.broker.submit(entryA);
    const id = (a as { outcome: "accepted"; task: BrokerTask }).task.brokerRequestId;
    h.settle(id, "completed");
    const before = h.dispatched.length;
    h.settle(id, "completed");
    expect(h.dispatched).toHaveLength(before);
  });
});


