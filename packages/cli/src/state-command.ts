import { createExpressionClient, ExpressionClientError, isExpressionState } from "@maneki-pet/sdk";

export function stateClient(sourceId?: string) {
  return createExpressionClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_TOKEN_FILE ?? "",
    ...(sourceId === undefined ? {} : { sourceId }),
  });
}

export function safeStateError(error: unknown): string {
  return error instanceof ExpressionClientError ? error.message : "状态请求失败";
}

export async function runStateCommand(args: string[]): Promise<void> {
  try {
    let state;
    if (args.length === 1 && args[0] === "get") {
      state = await stateClient().getState();
    } else if (args.length === 4 && args[0] === "set" && isExpressionState(args[1])
        && args[2] === "--source-id" && args[3]) {
      state = await stateClient(args[3]).setState(args[1]);
    } else {
      process.stderr.write("usage: maneki state get | state set <state> --source-id <uuid>\n");
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify({ state })}\n`);
  } catch (error) {
    process.stderr.write(`${safeStateError(error)}\n`);
    process.exitCode = 1;
  }
}
