import { parseArgs } from "node:util";
import { normalizeDailyReminderCancelInput, normalizeDailyReminderInput, normalizeDailyReminderRescheduleInput } from "@maneki-pet/core";
import { createRecurringReminderClient, createRecurringReminderRescheduleClient } from "@maneki-pet/sdk";
import { safeReminderError } from "./reminder-command.js";

export function recurringReminderClient() {
  return createRecurringReminderClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_RECURRING_TOKEN_FILE ?? "",
  });
}

export function recurringReminderRescheduleClient() {
  return createRecurringReminderRescheduleClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE ?? "",
  });
}

const usages = {
  "remind-daily": "maneki remind-daily --request-id <id> --at <HH:mm> --message <text>",
  "daily-reminders": "maneki daily-reminders",
  "cancel-daily-reminder": "maneki cancel-daily-reminder --request-id <id> --series-id <uuid>",
  "remind-weekdays": "maneki remind-weekdays --request-id <id> --at <HH:mm> --message <text>",
  "weekday-reminders": "maneki weekday-reminders",
  "cancel-weekday-reminder": "maneki cancel-weekday-reminder --request-id <id> --series-id <uuid>",
  "daily-reschedule-targets": "maneki daily-reschedule-targets",
  "reschedule-daily-reminder": "maneki reschedule-daily-reminder --request-id <id> --series-id <uuid> --version <n> --at <HH:mm>",
} as const;
type RecurringReminderCommand = keyof typeof usages;

const option = { type: "string", multiple: true } as const;
function once(values: string[] | undefined): string | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

function parseOperation(command: RecurringReminderCommand, args: string[]): (() => Promise<unknown>) | null {
  try {
    switch (command) {
      case "remind-daily":
      case "remind-weekdays": {
        const { values } = parseArgs({ args, options: { "request-id": option, at: option, message: option } });
        const input = normalizeDailyReminderInput({
          requestId: once(values["request-id"]), localTime: once(values.at), message: once(values.message),
        });
        return input && (() => command === "remind-daily"
          ? recurringReminderClient().createDailyReminder(input)
          : recurringReminderClient().createWeekdayReminder(input));
      }
      case "daily-reminders":
        return args.length === 0 ? () => recurringReminderClient().listDailyReminders() : null;
      case "weekday-reminders":
        return args.length === 0 ? () => recurringReminderClient().listWeekdayReminders() : null;
      case "cancel-daily-reminder":
      case "cancel-weekday-reminder": {
        const { values } = parseArgs({ args, options: { "request-id": option, "series-id": option } });
        const input = normalizeDailyReminderCancelInput({
          requestId: once(values["request-id"]), seriesId: once(values["series-id"]),
        });
        return input && (() => command === "cancel-daily-reminder"
          ? recurringReminderClient().cancelDailyReminder(input)
          : recurringReminderClient().cancelWeekdayReminder(input));
      }
      case "daily-reschedule-targets":
        return args.length === 0 ? () => recurringReminderRescheduleClient().listTargets() : null;
      case "reschedule-daily-reminder": {
        const { values } = parseArgs({ args, options: { "request-id": option, "series-id": option, version: option, at: option } });
        const version = once(values.version);
        if (version === undefined || !/^\d+$/.test(version)) return null;
        const input = normalizeDailyReminderRescheduleInput({
          requestId: once(values["request-id"]), seriesId: once(values["series-id"]),
          version: Number(version), localTime: once(values.at),
        });
        return input && (() => recurringReminderRescheduleClient().rescheduleDailyReminder(input));
      }
    }
  } catch {
    return null;
  }
}

export async function runRecurringReminderCommand(command: RecurringReminderCommand, args: string[]): Promise<void> {
  const operation = parseOperation(command, args);
  if (!operation) {
    process.stderr.write(`usage: ${usages[command]}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await operation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  }
}
