import { describe, expect, it, vi } from "vitest";

import {
  ProactiveEngine,
  defaultProactiveConfig,
  type PhrasingProvider,
  type ProactiveChannelState,
} from "../src/index.js";

const fallbackCopy = {
  murmur: "喵？有空看看你的任务列表哦",
  daily_briefing: "今日简报来了",
};

function makeClock() {
  let currentMs = Date.UTC(2026, 9, 31, 10, 0, 0);
  return {
    clock: () => new Date(currentMs),
    advanceMs: (ms: number) => {
      currentMs += ms;
    },
  };
}

const channelsOn: ProactiveChannelState = { bubble: true, notification: true, tts: false };
const channelsOff: ProactiveChannelState = { bubble: false, notification: false, tts: false };

function makeEngine(overrides?: {
  channels?: () => ProactiveChannelState;
  dnd?: () => boolean;
  phrasing?: PhrasingProvider;
}) {
  const { clock, advanceMs } = makeClock();
  const engine = new ProactiveEngine({
    clock,
    channels: overrides?.channels ?? (() => channelsOn),
    dnd: overrides?.dnd ?? (() => false),
    ...(overrides?.phrasing ? { phrasing: overrides.phrasing } : {}),
    fallbackCopy,
  });
  return { engine, advanceMs };
}

describe("ProactiveEngine 碎碎念触发（确定性规则）", () => {
  it("空闲达到阈值且有可用通道时触发", () => {
    const { engine } = makeEngine();
    expect(engine.evaluateMurmur({ idleMs: 46 * 60 * 1000 })).toEqual({ fire: true });
  });

  it("未达空闲阈值不触发", () => {
    const { engine } = makeEngine();
    expect(engine.evaluateMurmur({ idleMs: 10 * 60 * 1000 })).toEqual({ fire: false, reason: "no-trigger" });
  });

  it("类别单独关闭时不触发", () => {
    const { clock } = makeClock();
    const engine = new ProactiveEngine({
      clock,
      config: { ...defaultProactiveConfig, murmur: { enabled: false, idleThresholdMs: 1000 } },
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateMurmur({ idleMs: 9999 })).toEqual({ fire: false, reason: "disabled" });
  });

  it("勿扰内完全静默，且触发决策不咨询 LLM", () => {
    const phrasing: PhrasingProvider = { phrase: vi.fn(async () => "llm") };
    const { engine } = makeEngine({ dnd: () => true, phrasing });
    expect(engine.evaluateMurmur({ idleMs: 3_600_000 })).toEqual({ fire: false, reason: "dnd" });
    expect(phrasing.phrase).not.toHaveBeenCalled();
  });

  it("所有通道关闭时不触发", () => {
    const { engine } = makeEngine({ channels: () => channelsOff });
    expect(engine.evaluateMurmur({ idleMs: 3_600_000 })).toEqual({ fire: false, reason: "no-channel" });
  });

  it("预算：minInterval 内不重复触发，间隔过后恢复", () => {
    const { engine, advanceMs } = makeEngine();
    expect(engine.evaluateMurmur({ idleMs: 3_600_000 })).toEqual({ fire: true });
    engine.noteMurmurFired();
    expect(engine.evaluateMurmur({ idleMs: 3_600_000 })).toEqual({ fire: false, reason: "budget" });
    advanceMs(2 * 60 * 60 * 1000 + 1);
    expect(engine.evaluateMurmur({ idleMs: 3_600_000 })).toEqual({ fire: true });
  });

  it("预算：小时窗口内超过次数上限不触发", () => {
    const { clock } = makeClock();
    const engine = new ProactiveEngine({
      clock,
      config: {
        ...defaultProactiveConfig,
        murmurBudget: { minIntervalMs: 0, maxPerHour: 2 },
      },
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    engine.noteMurmurFired();
    engine.noteMurmurFired();
    expect(engine.evaluateMurmur({ idleMs: 3_600_000 })).toEqual({ fire: false, reason: "budget" });
  });
});

describe("ProactiveEngine 话术生成（LLM 只写话术）", () => {
  it("LLM 可用时使用生成话术", async () => {
    const phrasing: PhrasingProvider = { phrase: vi.fn(async () => "今天也要加油喵") };
    const { engine } = makeEngine({ phrasing });
    await expect(engine.compose("murmur", ["3 个任务进行中"])).resolves.toBe("今天也要加油喵");
  });

  it("LLM 失败回退固定文案，不阻塞触发流程", async () => {
    const phrasing: PhrasingProvider = {
      phrase: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const { engine } = makeEngine({ phrasing });
    await expect(engine.compose("murmur")).resolves.toBe(fallbackCopy.murmur);
  });

  it("未配置 LLM 时直接使用固定文案", async () => {
    const { engine } = makeEngine();
    await expect(engine.compose("murmur")).resolves.toBe(fallbackCopy.murmur);
  });
});

describe("主动性出厂默认", () => {
  it("碎碎念默认低频开启，每日简报默认关闭", () => {
    expect(defaultProactiveConfig.murmur.enabled).toBe(true);
    expect(defaultProactiveConfig.murmurBudget.minIntervalMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(defaultProactiveConfig.daily_briefing.enabled).toBe(false);
  });
});
