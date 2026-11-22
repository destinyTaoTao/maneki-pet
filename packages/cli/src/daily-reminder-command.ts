import { parseArgs } from "node:util";
import {
  normalizeDailyReminderCancelInput, normalizeDailyReminderInput, normalizeDailyReminderRescheduleInput,
  normalizeWeeklyReminderInput, normalizeWeeklyReminderRescheduleInput,
} from "@maneki-pet/core";
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
  "remind-weekly": "maneki remind-weekly --request-id <id> --days 1,3,5 --at <HH:mm> --message <text>",
  "weekly-reminders": "maneki weekly-reminders",
  "cancel-weekly-reminder": "maneki cancel-weekly-reminder --request-id <id> --series-id <uuid>",
  "daily-reschedule-targets": "maneki daily-reschedule-targets",
  "reschedule-daily-reminder": "maneki reschedule-daily-reminder --request-id <id> --series-id <uuid> --version <n> --at <HH:mm>",
  "weekday-reschedule-targets": "maneki weekday-reschedule-targets",
  "reschedule-weekday-reminder": "maneki reschedule-weekday-reminder --request-id <id> --series-id <uuid> --version <n> --at <HH:mm>",
  "weekly-reschedule-targets": "maneki weekly-reschedule-targets",
  "reschedule-weekly-reminder": "maneki reschedule-weekly-reminder --request-id <id> --series-id <uuid> --version <n> --at <HH:mm> [--days 2,4]",
} as const;
type RecurringReminderCommand = keyof typeof usages;

const option = { type: "string", multiple: true } as const;
function once(values: string[] | undefined): string | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

function parseWeeklyDays(values: string[] | undefined): number[] | undefined {
  const days = once(values);
  return days !== undefined && /^[1-7](?:,[1-7]){0,6}$/.test(days) ? days.split(",").map(Number) : undefined;
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
      case "remind-weekly": {
        const { values } = parseArgs({ args, options: { "request-id": option, days: option, at: option, message: option } });
        const input = normalizeWeeklyReminderInput({
          requestId: once(values["request-id"]), localTime: once(values.at), message: once(values.message),
          daysOfWeek: parseWeeklyDays(values.days),
        });
        return input && (() => recurringReminderClient().createWeeklyReminder(input));
      }
      case "weekly-reminders":
        return args.length === 0 ? () => recurringReminderClient().listWeeklyReminders() : null;
      case "cancel-daily-reminder":
      case "cancel-weekday-reminder":
      case "cancel-weekly-reminder": {
        const { values } = parseArgs({ args, options: { "request-id": option, "series-id": option } });
        const input = normalizeDailyReminderCancelInput({
          requestId: once(values["request-id"]), seriesId: once(values["series-id"]),
        });
        return input && (() => {
          const client = recurringReminderClient();
          return {
            "cancel-daily-reminder": client.cancelDailyReminder,
            "cancel-weekday-reminder": client.cancelWeekdayReminder,
            "cancel-weekly-reminder": client.cancelWeeklyReminder,
          }[command](input);
        });
      }
      case "daily-reschedule-targets":
        return args.length === 0 ? () => recurringReminderRescheduleClient().listTargets() : null;
      case "weekday-reschedule-targets":
        return args.length === 0 ? () => recurringReminderRescheduleClient().listWeekdayTargets() : null;
      case "weekly-reschedule-targets":
        return args.length === 0 ? () => recurringReminderRescheduleClient().listWeeklyTargets() : null;
      case "reschedule-daily-reminder":
      case "reschedule-weekday-reminder":
      case "reschedule-weekly-reminder": {
        const weekly = command === "reschedule-weekly-reminder";
        const { values } = parseArgs({ args, options: {
          "request-id": option, "series-id": option, version: option, at: option, days: option,
        } });
        if (!weekly && values.days !== undefined) return null;
        const version = once(values.version);
        if (version === undefined || !/^\d+$/.test(version)) return null;
        const fields = {
          requestId: once(values["request-id"]), seriesId: once(values["series-id"]),
          version: Number(version), localTime: once(values.at),
        };
        const input = weekly ? normalizeWeeklyReminderRescheduleInput({
          ...fields,
          ...(values.days !== undefined && { daysOfWeek: parseWeeklyDays(values.days) }),
        }) : normalizeDailyReminderRescheduleInput(fields);
        return input && (() => {
          const client = recurringReminderRescheduleClient();
          return {
            "reschedule-daily-reminder": client.rescheduleDailyReminder,
            "reschedule-weekday-reminder": client.rescheduleWeekdayReminder,
            "reschedule-weekly-reminder": client.rescheduleWeeklyReminder,
          }[command](input);
        });
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
