import { startRuntime, type RuntimeOptions, type StartedRuntime } from "../src/runtime.js";

type StartTestRuntime = (options: RuntimeOptions) => Promise<StartedRuntime>;

/** 仅重选 Fetch 标准禁用的系统随机端口，不重试服务启动或业务断言。 */
export async function startFetchCompatibleRuntime(
  options: Omit<RuntimeOptions, "port">,
  start: StartTestRuntime = startRuntime,
): Promise<StartedRuntime> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const runtime = await start({ ...options, port: 0 });
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
