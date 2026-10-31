/**
 * 桌宠 Shell ↔ 共享 Runtime 客户端（#43/#44 的 Shell 侧）：
 * 健康发现 →（必要时）拉起 sidecar → root 配对（受信 Shell，同信任域）
 * → WS 一次性票据订阅事件流；托盘勿扰 ⇄ /v1/dnd 双向同步。
 * 令牌仅存于 Shell WebView 的 localStorage（与 Shell 同信任域，§7.1）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const RUNTIME_PORT = 18100;
const BASE = `http://127.0.0.1:${RUNTIME_PORT}`;
const CLIENT_TOKEN_KEY = "maneki.clientToken";
const RECONNECT_MS = 3_000;

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
  try {
    await invoke("spawn_runtime");
  } catch {
    // sidecar 缺失等错误：继续轮询确认，最终如实返回不可用。
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await checkHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function pairIfNeeded(): Promise<string> {
  const saved = localStorage.getItem(CLIENT_TOKEN_KEY);
  if (saved) {
    const probe = await fetchJson("/v1/limits", { headers: authHeaders(saved) });
    if (probe.status === 200) return saved;
    localStorage.removeItem(CLIENT_TOKEN_KEY);
  }
  const root = await invoke<string>("read_root_token");
  const pair = await fetchJson("/v1/pair", {
    method: "POST",
    headers: authHeaders(root),
    body: JSON.stringify({ name: "desktop-shell", scopes: "express,notify" }),
  });
  if (pair.status !== 200) {
    throw new Error(`runtime pairing failed: ${pair.status}`);
  }
  const token = (pair.body as { token: string }).token;
  localStorage.setItem(CLIENT_TOKEN_KEY, token);
  return token;
}

export async function getDnd(token: string): Promise<boolean> {
  const { body } = await fetchJson("/v1/dnd", { headers: authHeaders(token) });
  return (body as { enabled?: boolean })?.enabled === true;
}

export async function setDnd(token: string, enabled: boolean): Promise<void> {
  await fetchJson("/v1/dnd", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ enabled }),
  });
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
export async function watchTrayDnd(token: string): Promise<() => void> {
  return listen<boolean>("maneki://dnd-changed", (event) => {
    void setDnd(token, event.payload).catch(() => undefined);
  });
}
