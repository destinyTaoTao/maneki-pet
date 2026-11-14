import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CompanionClient } from "../../../apps/desktop/src/companion-client.js";
import { AssistantClientError } from "../../../apps/desktop/src/assistant-client.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

// 默认跳过；显式启用时会运行两个多小时，使用临时数据库和回环地址。
it.skipIf(process.env.MANEKI_REAL_WARMUP !== "1")("实际两小时暖机后通过真实 WS 展示一次自动模板", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-real-warmup-"));
  const notify = vi.fn().mockResolvedValue({ status: "accepted" });
  const runtime = await startFetchCompatibleRuntime({ configDir: dir, notifier: { notify } });
  const base = `http://127.0.0.1:${runtime.port}`;
  let socket: WebSocket | undefined;
  let client: CompanionClient | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = async (path: string, token: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const paired = await call("/v1/pair", runtime.rootToken, { name: "warmup-isolated", scopes: "assistant,settings" });
    expect(paired.status).toBe(200);
    const token = paired.body.token as string;
    const ticket = (await call("/v1/ws-ticket", token, {})).body.ticket;
    socket = new WebSocket(base.replace("http", "ws") + "/v1/events");
    const rendered: Array<{ mode: string; createdAt: number }> = [];
    let resolveShown: () => void = () => undefined;
    const shown = new Promise<void>(resolve => { resolveShown = resolve; });
    const ready = new Promise<Record<string, any>>((resolve, reject) => {
      socket!.addEventListener("open", () => socket!.send(JSON.stringify({ type: "auth", ticket })));
      socket!.addEventListener("error", () => reject(Error("isolated websocket failed")));
      socket!.addEventListener("message", event => {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") resolve(message);
        else if (message.type === "event") client?.onEvent(message.event);
      });
    });
    const readyValue = await ready;
    client = new CompanionClient({
      call: async (path, body) => { const result = await call(`/v1/assistant${path}`, token, body); if (result.status !== 200) throw new AssistantClientError(String(result.body.error), result.status); return result.body; },
      show: utterance => { rendered.push(utterance); resolveShown(); return true; },
      beforeShow: async () => true, reconnect: () => {}, wallNow: Date.now, monoNow: () => performance.now(),
    });
    client.setDisplayState({ visible: true, busyReasons: [], activitySeq: 0 });
    await client.connected(readyValue);
    expect(client.isReady()).toBe(true);
    const budget = JSON.parse(runtime.store.assistantStore().get("companion.budget")!);
    const firstEligibleAt = budget.firstEligibleAt as number;
    expect(Number.isSafeInteger(firstEligibleAt)).toBe(true);
    expect(rendered).toHaveLength(0);
    console.log(`REAL_WARMUP_READY start=${new Date(firstEligibleAt).toISOString()} target=${new Date(firstEligibleAt + 7200000).toISOString()}`);
    await Promise.race([shown, new Promise<never>((_, reject) => { abortTimer = setTimeout(() => reject(Error("real warmup deadline exceeded")), 7260000); })]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.mode).toBe("automatic");
    expect(rendered[0]!.createdAt - firstEligibleAt).toBeGreaterThanOrEqual(7200000);
    const finalBudget = JSON.parse(runtime.store.assistantStore().get("companion.budget")!);
    expect(finalBudget.attempts).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    console.log(`REAL_WARMUP_PASS elapsed_ms=${rendered[0]!.createdAt - firstEligibleAt}`);
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    client?.dispose(); socket?.close(); await runtime.stop(); rmSync(dir, { recursive: true, force: true });
  }
}, 7320000);
