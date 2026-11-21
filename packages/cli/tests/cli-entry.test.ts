import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const fixtures: string[] = [];
const draft = {
  topic: "合成选题", script: "合成脚本", title: "合成标题", intro: "合成简介",
  tags: ["test"], coverSuggestion: "合成封面建议",
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    const actual = realpathSync(fixture);
    if (dirname(actual) !== realpathSync(tmpdir()) || !/^maneki-cli-draft-/.test(basename(actual)))
      throw new Error("refusing to clean an unexpected fixture directory");
    rmSync(actual, { recursive: true, force: true });
  }
});

for (const [format, content] of [["envelope", { draft }], ["legacy-interactive", draft]] as const) {
  it(`package 可读取 ${format} 草稿并保留内容`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "maneki-cli-draft-"));
    fixtures.push(fixture);
    const draftFile = join(fixture, "draft.json"), video = join(fixture, "video.mp4"), cover = join(fixture, "cover.png"), out = join(fixture, "package");
    writeFileSync(draftFile, JSON.stringify(content));
    writeFileSync(video, "synthetic video");
    writeFileSync(cover, "synthetic cover");

    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), "platform", "package", "--draft", draftFile, "--video", video, "--cover", cover, "--out", out], { encoding: "utf8", timeout: 5000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain(draft.title);
    expect(JSON.parse(readFileSync(join(out, "metadata.json"), "utf8"))).toMatchObject({ title: draft.title, intro: draft.intro, tags: draft.tags });
    expect(existsSync(join(out, "video", "video.mp4"))).toBe(true);
  });
}

it("briefing 不接受参数，不输出收到的参数或借用状态凭证", () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-cli-draft-"));
  fixtures.push(dir);
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({
    instanceId: "rt-test12345678", clientId: "client-aa0000000001", token: "a".repeat(43),
  }));
  const command = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), "briefing", ...args], {
    env: { ...process.env, MANEKI_RUNTIME_URL: "http://127.0.0.1:1", MANEKI_TOKEN_FILE: stateFile, MANEKI_BRIEFING_TOKEN_FILE: "" },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  const extra = command("--private-argument");
  expect(extra.status).toBe(2);
  expect(extra.stdout).toBe("");
  expect(extra.stderr.trim()).toBe("usage: maneki briefing");
  const missing = command();
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr.trim()).toBe("需要可读的已配对 briefing_read 凭证文件");
});

it("remind 拒绝重复或无效参数，不回显提醒内容且只读取专属凭证", () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-cli-draft-"));
  fixtures.push(dir);
  const otherCredential = join(dir, "other-client.json");
  writeFileSync(otherCredential, JSON.stringify({
    instanceId: "rt-test12345678", clientId: "client-aa0000000001", token: "a".repeat(43),
  }));
  const command = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), "remind", ...args], {
    env: { ...process.env, MANEKI_RUNTIME_URL: "http://127.0.0.1:1", MANEKI_TOKEN_FILE: otherCredential,
      MANEKI_BRIEFING_TOKEN_FILE: otherCredential, MANEKI_REMINDER_TOKEN_FILE: undefined },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  const valid = ["--message", "private-text", "--request-id", "user-1", "--after-seconds", "1"];
  for (const args of [[...valid, "--request-id", "other"], [...valid, "--token", "private-token"],
    [...valid, "private-positional"], valid.slice(0, 4), [...valid.slice(0, 5), "0x10"]]) {
    const result = command(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("usage: maneki remind --request-id <id> --after-seconds <n> --message <text>");
  }
  const missing = command(...valid);
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr.trim()).toBe("需要可读的已配对 reminder_create 凭证文件");
});

it("提醒管理命令只读取各自的凭证，取消必须指定完整 ID 和版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-cli-draft-"));
  fixtures.push(dir);
  const createCredential = join(dir, "create-client.json");
  writeFileSync(createCredential, JSON.stringify({
    instanceId: "rt-test12345678", clientId: "client-aa0000000001", token: "a".repeat(43),
  }));
  const command = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), ...args], {
    env: { ...process.env, MANEKI_RUNTIME_URL: "http://127.0.0.1:1", MANEKI_REMINDER_TOKEN_FILE: createCredential,
      MANEKI_REMINDER_READ_TOKEN_FILE: undefined, MANEKI_REMINDER_CANCEL_TOKEN_FILE: undefined },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  const filtered = command("reminders", "--message", "private-text");
  expect([filtered.status, filtered.stdout, filtered.stderr.trim()]).toEqual([2, "", "usage: maneki reminders"]);
  const list = command("reminders");
  expect([list.status, list.stdout, list.stderr.trim()]).toEqual([1, "", "需要可读的已配对 reminder_read 凭证文件"]);
  const valid = ["--request-id", "cancel-1", "--reminder-id", "ab000000-0000-4000-a000-000000000001", "--version", "1"];
  for (const args of [valid.slice(0, 4), [...valid.slice(0, 5), "1e0"], [...valid, "--version", "2"],
    [...valid, "--message", "private-text"], ["--reminder-id", "ab000000", "--request-id", "cancel-1", "--version", "1"]]) {
    const invalid = command("cancel-reminder", ...args);
    expect([invalid.status, invalid.stdout, invalid.stderr.trim()]).toEqual([
      2, "", "usage: maneki cancel-reminder --request-id <id> --reminder-id <id> --version <n>",
    ]);
  }
  const cancel = command("cancel-reminder", ...valid);
  expect([cancel.status, cancel.stdout, cancel.stderr.trim()]).toEqual([1, "", "需要可读的已配对 reminder_cancel 凭证文件"]);
});

