import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { Agent, request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { basename } from "node:path";

export interface PairedClientOptions {
  baseUrl: string;
  /** 受信管理端为此客户端生成的 JSON 配对文件。 */
  tokenFile: string;
}

export class ExpressionClientError extends Error {}
export class BriefingClientError extends Error {}
export class ReminderClientError extends Error {}

const recurringReminderEndpoint = {
  scope: "reminder_recurring", path: "/v1/recurring-reminders", proofPurpose: "reminder-recurring",
  proofField: "recurringReminderProof", identity: "每日提醒", Error: ReminderClientError, postStatus: 200,
} as const;

const recurringReminderRescheduleEndpoint = {
  scope: "reminder_recurring_reschedule", path: "/v1/recurring-reminders/reschedule",
  proofPurpose: "reminder-recurring-reschedule", proofField: "recurringReminderRescheduleProof",
  identity: "每日提醒改期", Error: ReminderClientError, postStatus: 200,
} as const;

const endpoints = {
  expression: { scope: "express", path: "/v1/expressions/state", proofField: "expressionProof", label: "状态", identity: "表达", Error: ExpressionClientError, maxBytes: 1024, postStatus: 202 },
  briefing: { scope: "briefing_read", path: "/v1/briefing", proofField: "briefingProof", label: "简报", identity: "简报", Error: BriefingClientError, maxBytes: 32 * 1024, postStatus: 200 },
  reminder: { scope: "reminder_create", path: "/v1/reminders", proofField: "reminderProof", label: "提醒", identity: "提醒", Error: ReminderClientError, maxBytes: 1024, postStatus: 200 },
  // 兼容桌面编辑的正文，200 条各 512 个 UTF-16 码元，按每码元最多 6 字节 JSON 转义预留空间。
  "reminder-read": { scope: "reminder_read", path: "/v1/reminders/pending", proofField: "reminderReadProof", label: "查询提醒", identity: "提醒查询", Error: ReminderClientError, maxBytes: 640 * 1024, postStatus: 200 },
  "reminder-cancel": { scope: "reminder_cancel", path: "/v1/reminders/cancel", proofField: "reminderCancelProof", label: "取消提醒", identity: "提醒取消", Error: ReminderClientError, maxBytes: 1024, postStatus: 200 },
  "reminder-reschedule": { scope: "reminder_reschedule", path: "/v1/reminders/reschedule", proofField: "reminderRescheduleProof", label: "改期提醒", identity: "提醒改期", Error: ReminderClientError, maxBytes: 1024, postStatus: 200 },
  "recurring-reminder-create": { ...recurringReminderEndpoint, label: "创建每日提醒", maxBytes: 1024 },
  "recurring-reminder-list": { ...recurringReminderEndpoint, label: "查询每日提醒", maxBytes: 32 * 1024 },
  "recurring-reminder-cancel": { ...recurringReminderEndpoint, path: "/v1/recurring-reminders/cancel", label: "取消每日提醒", maxBytes: 1024 },
  "recurring-reminder-reschedule-targets": { ...recurringReminderRescheduleEndpoint, path: "/v1/recurring-reminders/reschedule/targets", label: "查询每日提醒改期目标", maxBytes: 32 * 1024 },
  "recurring-reminder-reschedule": { ...recurringReminderRescheduleEndpoint, label: "改期每日提醒", maxBytes: 1024 },
} as const;
type Endpoint = typeof endpoints[keyof typeof endpoints];

interface PairedCredential {
  instanceId: string;
  clientId: string;
  token: string;
}

function readCredential(path: string, endpoint: Endpoint): PairedCredential {
  try {
    const file = realpathSync(path);
    if (basename(file).toLowerCase() === "root-token") throw new Error();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 1024) throw new Error();
      const buffer = Buffer.alloc(1025);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      if (size > 1024 || size !== info.size) throw new Error();
      const value: unknown = JSON.parse(buffer.toString("utf8", 0, size));
      if (typeof value !== "object" || !value || Object.keys(value).length !== 3 ||
          !("instanceId" in value) || typeof value.instanceId !== "string" || !/^rt-[A-Za-z0-9_-]{12}$/.test(value.instanceId) ||
          !("clientId" in value) || typeof value.clientId !== "string" || !/^client-[0-9a-f]{12}$/.test(value.clientId) ||
          !("token" in value) || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error();
      return { instanceId: value.instanceId, clientId: value.clientId, token: value.token };
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new endpoint.Error(`需要可读的已配对 ${endpoint.scope} 凭证文件`);
  }
}

async function readJson(response: IncomingMessage, maxBytes: number, endpoint: Endpoint): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) throw new endpoint.Error("Runtime 响应过大");
    chunks.push(chunk);
  }
  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { /* 不向调用者转交原始响应内容。 */ }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) return result as Record<string, unknown>;
  throw new endpoint.Error(`Runtime ${endpoint.label}响应格式无效`);
}

