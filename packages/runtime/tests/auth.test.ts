import { describe, expect, it } from "vitest";

import {
  TicketIssuer,
  checkHost,
  checkOrigin,
  generateToken,
  hashToken,
  parseBearer,
} from "../src/index.js";

describe("令牌", () => {
  it("随机令牌唯一且为 base64url", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("哈希稳定且不可逆区分不同令牌", () => {
    expect(hashToken("t1")).toBe(hashToken("t1"));
    expect(hashToken("t1")).not.toBe(hashToken("t2"));
    expect(hashToken("t1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Bearer 解析", () => {
  it("缺失返回 401，格式错返回 401，合法返回 token", () => {
    expect(parseBearer(undefined)).toEqual({ ok: false, status: 401, reason: expect.any(String) });
    expect(parseBearer("Basic abc")).toMatchObject({ ok: false, status: 401 });
    expect(parseBearer("Bearer abc_DEF-123")).toEqual({ ok: true, token: "abc_DEF-123" });
  });
});

describe("Host/Origin 校验", () => {
  it("Host 必须严格等于绑定地址", () => {
    expect(checkHost(undefined, "127.0.0.1:1")).toMatchObject({ ok: false, status: 403 });
    expect(checkHost("evil.example:1", "127.0.0.1:1")).toMatchObject({ ok: false, status: 403 });
    expect(checkHost("127.0.0.1:1", "127.0.0.1:1")).toEqual({ ok: true });
  });

  it("无 Origin 的本机工具放行（仍需 token/Host），浏览器 Origin 必须在白名单", () => {
    expect(checkOrigin(undefined, [])).toEqual({ ok: true });
    expect(checkOrigin("tauri://localhost", ["tauri://localhost"])).toEqual({ ok: true });
    expect(checkOrigin("https://evil.example", ["tauri://localhost"])).toMatchObject({ ok: false, status: 403 });
  });
});

describe("一次性 WS 票据", () => {
  it("签发后可兑换一次，重放被拒绝", () => {
    const issuer = new TicketIssuer();
    const { ticket } = issuer.issue(1_000);
    expect(issuer.redeem(ticket, 1_100)).toBe(true);
    expect(issuer.redeem(ticket, 1_200)).toBe(false);
  });

  it("过期票据不能兑换", () => {
    const issuer = new TicketIssuer();
    const { ticket } = issuer.issue(1_000);
    expect(issuer.redeem(ticket, 1_000 + 30_000 + 1)).toBe(false);
  });

  it("未知票据不能兑换", () => {
    const issuer = new TicketIssuer();
    expect(issuer.redeem("nope")).toBe(false);
  });

  it("过期票据被清理，不在发行器中无界累积", () => {
    const issuer = new TicketIssuer();
    for (let index = 0; index < 5; index += 1) {
      issuer.issue(index * 40_000);
    }
    expect(issuer.outstandingCount()).toBeLessThan(5);
  });
});
