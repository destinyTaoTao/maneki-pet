// 对象 URL 缓存：淘汰先取消读取并释放资源，再允许后续加载。
interface Entry {
  promise: Promise<string>;
  controller: AbortController;
}

export class AssetCache {
  private entries = new Map<string, Entry>();
  private releaseBarrier: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxEntries: number,
    private readonly load: (key: string, signal: AbortSignal) => Promise<string>,
    private readonly release: (value: string) => void,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("AssetCache maxEntries must be a positive integer");
    }
  }

  get size(): number { return this.entries.size; }

  get(key: string): Promise<string> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }
    while (this.entries.size >= this.maxEntries) this.evictOldest();
    const controller = new AbortController();
    let entry: Entry;
    const promise = this.releaseBarrier.then(() => {
      if (controller.signal.aborted) throw new DOMException("Asset loading cancelled", "AbortError");
      return this.load(key, controller.signal);
    }).catch((error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    entry = { promise, controller };
    this.entries.set(key, entry);
    return promise;
  }

  clear(): void {
    while (this.entries.size) this.evictOldest();
  }

  private evictOldest(): void {
    const oldest = this.entries.entries().next();
    if (oldest.done) return;
    const [key, entry] = oldest.value;
    this.entries.delete(key);
    entry.controller.abort();
    const released = entry.promise.then((value) => this.release(value), () => undefined);
    this.releaseBarrier = Promise.all([this.releaseBarrier, released]).then(() => undefined);
  }
}
