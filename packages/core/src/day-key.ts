/** UTC 日界键：每日用量窗口与简报当日判定共用同一口径。 */
export function utcDayKey(clock: () => Date): string {
  return clock().toISOString().slice(0, 10);
}
