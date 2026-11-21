import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createExpressionClient, expressionStates } from "@maneki-pet/sdk";
import { expect, it } from "vitest";

const cli = join(import.meta.dirname, "../dist/main.js");
const mcp = join(import.meta.dirname, "../dist/state-mcp.js");
const runtime = join(import.meta.dirname, "../../runtime/dist/cli.js");
const pairing = join(import.meta.dirname, "../../runtime/scripts/pair-expression-client.mjs");

it("独立 SDK、CLI 与 stdio 桥通过配对凭证更新同一后台的状态租约", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-state-clients-"));
  const background = spawn(process.execPath, [runtime, "--config-dir", dir, "--port", "0", "--background"], {
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  const exited = once(background, "close");
  const lines = createInterface({ input: background.stderr });
  const connected = new Client({ name: "test-standalone-state", version: "1.0.0" });
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime startup timed out")), 8000);
      lines.on("line", (line: string) => {
        const port = /maneki runtime ready: port=(\d+)/.exec(line)?.[1];
        if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
      });
      lines.once("close", () => { clearTimeout(timer); reject(new Error("runtime exited")); });
    });
    function pair(name: string) {
      const result = spawnSync(process.execPath, [pairing, dir, new URL(baseUrl).port, name], {
        windowsHide: true, encoding: "utf8", timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      const tokenFile = result.stdout.trim();
      expect(tokenFile).toBe(join(dir, `expression-client-${name}.json`));
      const { instanceId, clientId } = JSON.parse(readFileSync(tokenFile, "utf8")) as { instanceId: string; clientId: string };
      return { tokenFile, instanceId, clientId };
    }
    const sdkToken = pair("sdk");
    expect(pair("sdk")).toEqual(sdkToken);
    const cliToken = pair("cli");
    const bridgeToken = pair("bridge");

    // 独立的错 scope 测试夹具；正式客户端文件由受信配对入口创建。
    const root = readFileSync(join(dir, "root-token"), "utf8").trim();
    const adminHeaders = { authorization: `Bearer ${root}`, "content-type": "application/json" };
    const result = await fetch(`${baseUrl}/v1/pair`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "settings", scopes: "settings" }),
    });
    expect(result.status).toBe(200);
    const { token, clientId } = await result.json() as { token: string; clientId: string };
    const settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ instanceId: sdkToken.instanceId, token, clientId }), { mode: 0o600 });
    const sdk = createExpressionClient({ baseUrl, tokenFile: sdkToken.tokenFile });
    const command = (args: string[], file = cliToken.tokenFile) => spawnSync(process.execPath, [cli, "state", ...args], {
      env: { ...process.env, MANEKI_RUNTIME_URL: baseUrl, MANEKI_TOKEN_FILE: file },
      windowsHide: true, encoding: "utf8", timeout: 5000,
    });
    const stateFromCli = (...args: string[]) => {
      const result = command(args);
      expect(result.status, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as { state: string }).state;
    };
    expect(await sdk.getState()).toBe("idle");
    expect(await sdk.setState("thinking")).toBe("thinking");
    expect(stateFromCli("get")).toBe("thinking");
    const source = randomUUID();
    expect(stateFromCli("set", "waiting_input", "--source-id", source)).toBe("waiting_input");
    expect(await sdk.setState("idle")).toBe("waiting_input");
    const transport = new StdioClientTransport({
      command: process.execPath, args: [mcp],
      env: { MANEKI_RUNTIME_URL: baseUrl, MANEKI_TOKEN_FILE: bridgeToken.tokenFile }, stderr: "pipe",
    });
    await connected.connect(transport);
    const listed = await connected.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["maneki_set_state"]);
    expect(listed.tools[0]?.inputSchema.properties?.state).toEqual({ type: "string", enum: [...expressionStates] });
    const call = (args: Record<string, unknown>) => connected.callTool({ name: "maneki_set_state", arguments: args });
    expect((await call({ state: "working" })).content).toEqual([{ type: "text", text: '{"accepted":true,"state":"waiting_input"}' }]);
    expect(stateFromCli("set", "idle", "--source-id", source)).toBe("working");
    for (const args of [{ state: "sleeping" }, { state: "idle", command: "private-command" }]) {
      expect((await call(args)).isError).toBe(true);
    }
    expect((await connected.callTool({ name: "maneki_notify", arguments: {} })).isError).toBe(true);
    expect(await sdk.getState()).toBe("working");
    expect((await call({ state: "idle" })).isError).not.toBe(true);
    expect(await sdk.getState()).toBe("idle");
    const wrongScope = command(["get"], settingsFile);
    expect(wrongScope.status).toBe(1);
    expect(wrongScope.stderr.trim()).toBe("无法验证 Runtime 的表达身份");
    const revoked = await fetch(`${baseUrl}/v1/clients/${bridgeToken.clientId}/revoke`, { method: "POST", headers: adminHeaders });
    expect(revoked.ok).toBe(true);
    const rejected = await call({ state: "working" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toEqual([{ type: "text", text: "无法验证 Runtime 的表达身份" }]);
    await connected.close();
    expect(stateFromCli("get")).toBe("idle");
    expect(await sdk.setState("working")).toBe("working");
    expect(background.exitCode).toBeNull();
  } finally {
    await connected.close();
    lines.close();
    if (background.exitCode === null && background.signalCode === null) background.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
