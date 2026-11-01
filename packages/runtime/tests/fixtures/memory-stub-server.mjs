/**
 * 测试替身：最小 stdio MCP 记忆服务（行分帧 JSON-RPC 2.0）。
 * 环境变量注入故障：
 *   MEMORY_STUB_FAIL=retrieve|write   对应工具返回错误
 *   MEMORY_STUB_DELAY_MS=<n>          每个请求延迟 n 毫秒（测超时/取消）
 */
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const store = [];
const fail = process.env.MEMORY_STUB_FAIL ?? "";
const delayMs = Number(process.env.MEMORY_STUB_DELAY_MS ?? "0");
const exitAfter = Number(process.env.MEMORY_STUB_EXIT_AFTER ?? "0");
let responses = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof message.id !== "number") return;
  respond(message).catch(() => undefined);
});

async function respond(message) {
  if (delayMs > 0) await sleep(delayMs);
  responses += 1;
  const { id, method, params } = message;
  const exitWhenDone = exitAfter > 0 && responses >= exitAfter;
  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "memory-stub", version: "0.0.0" } };
    } else if (method === "tools/list") {
      result = { tools: [{ name: "memory_search" }, { name: "memory_write" }] };
    } else if (method === "tools/call" && params?.name === "memory_search") {
      if (fail === "retrieve") return sendError(id, -32000, "stub retrieve failure");
      const query = String(params.arguments?.query ?? "").toLowerCase();
      const items = store.filter((item) => item.text.toLowerCase().includes(query));
      result = text({ items });
    } else if (method === "tools/call" && params?.name === "memory_write") {
      if (fail === "write") return sendError(id, -32000, "stub write failure");
      if (process.env.MEMORY_STUB_WRITE_LOG) {
        appendFileSync(process.env.MEMORY_STUB_WRITE_LOG, "write\n");
        process.exit(0);
      }
      store.push({
        id: `stub-${store.length + 1}`,
        text: String(params.arguments?.summary ?? ""),
        source: "explicit",
        record: params.arguments ?? {},
      });
      result = text({ written: true });
    } else {
      return sendError(id, -32601, `method not found: ${String(method)}`);
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (error) {
    sendError(id, -32603, error instanceof Error ? error.message : String(error));
  }
  if (exitWhenDone) {
    process.exit(0);
  }
}

function text(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
