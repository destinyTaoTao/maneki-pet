import { randomUUID } from "node:crypto";
import type { CompanionAcquireRequest, CompanionRenewRequest, CompanionReleaseRequest, CompanionLease, CompanionDisplayState } from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";
interface Entry {
  clientId: string;
  lease: CompanionLease;
  acquiredLease: CompanionLease;
  state: CompanionDisplayState;
  acquire: string;
  renew: string | null;
  deadline: number;
  terminal: boolean;
  released: boolean;
  activity: number;
  order: number;
}
const stateKey = (state: CompanionDisplayState) => [state.visible, [...state.busyReasons].sort(), state.activitySeq];
interface Dependencies {
  runtimeEpoch: string;
  now: () => number;
  mono: () => number;
  scopes: (clientId: string) => string[] | undefined;
  ownsConnection: (clientId: string, connectionId: string) => boolean;
  policyRevision: () => number;
}
/** 单条已鉴权 socket 的租约状态。终态连接只能重建 socket，不允许重新登记。 */
export class CompanionLeases {
  private readonly entries = new Map<string, Entry>();
  private serial = 0;
  constructor(private readonly deps: Dependencies) { }
  private error(status: number, code: string): never { throw new AssistantError(status, code); }
  private identity(client: string, epoch: string): void {
    if (!this.deps.scopes(client)?.includes("assistant"))
      this.error(403, "assistant_scope_required");
    if (epoch !== this.deps.runtimeEpoch)
      this.error(409, "companion_epoch_changed");
  }
  private alive(e: Entry): boolean {
    if (e.terminal)
      return false;
    if (!this.deps.scopes(e.clientId)?.includes("assistant") || !this.deps.ownsConnection(e.clientId, e.lease.connectionId) || this.deps.mono() >= e.deadline || this.deps.now() >= e.lease.expiresAt || this.deps.now() < e.lease.serverNow) {
      e.terminal = true;
      return false;
    }
    return true;
  }
  private find(client: string, id: string): Entry {
    const e = [...this.entries.values()].find(e => e.lease.leaseId === id);
    if (e && e.clientId !== client)
      return this.error(404, "companion_display_not_found");
    if (!e || !this.alive(e))
      return this.error(410, "companion_lease_expired");
    return e;
  }
  acquire(clientId: string, request: CompanionAcquireRequest): CompanionLease {
    this.identity(clientId, request.runtimeEpoch);
    if (!this.deps.ownsConnection(clientId, request.connectionId))
      return this.error(404, "companion_display_not_found");
    const body = JSON.stringify([request.protocolVersion, request.runtimeEpoch, request.connectionId, request.displayInstanceId, stateKey(request.state)]), old = this.entries.get(request.connectionId);
    if (old) {
      if (!this.alive(old))
        return this.error(410, "companion_lease_expired");
      if (old.acquire !== body)
        return this.error(409, "companion_display_conflict");
      return structuredClone(old.acquiredLease);
    }
    const active = [...this.entries.values()].filter(e => this.alive(e));
    if (active.length >= 32 || active.filter(e => e.clientId === clientId).length >= 4)
      return this.error(429, "companion_capacity");
    const now = this.deps.now(), lease: CompanionLease = { runtimeEpoch: this.deps.runtimeEpoch, connectionId: request.connectionId, displayInstanceId: request.displayInstanceId, leaseId: randomUUID(), stateSeq: 0, serverNow: now, expiresAt: now + 15000, leaseMs: 15000, policyRevision: this.deps.policyRevision() };
    this.entries.set(request.connectionId, { clientId, lease, acquiredLease: structuredClone(lease), state: structuredClone(request.state), acquire: body, renew: null, deadline: this.deps.mono() + 15000, terminal: false, released: false, activity: request.state.activitySeq > 0 ? ++this.serial : 0, order: ++this.serial });
    return structuredClone(lease);
  }
  renew(clientId: string, request: CompanionRenewRequest): CompanionLease {
    this.identity(clientId, request.runtimeEpoch);
    const e = this.find(clientId, request.leaseId), body = JSON.stringify([request.protocolVersion, request.runtimeEpoch, request.leaseId, request.stateSeq, stateKey(request.state)]);
    if (request.stateSeq === e.lease.stateSeq && e.renew === body)
      return structuredClone(e.lease);
    if (request.stateSeq !== e.lease.stateSeq + 1 || request.state.activitySeq < e.state.activitySeq)
      return this.error(409, "companion_sequence_conflict");
    if (request.state.activitySeq > e.state.activitySeq)
      e.activity = ++this.serial;
    e.state = structuredClone(request.state);
    e.renew = body;
    e.deadline = this.deps.mono() + 15000;
    e.lease = { ...e.lease, stateSeq: request.stateSeq, serverNow: this.deps.now(), expiresAt: this.deps.now() + 15000, policyRevision: this.deps.policyRevision() };
    return structuredClone(e.lease);
  }
  release(clientId: string, request: CompanionReleaseRequest): {
    released: true;
  } {
    this.identity(clientId, request.runtimeEpoch);
    const e = [...this.entries.values()].find(e => e.lease.leaseId === request.leaseId);
    if (e && e.clientId !== clientId)
      return this.error(404, "companion_display_not_found");
    if (e?.released && this.deps.ownsConnection(clientId, e.lease.connectionId))
      return { released: true };
    const live = this.find(clientId, request.leaseId);
    live.terminal = true;
    live.released = true;
    return { released: true };
  }
  get(clientId: string, leaseId: string): {
    lease: CompanionLease;
    state: CompanionDisplayState;
  } { const e = this.find(clientId, leaseId); return { lease: structuredClone(e.lease), state: structuredClone(e.state) }; }
  owner(leaseId: string): string | undefined { return [...this.entries.values()].find(e => e.lease.leaseId === leaseId && this.alive(e))?.clientId; }
  selectEligible(): CompanionLease | null {
    const e = [...this.entries.values()].filter(e => this.alive(e) && e.state.visible && e.state.busyReasons.length === 0).sort((a, b) => b.activity - a.activity || a.order - b.order)[0];
    return e ? structuredClone(e.lease) : null;
  }
  invalidateConnection(connectionId: string): void { this.entries.delete(connectionId); }
  invalidateClient(clientId: string): void {
    for (const [id, e] of this.entries)
      if (e.clientId === clientId)
        this.entries.delete(id);
  }
  close(): void { this.entries.clear(); }
}
