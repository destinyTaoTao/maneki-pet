import { parseArgs } from "node:util";
import {
  normalizeAgentReminder, normalizeAgentReminderCancelInput, normalizeAgentReminderRescheduleInput,
  type AgentReminderCancelInput, type AgentReminderInput, type AgentReminderRescheduleInput,
} from "@maneki-pet/core";
import {
  createReminderCancelClient, createReminderClient, createReminderReadClient, createReminderRescheduleClient,
  ReminderClientError,
} from "@maneki-pet/sdk";

export function reminderClient() {
  return createReminderClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_TOKEN_FILE ?? "",
  });
}

export function reminderReadClient() {
  return createReminderReadClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_READ_TOKEN_FILE ?? "",
  });
}

export function reminderCancelClient() {
  return createReminderCancelClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_CANCEL_TOKEN_FILE ?? "",
  });
}

export function reminderRescheduleClient() {
  return createReminderRescheduleClient({
    baseUrl: process.env.MANEKI_RUNTIME_URL ?? "",
    tokenFile: process.env.MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE ?? "",
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

export async function runReminderReadCommand(args: string[]): Promise<void> {
  if (args.length !== 0) {
    process.stderr.write("usage: maneki reminders\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await reminderReadClient().listReminders();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  }
}

function cancelCommandInput(args: string[]): AgentReminderCancelInput | null {
  try {
    const option = { type: "string", multiple: true } as const;
    const { values } = parseArgs({ args, options: { "request-id": option, "reminder-id": option, version: option } });
    const requestIds = values["request-id"];
    const reminderIds = values["reminder-id"];
    const versions = values.version;
    if (requestIds?.length !== 1 || reminderIds?.length !== 1 || versions?.length !== 1 || !/^\d+$/.test(versions[0]!)) return null;
    return normalizeAgentReminderCancelInput({ requestId: requestIds[0], reminderId: reminderIds[0], version: Number(versions[0]) });
  } catch {
    return null;
  }
}

export async function runReminderCancelCommand(args: string[]): Promise<void> {
  const input = cancelCommandInput(args);
  if (!input) {
    process.stderr.write("usage: maneki cancel-reminder --request-id <id> --reminder-id <id> --version <n>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await reminderCancelClient().cancelReminder(input);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  }
}

function rescheduleCommandInput(args: string[]): AgentReminderRescheduleInput | null {
  try {
    const option = { type: "string", multiple: true } as const;
    const { values } = parseArgs({
      args, options: { "request-id": option, "reminder-id": option, version: option, "after-seconds": option },
    });
    const requestIds = values["request-id"];
    const reminderIds = values["reminder-id"];
    const versions = values.version;
    const delays = values["after-seconds"];
    if (requestIds?.length !== 1 || reminderIds?.length !== 1 || versions?.length !== 1 || delays?.length !== 1 ||
        !/^\d+$/.test(versions[0]!) || !/^\d+$/.test(delays[0]!)) return null;
    return normalizeAgentReminderRescheduleInput({
      requestId: requestIds[0], reminderId: reminderIds[0], version: Number(versions[0]), afterSeconds: Number(delays[0]),
    });
  } catch {
    return null;
  }
}

export async function runReminderRescheduleCommand(args: string[]): Promise<void> {
  const input = rescheduleCommandInput(args);
  if (!input) {
    process.stderr.write("usage: maneki reschedule-reminder --request-id <id> --reminder-id <id> --version <n> --after-seconds <n>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await reminderRescheduleClient().rescheduleReminder(input);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  }
}
