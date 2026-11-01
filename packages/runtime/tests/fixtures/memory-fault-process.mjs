import { startRuntime } from "../../dist/index.js";

const runtime = await startRuntime({ configDir: process.argv[2] });
try {
  const base = `http://127.0.0.1:${runtime.port}`;
  const pair = async (name) => {
    const response = await fetch(`${base}/v1/pair`, { method: "POST", headers: { authorization: `Bearer ${runtime.rootToken}`, "content-type": "application/json" }, body: JSON.stringify({ name, scopes: "express" }) });
    return (await response.json()).token;
  };
  const firstToken = await pair("first");
  const secondToken = await pair("second");
  const submit = async () => fetch(`${base}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: "r1", prompt: "test", workdir: process.argv[2] }) });
  const before = await submit();
  const result = await runtime.memory.retrieveContext(
    { text: "test" },
    { requestId: "test", signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000 },
  );
  const health = await fetch(`${base}/v1/health`);
  const after = await submit();
  const second = await fetch(`${base}/v1/limits`, { headers: { authorization: `Bearer ${secondToken}` } });
  process.stdout.write(JSON.stringify({ outcome: result.outcome, health: health.status, taskBefore: before.status, taskAfter: after.status, secondClient: second.status }));
} finally {
  await runtime.stop();
}
