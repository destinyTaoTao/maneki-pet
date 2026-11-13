import { startRuntime, type StartedRuntime } from "../src/runtime.js";

/** 仅重选 fetch 标准禁用的系统随机端口，不重试服务或业务失败。 */
export async function speechHostTestRuntime(configDir: string): Promise<StartedRuntime> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const runtime = await startRuntime({ configDir, notifier: { notify: async () => ({ status: "accepted" as const }) } });
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`);
      await response.body?.cancel();
      return runtime;
    } catch (error) {
      await runtime.stop();
      if (!(error instanceof Error) || !(error.cause instanceof Error) || error.cause.message !== "bad port") throw error;
    }
  }
  throw new Error("Cannot allocate a fetch-compatible test port");
}
