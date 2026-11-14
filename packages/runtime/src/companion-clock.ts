/** 墙钟决定日期，单调时钟识别进程内跳变；异常后至少保守等待两小时。 */
export class CompanionClock {
  private last: {
    wall: number;
    mono: number;
  } | undefined;
  private blockedUntil: number | null = null;
  constructor(private readonly wallNow: () => number = Date.now, private readonly monoNow: () => number = () => performance.now()) { }
  sample(lastTrustedWallAt: number): {
    nowMs: number;
    monoMs: number;
    trusted: boolean;
  } {
    const nowMs = this.wallNow(), monoMs = this.monoNow();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(monoMs) || !Number.isSafeInteger(lastTrustedWallAt))
      return { nowMs, monoMs, trusted: false };
    if (!this.last && nowMs < lastTrustedWallAt)
      this.blockedUntil = monoMs + 7200000;
    if (this.last && (monoMs < this.last.mono || Math.abs((nowMs - this.last.wall) - (monoMs - this.last.mono)) > 1000))
      this.blockedUntil = monoMs + 7200000;
    this.last = { wall: nowMs, mono: monoMs };
    const trusted = nowMs >= lastTrustedWallAt && (this.blockedUntil === null || monoMs >= this.blockedUntil);
    if (trusted)
      this.blockedUntil = null;
    return { nowMs, monoMs, trusted };
  }
}
