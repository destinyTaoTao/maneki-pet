import { expect, it } from "vitest";
import { normalizeDailyReminderRescheduleInput, normalizeWeeklyReminderInput, normalizeWeeklyReminderRescheduleInput } from "../src/index.js";

const input = { requestId: "weekly-1", localTime: "08:00", message: "确认构建" };
const reschedule = { requestId: "weekly-move", seriesId: "ab000000-0000-4000-a000-000000000001", localTime: "08:00", version: 1 };

it("规范化有效的 ISO 星期集合与正文，不改写调用方数组", () => {
  const daysOfWeek = Object.freeze([7, 2, 1]);
  expect(normalizeWeeklyReminderInput({ ...input, message: ` ${input.message} `, daysOfWeek }))
    .toEqual({ ...input, daysOfWeek: [1, 2, 7] });
  expect(daysOfWeek).toEqual([7, 2, 1]);
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [7, 6, 5, 4, 3, 2, 1] })?.daysOfWeek).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [7] })?.daysOfWeek).toEqual([7]);
});

it("拒绝缺失、重复、稀疏或超界的星期与额外字段", () => {
  for (const daysOfWeek of [null, "1,3,5", [], [1, 1], [0], [8], [1.5], ["1"], [NaN], [, 2], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek })).toBeNull();
  }
  expect(normalizeWeeklyReminderInput(input)).toBeNull();
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [1], timeZone: "UTC" })).toBeNull();
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [1], localTime: "24:00" })).toBeNull();
});

it("按星期改期区分省略与替换整个星期集合", () => {
  expect(normalizeWeeklyReminderRescheduleInput(reschedule)).toEqual(reschedule);
  const daysOfWeek = Object.freeze([7, 2, 1]);
  expect(normalizeWeeklyReminderRescheduleInput({ ...reschedule, daysOfWeek }))
    .toEqual({ ...reschedule, daysOfWeek: [1, 2, 7] });
  expect(daysOfWeek).toEqual([7, 2, 1]);
  expect(normalizeDailyReminderRescheduleInput({ ...reschedule, daysOfWeek })).toBeNull();
});

it("按星期改期拒绝显式无效的星期集合与额外字段", () => {
  for (const daysOfWeek of [undefined, null, "1,3,5", [], [1, 1], [0], [8], [1.5], ["1"], [, 2]]) {
    expect(normalizeWeeklyReminderRescheduleInput({ ...reschedule, daysOfWeek })).toBeNull();
  }
  expect(normalizeWeeklyReminderRescheduleInput({ ...reschedule, daysOfWeek: [1], timeZone: "UTC" })).toBeNull();
  expect(normalizeWeeklyReminderRescheduleInput({ ...reschedule, daysOfWeek: [1], localTime: undefined })).toBeNull();
});
