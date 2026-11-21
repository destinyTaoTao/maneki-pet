import { BriefingClientError, createBriefingClient } from "@maneki-pet/sdk";

export function briefingClient() {
  return createBriefingClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_BRIEFING_TOKEN_FILE ?? "",
  });
}

export function safeBriefingError(error: unknown): string {
  return error instanceof BriefingClientError ? error.message : "简报请求失败";
}

export async function runBriefingCommand(args: string[]): Promise<void> {
  if (args.length !== 0) {
    process.stderr.write("usage: maneki briefing\n");
    process.exitCode = 2;
    return;
  }
  try {
    const briefing = await briefingClient().getBriefing();
    process.stdout.write(`${JSON.stringify(briefing)}\n`);
  } catch (error) {
    process.stderr.write(`${safeBriefingError(error)}\n`);
    process.exitCode = 1;
  }
}
