import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DailyQuotaPolicy } from "@maneki-pet/core";

import type { RuntimeStore } from "./store.js";
import { validateObject } from "./validate.js";

export interface ExternalMemoryConfigFile {
  command: string;
  args?: string[];
  searchTool?: string;
  writeTool?: string;
  providerId?: string;
}

export interface DshGatewayConfigFile {
  baseUrl: string;
  token: string;
}

export interface BrokerConfigFile {
  maxRunningPerWorkdir?: number;
  maxQueuedPerWorkdir?: number;
}

export interface RuntimeLimitsConfig {
  schemaVersion: 1;
  limits: {
    proactiveDailyTokenLimit: number;
    interactiveDailyTokenLimit: number | null;
    maxNotificationsPerHour: number;
  };
  /** 可选：外挂记忆服务的 stdio 启动配置（票据 #46）；缺省不接入。 */
  externalMemory?: ExternalMemoryConfigFile;
  /** 可选：dsh web 网关派发（M2b）；缺省不派发。token 属于凭证，正式部署应迁移安全存储。 */
  dsh?: DshGatewayConfigFile;
  broker?: BrokerConfigFile;
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
    if (key !== "schemaVersion" && key !== "limits" && key !== "externalMemory" && key !== "dsh" && key !== "broker") {
      throw new ConfigError(`unknown config field "${key}"`);
    }
  }
  if (container.schemaVersion !== 1) {
    throw new ConfigError(`config schemaVersion ${String(container.schemaVersion)} is not supported (need 1); refusing to run`);
  }
  const externalMemory = parseExternalMemoryConfig(container.externalMemory);
  const dsh = parseDshConfig(container.dsh);
  const broker = parseBrokerConfig(container.broker);
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
    ...(externalMemory ? { externalMemory } : {}),
    ...(dsh ? { dsh } : {}),
    ...(broker ? { broker } : {}),
  };
  return { config, configPath, created: false };
}

function parseDshConfig(raw: unknown): DshGatewayConfigFile | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("dsh must be an object");
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["baseUrl", "token"].includes(key)) {
      throw new ConfigError(`unknown dsh field "${key}"`);
    }
  }
  if (typeof input.baseUrl !== "string" || !/^https?:\/\//.test(input.baseUrl) || input.baseUrl.length > 300) {
    throw new ConfigError("dsh.baseUrl must be an http(s) URL (<= 300 chars)");
  }
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 300) {
    throw new ConfigError("dsh.token must be a non-empty string (<= 300 chars)");
  }
  return { baseUrl: input.baseUrl, token: input.token };
}

function parseBrokerConfig(raw: unknown): BrokerConfigFile | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const checked = validateObject(raw, {
    maxRunningPerWorkdir: { type: "number", required: false, min: 1, max: 8 },
    maxQueuedPerWorkdir: { type: "number", required: false, min: 1, max: 64 },
  });
  if (!checked.ok) {
    throw new ConfigError(`invalid broker config: ${checked.reason}`);
  }
  const value = checked.value as { maxRunningPerWorkdir?: number; maxQueuedPerWorkdir?: number };
  const result: BrokerConfigFile = {};
  if (value.maxRunningPerWorkdir !== undefined) {
    result.maxRunningPerWorkdir = value.maxRunningPerWorkdir;
  }
  if (value.maxQueuedPerWorkdir !== undefined) {
    result.maxQueuedPerWorkdir = value.maxQueuedPerWorkdir;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseExternalMemoryConfig(raw: unknown): ExternalMemoryConfigFile | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("externalMemory must be an object");
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["command", "args", "searchTool", "writeTool", "providerId"].includes(key)) {
      throw new ConfigError(`unknown externalMemory field "${key}"`);
    }
  }
  if (typeof input.command !== "string" || input.command.trim().length === 0 || input.command.length > 2000) {
    throw new ConfigError('externalMemory.command must be a non-empty string (<= 2000 chars)');
  }
  let args: string[] | undefined;
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string" || arg.length > 2000)) {
      throw new ConfigError("externalMemory.args must be an array of strings (each <= 2000 chars)");
    }
    args = input.args as string[];
  }
  for (const field of ["searchTool", "writeTool", "providerId"] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 100)) {
      throw new ConfigError(`externalMemory.${field} must be a non-empty string (<= 100 chars)`);
    }
  }
  return {
    command: input.command,
    ...(args ? { args } : {}),
    ...(input.searchTool !== undefined ? { searchTool: input.searchTool as string } : {}),
    ...(input.writeTool !== undefined ? { writeTool: input.writeTool as string } : {}),
    ...(input.providerId !== undefined ? { providerId: input.providerId as string } : {}),
  };
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
