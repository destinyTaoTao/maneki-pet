import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CompanionLeases } from "../src/companion-leases.js";
function setup() { let now = 1000, mono = 0; const epoch = randomUUID(), connection = randomUUID(); const leases = new CompanionLeases({ runtimeEpoch: epoch, now: () => now, mono: () => mono, scopes: () => ["assistant"], ownsConnection: (c, id) => c === "a" && id === connection, policyRevision: () => 1 }); const request = { protocolVersion: 1 as const, runtimeEpoch: epoch, connectionId: connection, displayInstanceId: randomUUID(), state: { visible: true, busyReasons: [], activitySeq: 0 } }; return { leases, request, tick: (n: number) => { now += n; mono += n; } }; }
it("acquire and renew retry preserve original deadlines, expired sockets cannot resurrect", () => {
  const { leases, request, tick } = setup();
  const l = leases.acquire("a", request);
  tick(1000);
  expect(leases.acquire("a", request)).toEqual(l);
  const r = { protocolVersion: 1 as const, runtimeEpoch: request.runtimeEpoch, leaseId: l.leaseId, stateSeq: 1, state: request.state };
  const renewed = leases.renew("a", r);
  tick(1000);
  expect(leases.renew("a", r)).toEqual(renewed);
  expect(() => leases.renew("a", { ...r, stateSeq: 3 })).toThrow("companion_sequence_conflict");
  tick(15000);
  expect(() => leases.renew("a", { ...r, stateSeq: 2 })).toThrow("companion_lease_expired");
  expect(() => leases.acquire("a", request)).toThrow("companion_lease_expired");
});
it("does not expose another client's lease and excludes hidden/busy displays", () => {
  const { leases, request } = setup();
  const l = leases.acquire("a", request);
  expect(() => leases.release("b", { protocolVersion: 1, runtimeEpoch: request.runtimeEpoch, leaseId: l.leaseId })).toThrow("companion_display_not_found");
  expect(leases.selectEligible()?.leaseId).toBe(l.leaseId);
  leases.renew("a", { protocolVersion: 1, runtimeEpoch: request.runtimeEpoch, leaseId: l.leaseId, stateSeq: 1, state: { ...request.state, busyReasons: ["voice"] } });
  expect(leases.selectEligible()).toBeNull();
});
it("release and disconnect are terminal, including a repeated release", () => {
  const { leases, request } = setup();
  const l = leases.acquire("a", request);
  const r = { protocolVersion: 1 as const, runtimeEpoch: request.runtimeEpoch, leaseId: l.leaseId };
  expect(leases.release("a", r)).toEqual({ released: true });
  expect(leases.release("a", r)).toEqual({ released: true });
  expect(() => leases.acquire("a", request)).toThrow("companion_lease_expired");
  leases.invalidateConnection(request.connectionId);
  expect(() => leases.release("a", r)).toThrow("companion_lease_expired");
});
it("acquire response remains the original response even after renewal", () => {
  const { leases, request, tick } = setup();
  const original = leases.acquire("a", request);
  tick(1000);
  leases.renew("a", { protocolVersion: 1, runtimeEpoch: request.runtimeEpoch, leaseId: original.leaseId, stateSeq: 1, state: request.state });
  expect(leases.acquire("a", request)).toEqual(original);
});
it("JSON object field order does not change retry identity", () => {
  const { leases, request } = setup();
  const l = leases.acquire("a", request);
  const reordered = { state: { activitySeq: 0, busyReasons: [], visible: true }, displayInstanceId: request.displayInstanceId, connectionId: request.connectionId, runtimeEpoch: request.runtimeEpoch, protocolVersion: 1 as const };
  expect(leases.acquire("a", reordered)).toEqual(l);
});
it("wall-clock expiry also invalidates a lease when a platform monotonic clock pauses", () => {
  let wall = 1000;
  const connection = randomUUID(), epoch = randomUUID();
  const leases = new CompanionLeases({ runtimeEpoch: epoch, now: () => wall, mono: () => 0, scopes: () => ["assistant"], ownsConnection: () => true, policyRevision: () => 0 });
  const request = { protocolVersion: 1 as const, runtimeEpoch: epoch, connectionId: connection, displayInstanceId: randomUUID(), state: { visible: true, busyReasons: [], activitySeq: 0 } };
  leases.acquire("a", request);
  wall += 15000;
  expect(leases.selectEligible()).toBeNull();
});
it("selects by received activity order and rejects the fifth active display without eviction", () => {
  let mono = 0;
  const epoch = randomUUID();
  const leases = new CompanionLeases({ runtimeEpoch: epoch, now: () => 1000 + mono, mono: () => mono, scopes: () => ["assistant"], ownsConnection: () => true, policyRevision: () => 0 });
  const acquire = () => leases.acquire("a", { protocolVersion: 1, runtimeEpoch: epoch, connectionId: randomUUID(), displayInstanceId: randomUUID(), state: { visible: true, busyReasons: [], activitySeq: 0 } });
  const first = acquire(), second = acquire();
  acquire();
  acquire();
  expect(() => acquire()).toThrow("companion_capacity");
  expect(leases.selectEligible()?.leaseId).toBe(first.leaseId);
  leases.renew("a", { protocolVersion: 1, runtimeEpoch: epoch, leaseId: second.leaseId, stateSeq: 1, state: { visible: true, busyReasons: [], activitySeq: 1 } });
  expect(leases.selectEligible()?.leaseId).toBe(second.leaseId);
  mono = 15000;
  expect(leases.selectEligible()).toBeNull();
  expect(acquire()).toBeDefined();
});
