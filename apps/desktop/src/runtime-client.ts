/**
 * 桌宠 Shell ↔ 共享 Runtime 客户端（#43/#44 的 Shell 侧）：
 * 健康发现 →（必要时）拉起 sidecar → native 配对（WebView 不接触 root）
 * → WS 一次性票据订阅事件流；托盘勿扰 ⇄ /v1/dnd 双向同步。
 * 客户端令牌由 native 管理入口保存，WebView 仅在内存持有。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { uiText } from "./ui-text";

const RUNTIME_PORT = 18100;
const BASE = `http://127.0.0.1:${RUNTIME_PORT}`;
const CLIENT_TOKEN_KEY = "maneki.clientToken";
const RECONNECT_MS = 3_000;
let confirmedDnd: boolean | undefined;

export interface RuntimeInfo {
  port: number;
  configDir: string;
}

export interface LimitsView {
  dayKey: string;
  proactive: { limit: number; used: number; remaining: number };
  interactive: { limit: number; used: number; remaining: number } | null;
  meteringHealthy: boolean;
  notifications: { maxPerHour: number; usedThisHour: number };
}

export interface RuntimeEvent {
  eventId: string;
  occurredAt: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RuntimeSession {
  token: string;
  close(): void;
}

async function fetchJson(
  path: string,
  init: RequestInit = {},
  timeoutMs = 3_000,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => null)) as unknown;
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const { status } = await fetchJson("/v1/health", {}, 1_500);
    return status === 200;
  } catch {
    return false;
  }
}

/** 健康发现失败时经 Rust 命令拉起 sidecar，再轮询就绪。 */
export async function ensureRuntime(): Promise<boolean> {
  if (await checkHealth()) return true;
  await invoke("spawn_runtime");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await checkHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function pairIfNeeded(): Promise<string> {
  localStorage.removeItem(CLIENT_TOKEN_KEY);
  return invoke<string>("desktop_client_token");
}

export async function getDnd(token: string): Promise<boolean> {
  const { status, body } = await fetchJson("/v1/dnd", { headers: authHeaders(token) });
  if (status !== 200 || typeof (body as { enabled?: unknown })?.enabled !== "boolean") throw new Error(`${uiText.dndSyncFailure}（HTTP ${status}）`);
  confirmedDnd = (body as { enabled: boolean }).enabled;
  return confirmedDnd;
}

export async function getExpressionState(token: string): Promise<unknown> {
  const { status, body } = await fetchJson("/v1/expressions/state", { headers: authHeaders(token) });
  if (status !== 200) throw new Error("expression snapshot unavailable");
  return (body as { state?: unknown })?.state;
}

export async function setDnd(token: string, enabled: boolean): Promise<void> {
  const { status, body } = await fetchJson("/v1/dnd", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ enabled }),
  });
  if (status !== 200 || (body as { enabled?: unknown })?.enabled !== enabled) throw new Error(`${uiText.dndSyncFailure}（HTTP ${status}）`);
  confirmedDnd = enabled;
}

export async function getLimits(token: string): Promise<LimitsView> {
  const { body } = await fetchJson("/v1/limits", { headers: authHeaders(token) });
  return body as LimitsView;
}

async function issueWsTicket(token: string): Promise<string> {
  const { body } = await fetchJson("/v1/ws-ticket", { method: "POST", headers: authHeaders(token) });
  return (body as { ticket: string }).ticket;
}

/** 订阅事件流：断线自动重连（有界退避），重连后重新取票据认证。 */
export async function connectEvents(
  token: string,
  onEvent: (event: RuntimeEvent) => void,
  onStateChange?: (connected: boolean) => void,
): Promise<() => void> {
  let closed = false;
  let socket: WebSocket | undefined;

  const open = async (): Promise<void> => {
    while (!closed) {
      const connected = await new Promise<boolean>((resolve) => {
        void (async () => {
          try {
            const ticket = await issueWsTicket(token);
            const ws = new WebSocket(`ws://127.0.0.1:${RUNTIME_PORT}/v1/events`);
            let authed = false;
            const failTimer = setTimeout(() => resolve(false), 4_000);
            ws.addEventListener("open", () => {
              ws.send(JSON.stringify({ type: "auth", ticket }));
            });
            ws.addEventListener("message", (event) => {
              const message = JSON.parse(event.data as string) as Record<string, unknown>;
              if (!authed) {
                if (message.type === "ready") {
                  authed = true;
                  clearTimeout(failTimer);
                  socket = ws;
                  onStateChange?.(true);
                  resolve(true);
                }
                return;
              }
              if (message.type === "event") {
                onEvent(message.event as RuntimeEvent);
              }
            });
            ws.addEventListener("close", () => {
              clearTimeout(failTimer);
              if (socket === ws) socket = undefined;
              if (!authed) resolve(false);
              else onStateChange?.(false);
            });
            ws.addEventListener("error", () => {
              clearTimeout(failTimer);
              if (!authed) resolve(false);
            });
          } catch {
            resolve(false);
          }
        })();
      });
      if (closed) return;
      if (connected) {
        // 连接存续：等待关闭后重连。
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (closed || socket === undefined) {
              clearInterval(timer);
              resolve();
            }
          }, 300);
        });
      }
      if (closed) return;
      onStateChange?.(false);
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  };
  void open();

  return () => {
    closed = true;
    socket?.close();
  };
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return invoke<RuntimeInfo>("runtime_info");
}

/** 托盘勿扰开关 ⇄ Runtime：托盘变更事件转写为 /v1/dnd。 */
export async function watchTrayDnd(token: string, onError: (error: unknown) => void): Promise<() => void> {
  let pending = Promise.resolve();
  return listen<boolean>("maneki://dnd-changed", (event) => {
    // 同一托盘的连续点击按顺序提交；失败恢复最后一次已确认状态。
    pending = pending.then(async () => {
      try {
        await setDnd(token, event.payload);
        await invoke("sync_tray_dnd", { enabled: confirmedDnd });
      } catch (error) {
        if (confirmedDnd !== undefined) await invoke("sync_tray_dnd", { enabled: confirmedDnd }).catch(() => undefined);
        onError(error);
      }
    });
  });
}
