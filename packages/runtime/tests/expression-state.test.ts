import { expect, it, vi } from "vitest";
import { ExpressionStateFeed } from "../src/expression-state.js";

it("每次快照按客户端核验权限；下次读取立即反映撤销", () => {
  const clients = new Set(["agent", "desktop"]);
  const active = vi.fn((id: string) => clients.has(id));
  const feed = new ExpressionStateFeed({ active, publish: () => {} });
  try {
    for (let index = 0; index < 63; index++) feed.update("agent", String(index), "working");
    feed.update("desktop", "window", "thinking");
    active.mockClear();
    expect(feed.current()).toBe("working");
    expect(active).toHaveBeenCalledTimes(2);
    clients.delete("agent");
    active.mockClear();
    expect(feed.current()).toBe("thinking");
    expect(active).toHaveBeenCalledTimes(2);
    clients.clear();
    expect(feed.current()).toBe("idle");
  } finally {
    feed.close();
  }
});
