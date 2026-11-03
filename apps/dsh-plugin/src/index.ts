import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { DshAdapter, type DshSessionEvent } from "@maneki-pet/adapter-dsh";
import type { HarnessEvent, PetState } from "@maneki-pet/core";

/** 仅使用已安装 dsh 的事件订阅面，无运行时宿主依赖或执行钩子。 */
export interface DshPluginContext {
  on(event: "session/event", listener: (session: { id: string }, event: DshSessionEvent["event"]) => void): () => void;
  on(event: "dispose", listener: () => Promise<void>): () => void;
}

export interface Config {
  baseUrl?: string;
  tokenFile?: string;
}

export const name = "maneki-observer";
export const inject = ["sessions"];

/** 观察首版：任务与审批由 dsh 原生界面负责，插件只续租表现状态。 */
export async function apply(ctx: DshPluginContext, config: Config = {}): Promise<void> {
  const base = new URL(config.baseUrl ?? process.env.MANEKI_RUNTIME_URL ?? "http://127.0.0.1:18100");
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Maneki Runtime 地址必须为 http://127.0.0.1:<port>");
  }
  const tokenFile = config.tokenFile ?? process.env.MANEKI_TOKEN_FILE;
  if (!tokenFile) throw new Error("请先配对 express 凭证并设置 MANEKI_TOKEN_FILE");
  if (statSync(tokenFile).size > 1024) throw new Error("Maneki 客户端凭证文件过大");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("Maneki 客户端凭证格式无效");
  const sourceId = randomUUID();
  const endpoint = new URL("/v1/expressions/state", base).href;
  const controller = new AbortController();
  const sessions = new Map<string, PetState>();
  let pulse: PetState = "idle";
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let dirty = false;
  let pending: Promise<void> | undefined;
  let online: boolean | undefined;

  const current = (): PetState => {
    const states = new Set(sessions.values());
    return (["waiting_input", "working", "thinking"] as const).find((state) => states.has(state)) ?? pulse;
  };
  const post = async (state: PetState, signal: AbortSignal): Promise<void> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sourceId, state }),
      signal,
      redirect: "error",
    });
    await response.body?.cancel();
    if (response.status !== 202) throw new Error("expression state unavailable");
  };
  const send = (): void => {
    if (closed) return;
    dirty = true;
    if (pending) return;
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false;
        try {
          await post(current(), AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]));
          if (online === false) console.error("[maneki] 已恢复共享 Runtime 状态联动");
          online = true;
        } catch {
          if (closed) return;
          if (online !== false) console.error("[maneki] Runtime 不可用或凭证失效，状态联动暂不可用；dsh 继续运行");
          online = false;
          // 断线后只保留活动状态，不在重连时重放过时的完成/失败动画。
          clearTimeout(pulseTimer);
          pulse = "idle";
        }
      }
    })().finally(() => {
      pending = undefined;
      if (dirty && !closed) send();
    });
  };
  const observe = (event: HarnessEvent): void => {
    const payload = event.payload;
    switch (payload.type) {
      case "task.started":
      case "session.busy": {
        if (!sessions.has(event.sessionId) && sessions.size >= 64) return;
        const state = payload.type === "session.busy" ? payload.state === "waiting" ? "waiting_input" : payload.state : "working";
        sessions.set(event.sessionId, state);
        break;
      }
      case "task.completed":
      case "task.error":
      case "task.cancelled":
        sessions.delete(event.sessionId);
        clearTimeout(pulseTimer);
        pulse = payload.type === "task.completed" ? "celebrating" : payload.type === "task.error" ? "error" : "idle";
        pulseTimer = setTimeout(() => { pulse = "idle"; send(); }, 3_000);
        pulseTimer.unref();
        break;
      default: return;
    }
    send();
  };
  const adapter = new DshAdapter({
    eventSource: {
      subscribe: (listener) => ctx.on("session/event", (session, event) => listener({ sessionId: session.id, event })),
    },
  });
  const stop = await adapter.subscribe(observe, {
    requestId: sourceId,
    signal: controller.signal,
    deadlineAtMs: Date.now() + 10_000,
  });
  const heartbeat = setInterval(send, 5_000);
  heartbeat.unref();
  ctx.on("dispose", async () => {
    closed = true;
    stop();
    clearInterval(heartbeat);
    clearTimeout(pulseTimer);
    controller.abort();
    await pending;
    sessions.clear();
    try { await post("idle", AbortSignal.timeout(2_000)); } catch { /* 失联时由 Runtime 的 15 秒租约回收。 */ }
  });
  send();
}
