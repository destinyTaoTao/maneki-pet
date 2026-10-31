/**
 * 迟到结果闸门（architecture §4.1：同一 request 的迟到结果不覆盖新结果）。
 * 每个实例是一个"最新请求"槽位：新 submit 使旧请求变为过期，
 * 过期请求的迟到结果与迟到失败都被丢弃（返回 undefined）。
 */
export class LatestResultGate<T> {
  private latestRequestId: string | undefined;

  submit(requestId: string, promise: Promise<T>): Promise<T | undefined> {
    this.latestRequestId = requestId;
    const isLatest = (): boolean => this.latestRequestId === requestId;
    return promise.then(
      (value) => (isLatest() ? value : undefined),
      (error) => {
        if (!isLatest()) {
          return undefined;
        }
        throw error;
      },
    );
  }
}
