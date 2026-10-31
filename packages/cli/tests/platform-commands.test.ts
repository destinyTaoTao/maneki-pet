import { describe, expect, it } from "vitest";

import { applyDraftField, runShimCommand } from "../src/platform-commands.js";

describe("platform CLI 助手", () => {
  it("applyDraftField：tags 按逗号拆分，其余直接赋值", () => {
    const draft = { topic: "", script: "", title: "", intro: "", tags: [], coverSuggestion: "" };
    applyDraftField(draft, "tags", "ai, 工作流，maneki");
    applyDraftField(draft, "title", "标题");
    expect(draft.tags).toEqual(["ai", "工作流", "maneki"]);
    expect(draft.title).toBe("标题");
  });

  it("shim 调用失败时返回结构化错误而非抛出（CLI 可展示）", () => {
    const result = runShimCommand(
      { python: process.execPath, config: "x", access: "y", shimModule: "not_a_real_module_xyz" },
      "gaps",
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ error: expect.objectContaining({ code: expect.any(String) }) });
  });
});
