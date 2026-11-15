import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";
import type { StartedRuntime } from "../src/runtime.js";

const python = process.env.MANEKI_MEMORY_TEST_PYTHON;
const tokenizerDataDir = process.env.MANEKI_MEMORY_TEST_TOKENIZER_DIR;

// 显式启用；只初始化本测试新建的临时库，不读取任何正式记忆配置。
it.skipIf(!python || !tokenizerDataDir).each(["gpt-4o-mini","deepseek-flash","Qwen/Qwen3-0.6B"])("%s 真实 shim 保存后清本地历史并重启，只有授权召回才把来源带给模型，故障不阻塞提醒", async (model) => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-memory-chain-"));
  let runtime: StartedRuntime | undefined;
  const notify = vi.fn(async () => ({ status: "accepted" as const }));
  const reply = vi.fn(async (_input: unknown) => ({ text: "合成模型回答", usage: { inputTokens: 1, outputTokens: 1 } }));
  const runtimeDir = join(directory, "assistant");
  let token = "";
  try {
    const { stdout } = await promisify(execFile)(python!, ["-c", "from pathlib import Path; import sys; from evernook import initialize; config,_=initialize(Path(sys.argv[1])/'ordinary',client_id='owner',entry='owner'); print(config)", directory], { timeout: 15000, windowsHide: true, encoding: "utf8" });
    const configPath = stdout.trim();
    const accessPath = join(dirname(configPath), "mcp-access-maneki.json");
    const start = async () => {
      runtime = await startFetchCompatibleRuntime({ configDir: runtimeDir, notifier: { notify }, chatProvider: () => ({ info: { id: "synthetic-model", apiVersion: 1, locality: "local" }, reply }) });
    };
    const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", credential = token) => {
      const res = await fetch(`http://127.0.0.1:${runtime!.port}/v1${path}`, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    const configure = async (recallEnabled: boolean, pythonPath = python!) => {
      const current = await call("/assistant/settings");
      const { schemaVersion: _schema, ...defaults } = defaultAssistantSettings();
      const res = await call("/assistant/settings", { ...defaults, version: current.body.version, timeZone: "UTC",
        chat: { enabled: true, locality: "local", baseUrl: "http://127.0.0.1:1", model, maxInputTokens: 16384, maxOutputTokens: 64 },
        memory: { recallEnabled, writeEnabled: true, pythonPath, configPath, accessPath, tokenizerDataDir },
      }, "PUT");
      expect(res.status).toBe(200);
    };
    let sequence = 0;
    const chat = async (text: string) => {
      const requestId = `real-memory-${++sequence}`;
      expect((await call("/assistant/chat", { requestId, text })).status).toBe(202);
      let result: Record<string, any> = {};
      await vi.waitFor(async () => { result = (await call(`/assistant/chat/${requestId}`)).body; expect(result.status).not.toBe("pending"); }, { timeout: 15000 });
      return result;
    };
    await start();
    token = (await call("/pair", { name: "memory-test", scopes: "assistant,settings" }, "POST", runtime!.rootToken)).body.token;
    await configure(false);
    await chat("记住：尚未配对不能保存");
    expect(existsSync(accessPath)).toBe(false);
    expect(await call("/assistant/memory/pair", {})).toEqual({ status: 200, body: { paired: true } });
    expect(existsSync(accessPath)).toBe(true);
    const tag = `memory${randomUUID().replaceAll("-", "")}`;
    const preference = `合成偏好 ${tag} 是淡蓝色`;
    const saved = await chat(`记住：${preference}`);
    expect(saved.status).toBe("completed");
    expect(saved.message.text).toContain("已保存");
    expect(reply).not.toHaveBeenCalled();
    const preview = await call("/assistant/clear-preview", { scope: "history" });
    expect((await call("/assistant/clear", { confirmationId: preview.body.confirmationId })).status).toBe(200);
    expect(runtime!.store.assistantStore().messages()).toEqual([]);
    expect(runtime!.store.assistantStore().get("summary")).toBeNull();
    await runtime!.stop();
    await start();
    await configure(true);
    const recalled = await chat(tag);
    expect(recalled.status).toBe("completed");
    expect(JSON.stringify(reply.mock.calls)).toContain(preference);
    expect(JSON.stringify(reply.mock.calls)).toContain("untrusted_memory_context");
    expect(recalled.message.text).toContain("来源");
    // 关闭召回并再次清历史，排除上一轮的普通对话记录作为假阳性。
    await configure(false);
    const again = await call("/assistant/clear-preview", { scope: "history" });
    await call("/assistant/clear", { confirmationId: again.body.confirmationId });
    reply.mockClear();
    expect((await chat(tag)).status).toBe("completed");
    expect(JSON.stringify(reply.mock.calls)).not.toContain(preference);
    // 记忆失联时继续调用原模型，确定性提醒仍独立投递到替身通知器。
    await configure(true, join(directory, "missing-python.exe"));
    reply.mockClear();
    expect((await chat("普通合成问题")).status).toBe("completed");
    expect(reply).toHaveBeenCalledOnce();
    expect((await call("/assistant/mutations", { requestId: "remind-after-memory-failure", action: "reminder.create", message: "合成提醒", remindAt: Date.now() + 100 })).status).toBe(200);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce(), { timeout: 3000 });
  } finally {
    await runtime?.stop();
    const actual = realpathSync(directory);
    if (dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith("maneki-memory-chain-")) throw new Error("unexpected memory fixture cleanup target");
    rmSync(actual, { recursive: true, force: true });
  }
}, 60000);
