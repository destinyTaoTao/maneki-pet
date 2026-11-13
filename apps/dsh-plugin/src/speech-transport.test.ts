import { createServer } from "node:http";
import { expect, it } from "vitest";
import { speechHostRequest } from "./speech-transport.js";

it("冒充 Runtime 的监听者不能获得宿主凭证或实例秘密", async () => {
  const received: Array<{ method: string | undefined; authorization: string | undefined; body: string }> = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { received.push({ method: req.method, authorization: req.headers.authorization, body }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ protocolVersion: 1, instanceId: "fake", speechProof: "0".repeat(64) })); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await expect(speechHostRequest(new URL(`http://127.0.0.1:${port}`), "token-secret", "client-123456789abc", "register", { sourceSecret: "private-instance-secret" }, AbortSignal.timeout(3000))).rejects.toThrow();
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBeUndefined();
    expect(JSON.stringify(received)).not.toContain("token-secret");
    expect(JSON.stringify(received)).not.toContain("private-instance-secret");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("身份校验后的连接断开时不在新连接上发送凭证", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const token = "token-secret", client = "client-123456789abc";
  const methods: string[] = [];
  const server = createServer((req, res) => {
    methods.push(req.method || "");
    const port = (server.address() as { port: number }).port;
    const challenge = req.headers["x-maneki-speech-challenge"];
    const key = createHash("sha256").update(token).digest();
    const proof = createHmac("sha256", key).update(JSON.stringify(["maneki-speech-host-proof-v1", client, challenge, "instance", port])).digest("hex");
    res.setHeader("connection", "close"); res.end(JSON.stringify({ protocolVersion: 1, instanceId: "instance", speechProof: proof }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await expect(speechHostRequest(new URL(`http://127.0.0.1:${port}`), token, client, "register", { sourceSecret: "secret" }, AbortSignal.timeout(3000))).rejects.toThrow();
    expect(methods).toEqual(["GET"]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
