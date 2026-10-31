// 播放器资产缓存：按 key 缓存已加载的对象 URL，超过上限按 LRU 淘汰并释放，
// 满足 M1「播放器缓存上限」要求；URL 生命周期由注入的 release 回调管理。
export class AssetCache {
  private entries = new Map<string, Promise<string>>();

  constructor(
    private readonly maxEntries: number,
    private readonly load: (key: string) => Promise<string>,
    private readonly release: (value: string) => void,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("AssetCache maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** 返回缓存的对象 URL；并发请求合并为一次加载，命中项刷新 LRU 顺序。 */
  get(key: string): Promise<string> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const created = this.load(key).catch((error: unknown) => {
      // 加载失败的条目不占用缓存位，也不持有待释放资源。
      if (this.entries.get(key) === created) {
        this.entries.delete(key);
      }
      throw error;
    });
    this.entries.set(key, created);
    this.evict();
    return created;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      void entry.then((value) => this.release(value), () => undefined);
    }
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (entry) {
        void entry.then((value) => this.release(value), () => undefined);
      }
    }
  }
}
