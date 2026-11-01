import { startRuntime } from "../../dist/index.js";

const runtime = await startRuntime({ configDir: process.argv[2] });
try {
  const result = await runtime.memory.retrieveContext(
    { text: "test" },
    { requestId: "test", signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000 },
  );
  const health = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`);
  process.stdout.write(JSON.stringify({ outcome: result.outcome, health: health.status }));
} finally {
  await runtime.stop();
}
