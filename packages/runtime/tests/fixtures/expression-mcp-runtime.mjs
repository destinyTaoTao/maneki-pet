import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startRuntime } from "../../dist/index.js";

const runtime = await startRuntime({ configDir: process.argv[2] });
writeFileSync(join(process.argv[2], "port"), String(runtime.port));
await runtime.startMcpStdioBridge();
process.stdin.on("end", () => { void runtime.stop(); });
process.on("SIGTERM", () => { void runtime.stop(); });
