/** 展示前确认 Windows 原生电源代数；不可信观察不得放行候选。 */
export class CompanionPowerGuard {
  private observed: number | undefined;
  private failed = false;
  constructor(private readonly read: () => Promise<number>, private readonly invalidate: () => void) {}
  async checkVisible(readVisible: () => Promise<boolean>, pageVisible: () => boolean = () => true): Promise<boolean> {
    if (!await this.check()) return false;
    const visible = await readVisible();
    return (await this.check()) && visible && pageVisible();
  }
  async check(): Promise<boolean> {
    try {
      const current = await this.read();
      if (!Number.isSafeInteger(current) || current < 0) throw new Error("invalid generation");
      if (this.observed !== undefined && current !== this.observed) {
        if (current > this.observed) this.observed = current;
        this.invalidate();
        return false;
      }
      this.observed = current;
      this.failed = false;
      return true;
    } catch {
      if (!this.failed) this.invalidate();
      this.failed = true;
      return false;
    }
  }
}
