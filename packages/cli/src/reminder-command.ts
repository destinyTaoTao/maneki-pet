import { parseArgs } from "node:util";
import { normalizeAgentReminder, type AgentReminderInput } from "@maneki-pet/core";
import { createReminderClient, ReminderClientError } from "@maneki-pet/sdk";

export function reminderClient() {
  return createReminderClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_TOKEN_FILE ?? "",
  });
}

export function safeReminderError(error: unknown): string {
  return error instanceof ReminderClientError ? error.message : "提醒请求失败";
}

function commandInput(args: string[]): AgentReminderInput | null {
  try {
    const option = { type: "string", multiple: true } as const;
    const { values } = parseArgs({ args, options: { "request-id": option, "after-seconds": option, message: option } });
    const ids = values["request-id"];
    const delays = values["after-seconds"];
    const messages = values.message;
    if (ids?.length !== 1 || delays?.length !== 1 || messages?.length !== 1 || !/^\d+$/.test(delays[0]!)) return null;
    return normalizeAgentReminder({ requestId: ids[0], afterSeconds: Number(delays[0]), message: messages[0] });
  } catch {
    return null;
  }
}

export async function runReminderCommand(args: string[]): Promise<void> {
  const input = commandInput(args);
  if (!input) {
    process.stderr.write("usage: maneki remind --request-id <id> --after-seconds <n> --message <text>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await reminderClient().createReminder(input);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  }
}
