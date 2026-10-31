import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { TicketIssuer } from "./auth.js";
import type { EventFeed, RuntimeEvent } from "./events.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface ReadySocket {
  socket: Duplex;
  clientId: string;
}

/**
 * 最小 RFC6455 服务器（仅文本帧 + ping/close），鉴权用一次性短期票据：
 * 握手后第一条消息必须是 {"type":"auth","ticket":"..."}，超时/错误/重放
 * 一律关闭。票据不在 URL/query 中传递（§6.1）。
 */
export class WsHub {
  private readonly ready = new Set<ReadySocket>();
  private readonly tickets: TicketIssuer;
  private readonly feed: EventFeed;
  private readonly authTimeoutMs: number;
  private unsubscribe: (() => void) | undefined;

  constructor(deps: { tickets: TicketIssuer; feed: EventFeed; authTimeoutMs?: number }) {
    this.tickets = deps.tickets;
    this.feed = deps.feed;
    this.authTimeoutMs = deps.authTimeoutMs ?? 5_000;
  }

  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const url = (req.url ?? "").split("?")[0] ?? "";
      const key = req.headers["sec-websocket-key"];
      if (url !== "/v1/events" || !key || req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.awaitAuthentication(socket);
    });
    this.unsubscribe = this.feed.subscribe((event) => {
      this.broadcast({ type: "event", event });
    });
  }

  detach(): void {
    this.unsubscribe?.();
    for (const connection of this.ready) {
      this.closeSocket(connection.socket, 1001, "server stopping");
    }
    this.ready.clear();
  }

  private awaitAuthentication(socket: Duplex): void {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        this.closeSocket(socket, 4001, "auth timeout");
      }
    }, this.authTimeoutMs);

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = this.readFrame(buffer);
      if (!frame) {
        return;
      }
      socket.off("data", onData);
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      const authCheck = this.authenticateFrame(frame);
      if (!authCheck.ok) {
        this.closeSocket(socket, 4001, authCheck.reason);
        return;
      }
      this.ready.add({ socket, clientId: authCheck.clientId });
      this.send(socket, JSON.stringify({ type: "ready" }));
      socket.on("data", (later: Buffer) => this.handleLaterFrames(socket, later));
    };
    socket.on("data", onData);
    socket.on("close", () => {
      clearTimeout(timer);
      for (const connection of this.ready) {
        if (connection.socket === socket) {
          this.ready.delete(connection);
        }
      }
    });
  }

  private authenticateFrame(frame: { opcode: number; payload: Buffer }): { ok: true; clientId: string } | { ok: false; reason: string } {
    if (frame.opcode !== 0x1) {
      return { ok: false, reason: "first frame must be a text auth message" };
    }
    let message: unknown;
    try {
      message = JSON.parse(frame.payload.toString("utf8"));
    } catch {
      return { ok: false, reason: "auth message is not valid JSON" };
    }
    const ticket = (message as { type?: string; ticket?: unknown }).ticket;
    if ((message as { type?: string }).type !== "auth" || typeof ticket !== "string") {
      return { ok: false, reason: "auth message must be {type:\"auth\", ticket}" };
    }
    if (!this.tickets.redeem(ticket)) {
      return { ok: false, reason: "ticket invalid, expired or already redeemed" };
    }
    return { ok: true, clientId: "ticket-holder" };
  }

  private handleLaterFrames(socket: Duplex, chunk: Buffer): void {
    let buffer = chunk;
    while (buffer.length > 0) {
      const frame = this.readFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.subarray(frame.totalLength);
      if (frame.opcode === 0x8) {
        this.closeSocket(socket, 1000, "bye");
        return;
      }
      if (frame.opcode === 0x9) {
        this.sendRaw(socket, 0x0a, frame.payload);
      }
    }
  }

  private broadcast(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    for (const connection of this.ready) {
      this.send(connection.socket, text);
    }
  }

  /** 服务端帧不掩码；只支持文本 payload。 */
  private send(socket: Duplex, text: string): void {
    this.sendRaw(socket, 0x1, Buffer.from(text, "utf8"));
  }

  private sendRaw(socket: Duplex, opcode: number, payload: Buffer): void {
    if (socket.destroyed) {
      return;
    }
    const length = payload.length;
    let header: Buffer;
    if (length <= 125) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  private closeSocket(socket: Duplex, code: number, reason: string): void {
    const payload = Buffer.concat([
      Buffer.from([Math.floor(code / 256), code % 256]),
      Buffer.from(reason, "utf8").subarray(0, 100),
    ]);
    this.sendRaw(socket, 0x8, payload);
    socket.end();
    setTimeout(() => socket.destroy(), 200);
  }

  private readFrame(buffer: Buffer): { opcode: number; payload: Buffer; totalLength: number } | null {
    if (buffer.length < 2) {
      return null;
    }
    const first = buffer[0] as number;
    const second = buffer[1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) {
        return null;
      }
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) {
        return null;
      }
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(64 * 1024 * 1024)) {
        return { opcode, payload: Buffer.alloc(0), totalLength: buffer.length };
      }
      length = Number(big);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) {
      return null;
    }
    let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(offset, offset + maskLength);
      const unmasked = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        unmasked[index] = (payload[index] as number) ^ (mask[index % 4] as number);
      }
      payload = unmasked;
    }
    return { opcode, payload, totalLength: offset + maskLength + length };
  }
}

export type { RuntimeEvent };
