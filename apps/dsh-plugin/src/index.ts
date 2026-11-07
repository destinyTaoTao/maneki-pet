import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { DshAdapter, type DshSessionEvent } from "@maneki-pet/adapter-dsh";
import type { HarnessEvent, PetState } from "@maneki-pet/core";
import { controlAssistant, type ControlAction } from "./assistant-control.js";

/** 仅使用已安装 dsh 的事件订阅面，无运行时宿主依赖或执行钩子。 */
export interface DshPluginContext {
  on(event: "session/event", listener: (session: { id: string }, event: DshSessionEvent["event"]) => void): () => void;
  on(event: "dispose", listener: () => Promise<void>): () => void;
  commands: { register(definition: { name: string; description: string; input: { hint: string }; recordInput: boolean; handler(invocation: { rawInput: string; signal: AbortSignal }): Promise<{ kind: "success" | "error"; text: string }> }): () => void };
}

export interface Config {
  baseUrl?: string;
  tokenFile?: string;
  profileId?: string;
  showOnConnect?: boolean;
}

export const name = "maneki-observer";
export const inject = ["sessions", "commands"];

/** 观察首版：任务与审批由 dsh 原生界面负责，插件只续租表现状态。 */
export async function apply(ctx: DshPluginContext, config: Config = {}): Promise<void> {
  const base = new URL(config.baseUrl ?? process.env.MANEKI_RUNTIME_URL ?? "http://127.0.0.1:18100");
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Maneki Runtime 地址必须为 http://127.0.0.1:<port>");
  }
  const tokenFile = config.tokenFile ?? process.env.MANEKI_TOKEN_FILE;
  const managed = !tokenFile && !config.baseUrl && !process.env.MANEKI_RUNTIME_URL;
  const profileId = config.profileId ?? "web";
  if (typeof profileId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId)) throw new Error("profileId 格式无效");
  if (config.showOnConnect !== undefined && typeof config.showOnConnect !== "boolean") throw new Error("showOnConnect 必须为布尔值");
  let token: string | undefined;
  if (!managed) {
    if (!tokenFile) throw new Error("手工观察配置必须提供独立 express 凭证文件");
    if (statSync(tokenFile).size > 1024) throw new Error("Maneki 客户端凭证文件过大");
    token = readFileSync(tokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("Maneki 客户端凭证格式无效");
  }
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
  let controlPending: Promise<void> | undefined;

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
    if (closed || !token) return;
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
  const manage = async (action: ControlAction, signal: AbortSignal): Promise<string> => {
    if (!managed) throw new Error("手工观察模式仅联动状态；切换到原生管理配对后可使用此命令");
    if (closed || signal.aborted) throw new Error("操作已取消");
    const result = await controlAssistant(action, profileId, AbortSignal.any([controller.signal, signal]));
    if (closed) return "插件已停用";
    if (action === "connect" || action === "pair") {
      token = result.token;
      online = undefined;
      send();
      if (config.showOnConnect !== false) await controlAssistant("show", profileId, AbortSignal.any([controller.signal, signal]));
      return "已连接共享助手；仅启用 dsh 状态观察，对话与工程派发尚未开放";
    }
    if (action === "quit") {
      token = undefined;
      sessions.clear();
      clearTimeout(pulseTimer);
      pulse = "idle";
      return "助理后台已停止；外部 dsh 任务可能继续，未被取消。重新启用请执行 /maneki connect";
    }
    return action === "assistant" ? "已请求打开文字助手与待办提醒面板；dsh 插件仍只持有观察权限" : action === "show" ? "已请求显示小招" : result.state === "ready" ? "助理后台正在运行" : "助理后台已停止";
  };
  const runControl = async (action: ControlAction, signal: AbortSignal): Promise<string> => {
    if (controlPending) throw new Error("另一个助手管理操作正在进行，请稍后重试");
    let text = "";
    controlPending = manage(action, signal).then((result) => { text = result; });
    try { await controlPending; return text; } finally { controlPending = undefined; }
  };
  const unregister = ctx.commands.register({
    name: "maneki", description: "连接、配对、打开文字助手或退出小招", input: { hint: "status | connect | pair | show | assistant | quit" }, recordInput: false,
    handler: async ({ rawInput, signal }) => {
      const action = rawInput.trim() || "status";
      if (!["status", "connect", "pair", "show", "assistant", "quit"].includes(action)) return { kind: "error", text: "用法：/maneki status|connect|pair|show|assistant|quit" };
      try { return { kind: "success", text: await runControl(action as ControlAction, signal) }; }
      catch (error) { return { kind: "error", text: error instanceof Error ? error.message : "助手管理操作失败" }; }
    },
  });
  ctx.on("dispose", async () => {
    closed = true;
    unregister();
    stop();
    clearInterval(heartbeat);
    clearTimeout(pulseTimer);
    controller.abort();
    await controlPending?.catch(() => undefined);
    await pending;
    sessions.clear();
    if (token) try { await post("idle", AbortSignal.timeout(2_000)); } catch { /* 失联时由 Runtime 的 15 秒租约回收。 */ }
  });
  if (managed) void runControl("connect", controller.signal).catch((error) => { if (!closed) console.error(`[maneki] ${error instanceof Error ? error.message : "助手不可用"}；dsh 继续运行`); });
  else send();
}
