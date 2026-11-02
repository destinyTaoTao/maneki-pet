// 受限网络读取：拒绝非 2xx/空 body，并按上限逐块校验总大小，防止超额输入。
export type BoundedReadFailure = "http" | "limit" | "no-body";
export const MEDIA_READ_TIMEOUT_MS = 30_000;
let mediaReadTail: Promise<void> = Promise.resolve();

/** 播放与校验共用素材读取通道；前次读取结束后才开始下一次。 */
export function readMedia(url: string, maxBytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const result = mediaReadTail.then(async () => {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(MEDIA_READ_TIMEOUT_MS);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return readBounded(response, maxBytes);
  });
  mediaReadTail = result.then(() => undefined, () => undefined);
  return result;
}

export class BoundedReadError extends Error {
  constructor(readonly reason: BoundedReadFailure) {
    super(reason === "limit" ? "Bounded read exceeded limit" : "Bounded read failed");
    this.name = "BoundedReadError";
  }
}

export async function readBounded(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new BoundedReadError("http");
  }
  if (!response.body) throw new BoundedReadError("no-body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BoundedReadError("limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
