// 受限网络读取：拒绝非 2xx/空 body，并按上限逐块校验总大小，防止超额输入。
export type BoundedReadFailure = "http" | "limit" | "no-body";

export class BoundedReadError extends Error {
  constructor(readonly reason: BoundedReadFailure) {
    super(reason === "limit" ? "Bounded read exceeded limit" : "Bounded read failed");
    this.name = "BoundedReadError";
  }
}

export async function readBounded(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.ok) throw new BoundedReadError("http");
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