async function call(endpoint: Endpoint, port: number, agent: Agent, signal: AbortSignal, path: string, headers: Record<string, string>,
  operation?: { socket: Socket; token: string; payload?: string }) {
  const { response, socket } = await new Promise<{ response: IncomingMessage; socket: Socket }>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, method: operation?.payload === undefined ? "GET" : "POST",
      path, headers, agent, signal,
    }, (response) => resolve({ response, socket: response.socket }));
    req.once("error", reject);
    req.once("socket", (assigned) => {
      if (operation) {
        if (assigned !== operation.socket || assigned.destroyed) {
          req.destroy(new endpoint.Error(`无法验证 Runtime 的${endpoint.identity}身份`));
          return;
        }
        // 不预置 Authorization；仅在已完成挑战的 socket 分配给此请求后添加。
        req.setHeader("authorization", `Bearer ${operation.token}`);
      }
      req.end(operation?.payload);
    });
  });
  if (response.statusCode !== (operation?.payload === undefined ? 200 : endpoint.postStatus)) {
    response.destroy();
    throw new endpoint.Error(`Runtime 拒绝${endpoint.label}请求 (HTTP ${response.statusCode})`);
  }
  return { body: await readJson(response, operation ? endpoint.maxBytes : 1024, endpoint), socket };
}

/** 只在相应能力的挑战通过后，在同一个 socket 上发送配对凭证。 */
export function createPairedTransport(purpose: keyof typeof endpoints, options: PairedClientOptions) {
  const endpoint = endpoints[purpose];
  const proofPurpose = "proofPurpose" in endpoint ? endpoint.proofPurpose : purpose;
  const portText = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(options.baseUrl)?.[1];
  if (!portText || Number(portText) > 65535) {
    throw new endpoint.Error("Runtime 地址必须为 http://127.0.0.1:<port>");
  }
  const port = Number(portText);
  const { token, clientId, instanceId } = readCredential(options.tokenFile, endpoint);
  const key = createHash("sha256").update(token).digest();
  return async function exchange(signal?: AbortSignal, payload?: string): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(2000);
    const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    try {
      const challenge = randomBytes(32).toString("base64url");
      const health = await call(endpoint, port, agent, deadline, "/v1/health", {
        [`x-maneki-${proofPurpose}-client`]: clientId, [`x-maneki-${proofPurpose}-challenge`]: challenge,
      });
      const proof = health.body[endpoint.proofField];
      const expected = createHmac("sha256", key)
        .update(JSON.stringify([`maneki-${proofPurpose}-proof-v1`, clientId, challenge, instanceId, port])).digest();
      if (health.body.protocolVersion !== 1 || health.body.instanceId !== instanceId ||
          typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof) || !timingSafeEqual(expected, Buffer.from(proof, "hex"))) {
        throw new endpoint.Error(`无法验证 Runtime 的${endpoint.identity}身份`);
      }
      const result = await call(endpoint, port, agent, deadline, endpoint.path, { "content-type": "application/json" }, {
        socket: health.socket, token, ...(payload === undefined ? {} : { payload }),
      });
      return result.body;
    } catch (error) {
      if (error instanceof endpoint.Error) throw error;
      if (signal?.aborted) throw new endpoint.Error(`${endpoint.label}请求已取消`);
      if (timeout.aborted) throw new endpoint.Error(`Runtime ${endpoint.label}请求超时`);
      throw new endpoint.Error("Runtime 连接失败");
    } finally {
      agent.destroy();
    }
  };
}
