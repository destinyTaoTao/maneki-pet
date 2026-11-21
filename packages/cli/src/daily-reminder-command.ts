import { parseArgs } from "node:util";
import { normalizeDailyReminderCancelInput, normalizeDailyReminderInput } from "@maneki-pet/core";
import { createRecurringReminderClient } from "@maneki-pet/sdk";
import { safeReminderError } from "./reminder-command.js";

export function recurringReminderClient() {
  return createRecurringReminderClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_RECURRING_TOKEN_FILE ?? "",
  });
}

const usages = {
  "remind-daily": "maneki remind-daily --request-id <id> --at <HH:mm> --message <text>",
  "daily-reminders": "maneki daily-reminders",
  "cancel-daily-reminder": "maneki cancel-daily-reminder --request-id <id> --series-id <uuid>",
} as const;
type DailyReminderCommand = keyof typeof usages;
type Client = ReturnType<typeof recurringReminderClient>;

const option = { type: "string", multiple: true } as const;
function once(values: string[] | undefined): string | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

function parseOperation(command: DailyReminderCommand, args: string[]): ((client: Client) => Promise<unknown>) | null {
  try {
    switch (command) {
      case "remind-daily": {
        const { values } = parseArgs({ args, options: { "request-id": option, at: option, message: option } });
        const input = normalizeDailyReminderInput({
          requestId: once(values["request-id"]), localTime: once(values.at), message: once(values.message),
        });
        return input && ((client) => client.createDailyReminder(input));
      }
      case "daily-reminders":
        return args.length === 0 ? (client) => client.listDailyReminders() : null;
      case "cancel-daily-reminder": {
        const { values } = parseArgs({ args, options: { "request-id": option, "series-id": option } });
        const input = normalizeDailyReminderCancelInput({
          requestId: once(values["request-id"]), seriesId: once(values["series-id"]),
        });
        return input && ((client) => client.cancelDailyReminder(input));
      }
    }
  } catch {
    return null;
  }
}

export async function runDailyReminderCommand(command: DailyReminderCommand, args: string[]): Promise<void> {
  const operation = parseOperation(command, args);
  if (!operation) {
    process.stderr.write(`usage: ${usages[command]}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await operation(recurringReminderClient());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  }
}
