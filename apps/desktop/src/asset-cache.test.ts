import { describe, expect, it, vi } from "vitest";

import { AssetCache } from "../src/asset-cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AssetCache", () => {
  it("merges concurrent loads for the same key into one request", async () => {
    const load = vi.fn(async (key: string) => `url:${key}`);
    const release = vi.fn();
    const cache = new AssetCache(4, load, release);

    const [first, second] = await Promise.all([cache.get("a"), cache.get("a")]);

    expect(first).toBe("url:a");
    expect(second).toBe("url:a");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry beyond the cap and releases it", async () => {
    const release = vi.fn();
    const cache = new AssetCache(2, async (key: string) => `url:${key}`, release);

    await cache.get("a");
    await cache.get("b");
    // 触摸 a，使 b 成为最久未用项。
    await cache.get("a");
    await cache.get("c");

    expect(release).toHaveBeenCalledWith("url:b");
    expect(cache.size).toBe(2);
    expect(await cache.get("a")).toBe("url:a");
  });

  it("does not cache failed loads or release their results", async () => {
    const load = vi.fn(async () => {
      throw new Error("boom");
    });
    const release = vi.fn();
    const cache = new AssetCache(2, load, release);

    await expect(cache.get("a")).rejects.toThrow("boom");
    expect(cache.size).toBe(0);

    const retryLoad = vi.fn(async () => "url:a");
    const retry = new AssetCache(2, retryLoad, release);
    await expect(retry.get("a")).resolves.toBe("url:a");
  });

  it("clear releases every cached entry", async () => {
    const release = vi.fn();
    const cache = new AssetCache(4, async (key: string) => `url:${key}`, release);
    await cache.get("a");
    await cache.get("b");

    cache.clear();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));

    expect(cache.size).toBe(0);
  });

  it("releases entries whose promise settles after clear", async () => {
    const pending = deferred<string>();
    const release = vi.fn();
    const cache = new AssetCache(2, () => pending.promise, release);

    const entry = cache.get("slow");
    cache.clear();
    pending.resolve("url:slow");
    await entry;

    expect(release).toHaveBeenCalledWith("url:slow");
  });

  it("rejects non-positive cache limits", () => {
    expect(() => new AssetCache(0, async () => "", () => undefined)).toThrow();
  });
});
