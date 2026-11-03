const { startRuntime } = await import("../../dist/index.js");
const runtime = await startRuntime({ configDir: process.argv[2] });
const base = `http://127.0.0.1:${runtime.port}`;
try {
  const response = await fetch(`${base}/v1/pair`, {
    method: "POST", headers: { authorization: `Bearer ${runtime.rootToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "other", scopes: "express" }),
  });
  const { token } = await response.json();
  const tasksPair = await fetch(`${base}/v1/pair`, {
    method: "POST", headers: { authorization: `Bearer ${runtime.rootToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "tasks", scopes: "tasks" }),
  });
  const { token: tasksToken } = await tasksPair.json();
  const submit = () => fetch(`${base}/v1/tasks`, {
    method: "POST", headers: { authorization: `Bearer ${tasksToken}`, "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "pipe-fault", prompt: "test", workdir: process.argv[2] }),
  });
  const taskBefore = (await submit()).status;
  const result = await runtime.memory.retrieveContext({ text: "pipe-fault" }, {
    requestId: "pipe-fault", signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000,
  });
  const health = (await fetch(`${base}/v1/health`)).status;
  const other = (await fetch(`${base}/v1/expressions/state`, { headers: { authorization: `Bearer ${token}` } })).status;
  const taskAfter = (await submit()).status;
  process.stdout.write(JSON.stringify({ ...result, health, other, taskBefore, taskAfter }));
} finally { await runtime.stop(); }
