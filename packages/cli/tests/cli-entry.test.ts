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