it("提醒改期要求完整 ID、版本和整数延时，并且只读取改期凭证", () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-cli-draft-"));
  fixtures.push(dir);
  const otherCredential = join(dir, "other-client.json");
  writeFileSync(otherCredential, JSON.stringify({
    instanceId: "rt-test12345678", clientId: "client-aa0000000001", token: "a".repeat(43),
  }));
  const command = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), "reschedule-reminder", ...args], {
    env: { ...process.env, MANEKI_RUNTIME_URL: "http://127.0.0.1:1", MANEKI_REMINDER_TOKEN_FILE: otherCredential,
      MANEKI_REMINDER_READ_TOKEN_FILE: otherCredential, MANEKI_REMINDER_CANCEL_TOKEN_FILE: otherCredential,
      MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE: undefined },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  const target = ["--request-id", "reschedule-1", "--reminder-id", "ab000000-0000-4000-a000-000000000001", "--version", "1"];
  const valid = [...target, "--after-seconds", "3600"];
  for (const args of [target, [...target, "--after-seconds", "1e3"], [...target, "--after-seconds", "31622401"],
    [...valid, "--after-seconds", "1"], [...valid, "--message", "private-text"]]) {
    const result = command(...args);
    expect([result.status, result.stdout, result.stderr.trim()]).toEqual([
      2, "", "usage: maneki reschedule-reminder --request-id <id> --reminder-id <id> --version <n> --after-seconds <n>",
    ]);
  }
  const result = command(...valid);
  expect([result.status, result.stdout, result.stderr.trim()]).toEqual([1, "", "需要可读的已配对 reminder_reschedule 凭证文件"]);
});

it("每日提醒命令拒绝重复或多余参数、非规范时间与模糊 ID，并只读取每日提醒凭证", () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-cli-draft-"));
  fixtures.push(dir);
  const oneTimeCredential = join(dir, "one-time-client.json");
  writeFileSync(oneTimeCredential, JSON.stringify({
    instanceId: "rt-test12345678", clientId: "client-aa0000000001", token: "a".repeat(43),
  }));
  const command = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), ...args], {
    env: { ...process.env, MANEKI_RUNTIME_URL: "http://127.0.0.1:1", MANEKI_REMINDER_TOKEN_FILE: oneTimeCredential,
      MANEKI_REMINDER_READ_TOKEN_FILE: oneTimeCredential, MANEKI_REMINDER_CANCEL_TOKEN_FILE: oneTimeCredential,
      MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE: oneTimeCredential, MANEKI_REMINDER_RECURRING_TOKEN_FILE: undefined },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  const create = ["remind-daily", "--request-id", "daily-1", "--message", "private-text"];
  const cancel = ["cancel-daily-reminder", "--request-id", "cancel-1"];
  const seriesId = "ab000000-0000-4000-a000-000000000001";
  const createUsage = "maneki remind-daily --request-id <id> --at <HH:mm> --message <text>";
  const cancelUsage = "maneki cancel-daily-reminder --request-id <id> --series-id <uuid>";
  for (const [args, usage] of [
    [[...create, "--at", "8:00"], createUsage], [[...create, "--at", "24:00"], createUsage],
    [[...create, "--at", "08:00", "--at", "09:00"], createUsage],
    [[...create, "--at", "08:00", "--time-zone", "UTC"], createUsage],
    [["daily-reminders", "--message", "private-text"], "maneki daily-reminders"],
    [[...cancel, "--series-id", "ab000000"], cancelUsage],
    [[...cancel, "--series-id", seriesId.toUpperCase()], cancelUsage],
    [[...cancel, "--series-id", seriesId, "--message", "private-text"], cancelUsage],
  ] as const) {
    const invalid = command(...args);
    expect([invalid.status, invalid.stdout, invalid.stderr.trim()]).toEqual([2, "", `usage: ${usage}`]);
  }
  for (const args of [[...create, "--at", "08:00"], ["daily-reminders"], [...cancel, "--series-id", seriesId]]) {
    const unpaired = command(...args);
    expect([unpaired.status, unpaired.stdout, unpaired.stderr.trim()]).toEqual([1, "", "需要可读的已配对 reminder_recurring 凭证文件"]);
  }
});
