import { closeSync, openSync, readSync } from "node:fs";

/** 只读取有限容器头；完整格式仍由独立解码器验证。 */
export function mediaContainerMime(absolute) {
  const buffer = Buffer.alloc(4096);
  const handle = openSync(absolute, "r");
  let size;
  try { size = readSync(handle, buffer, 0, buffer.length, 0); }
  finally { closeSync(handle); }
  const head = buffer.subarray(0, size);
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 5 && head.readUInt32BE(0) === 0x1a45dfa3) {
    const root = vint(head, 4);
    const end = root.next + root.value;
    if (end > head.length) throw new Error("EBML header exceeds inspection budget");
    let offset = root.next;
    let docType;
    while (offset < end) {
      const id = vint(head, offset, true);
      const length = vint(head, id.next);
      const next = length.next + length.value;
      if (next > end) throw new Error("invalid EBML header");
      if (id.value === 0x4282) {
        if (docType !== undefined) throw new Error("duplicate EBML DocType");
        docType = head.toString("latin1", length.next, next);
      }
      offset = next;
    }
    if (docType === "webm") return "video/webm";
    throw new Error("container is not WebM");
  }
  // QuickTime ftyp：major brand 或按四字节对齐的 compatible brand 必须含 qt。
  for (let offset = 0; offset + 8 <= head.length;) {
    let length = head.readUInt32BE(offset);
    const type = head.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (length === 1) {
      if (offset + 16 > head.length) break;
      length = Number(head.readBigUInt64BE(offset + 8));
      header = 16;
    }
    if (!Number.isSafeInteger(length) || length < header || offset + length > head.length) break;
    if (type === "ftyp" && length >= header + 8) {
      const payload = offset + header;
      if (head.toString("latin1", payload, payload + 4) === "qt  ") return "video/quicktime";
      for (let i = payload + 8; i + 4 <= offset + length; i += 4) {
        if (head.toString("latin1", i, i + 4) === "qt  ") return "video/quicktime";
      }
      break;
    }
    offset += length;
  }
  throw new Error("unsupported media container");
}

function vint(buffer, offset, isId = false) {
  const first = buffer[offset];
  if (!first) throw new Error("invalid EBML integer");
  let marker = 0x80;
  let length = 1;
  while (!(first & marker)) { marker >>= 1; length += 1; }
  if (length > (isId ? 4 : 8) || offset + length > buffer.length) throw new Error("invalid EBML integer length");
  let value = isId ? first : first & (marker - 1);
  for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i];
  if (!Number.isSafeInteger(value)) throw new Error("EBML integer exceeds inspection budget");
  return { value, next: offset + length };
}
