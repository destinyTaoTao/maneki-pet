import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DailyQuotaPolicy } from "@maneki-pet/core";

import type { RuntimeStore } from "./store.js";
import { validateObject } from "./validate.js";

export interface RuntimeLimitsConfig {
  schemaVersion: 1;
  limits: {
    proactiveDailyTokenLimit: number;
    interactiveDailyTokenLimit: number | null;
    maxNotificationsPerHour: number;
  };
}

export const defaultRuntimeConfig: RuntimeLimitsConfig = {
  schemaVersion: 1,
  limits: {
    proactiveDailyTokenLimit: 100_000,
    interactiveDailyTokenLimit: null,
    maxNotificationsPerHour: 30,
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 有版本的配置 Schema（§6.2）：未知字段拒绝，新版本配置不交给旧程序盲写。 */
export function loadRuntimeConfig(configDir: string): { config: RuntimeLimitsConfig; configPath: string; created: boolean } {
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(defaultRuntimeConfig, null, 2), "utf8");
    return { config: defaultRuntimeConfig, configPath, created: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new ConfigError(`config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("config.json must be a JSON object");
  }
  const container = parsed as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    if (key !== "schemaVersion" && key !== "limits") {
      throw new ConfigError(`unknown config field "${key}"`);
    }
  }
  if (container.schemaVersion !== 1) {
    throw new ConfigError(`config schemaVersion ${String(container.schemaVersion)} is not supported (need 1); refusing to run`);
  }
  // null 表示"交互总额关闭"，与缺省字段等价；先归一为缺省再校验。
  const limitsInput = { ...((container.limits ?? {}) as Record<string, unknown>) };
  if (limitsInput.interactiveDailyTokenLimit === null) {
    delete limitsInput.interactiveDailyTokenLimit;
  }
  const limitsChecked = validateObject(limitsInput, {
    proactiveDailyTokenLimit: { type: "number", required: true, min: 1 },
    interactiveDailyTokenLimit: { type: "number", required: false, min: 1 },
    maxNotificationsPerHour: { type: "number", required: true, min: 1, max: 1000 },
  });
  if (!limitsChecked.ok) {
    throw new ConfigError(`invalid limits in config: ${limitsChecked.reason}`);
  }
  const limits = limitsChecked.value as { proactiveDailyTokenLimit: number; interactiveDailyTokenLimit?: number; maxNotificationsPerHour: number };
  const config: RuntimeLimitsConfig = {
    schemaVersion: 1,
    limits: {
      proactiveDailyTokenLimit: limits.proactiveDailyTokenLimit,
      interactiveDailyTokenLimit: limits.interactiveDailyTokenLimit ?? null,
      maxNotificationsPerHour: limits.maxNotificationsPerHour,
    },
  };
  return { config, configPath, created: false };
}

export class NotificationBudget {
  private readonly fireTimes: number[] = [];

  constructor(private readonly maxPerHour: number) {}

  canSend(nowMs: number): { allowed: true } | { allowed: false; reason: string } {
    this.prune(nowMs);
    if (this.fireTimes.length >= this.maxPerHour) {
      return { allowed: false, reason: `notification budget exceeded: ${this.fireTimes.length} >= ${this.maxPerHour} per hour` };
    }
    return { allowed: true };
  }

  record(nowMs: number): void {
    this.fireTimes.push(nowMs);
    this.prune(nowMs);
  }

  usedThisHour(nowMs: number): number {
    this.prune(nowMs);
    return this.fireTimes.length;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - 3_600_000;
    for (let index = this.fireTimes.length - 1; index >= 0; index -= 1) {
      if ((this.fireTimes[index] ?? 0) < cutoff) {
        this.fireTimes.splice(index, 1);
      }
    }
  }
}

export interface LimitsView {
  dayKey: string;
  proactive: { limit: number; used: number; remaining: number };
  interactive: { limit: number; used: number; remaining: number } | null;
  meteringHealthy: boolean;
  notifications: { maxPerHour: number; usedThisHour: number };
}

export function limitsView(config: RuntimeLimitsConfig, policy: DailyQuotaPolicy, store: RuntimeStore, notifications: NotificationBudget): LimitsView {
  const dayKey = policy.dayKey();
  const used = store.quotaTotal(dayKey);
  const view: LimitsView = {
    dayKey,
    proactive: {
      limit: config.limits.proactiveDailyTokenLimit,
      used,
      remaining: Math.max(0, config.limits.proactiveDailyTokenLimit - used),
    },
    interactive: null,
    meteringHealthy: policy.meteringUnhealthyReason === null,
    notifications: {
      maxPerHour: config.limits.maxNotificationsPerHour,
      usedThisHour: notifications.usedThisHour(Date.now()),
    },
  };
  if (config.limits.interactiveDailyTokenLimit !== null) {
    view.interactive = {
      limit: config.limits.interactiveDailyTokenLimit,
      used,
      remaining: Math.max(0, config.limits.interactiveDailyTokenLimit - used),
    };
  }
  return view;
}
