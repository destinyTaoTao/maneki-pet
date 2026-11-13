import { sessionPhases, type ObservedSession, type SessionObservationSource } from "@maneki-pet/core";
import { validateObject } from "./validate.js";

interface Source extends SessionObservationSource { reportSequence: number }
export class ObservationReportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const invalid = (): never => { throw new ObservationReportError(400, "observation_report_invalid"); };

/** 只保留来源有界的观察快照，租约失效后保留最后观测事实。 */
export class SessionObservations {
  private readonly sources = new Map<string, Source>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  constructor(private readonly deps: { active(clientId: string): boolean; publish(): void; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }
  report(clientId: string, raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const { sessions, ...header } = raw as Record<string, unknown>;
    const checked = validateObject(header, {
      sourceId: { type: "string", required: true, maxLength: 36 },
      reportSequence: { type: "number", required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
      profileId: { type: "string", required: true, maxLength: 64 },
      connected: { type: "boolean", required: true },
      truncated: { type: "boolean", required: true },
    });
    if (!checked.ok || !Array.isArray(sessions) || sessions.length > 64) return invalid();
    const h = checked.value;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(h.sourceId)) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(String(h.profileId)) || !Number.isSafeInteger(h.reportSequence)) return invalid();
    const rows: ObservedSession[] = [];
    const ids = new Set<string>();
    for (const row of sessions) {
      const item = validateObject(row, {
        sessionId: { type: "string", required: true, maxLength: 160 },
        projectName: { type: "string", required: true, maxLength: 80 },
        phase: { type: "string", required: true, maxLength: 20, enumValues: sessionPhases },
        sequence: { type: "number", required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
        observedAt: { type: "number", required: true, min: 0, max: this.now() + 60000 },
      });
      if (!item.ok) return invalid();
      const value = item.value as unknown as ObservedSession;
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value.sessionId) || /[\\/\r\n]/.test(value.projectName) ||
          !Number.isSafeInteger(value.sequence) || !Number.isSafeInteger(value.observedAt) || ids.has(value.sessionId)) return invalid();
      ids.add(value.sessionId);
      rows.push(value);
    }
    this.refresh();
    const key = `${clientId}:${h.sourceId}`;
    const previous = this.sources.get(key);
    if (previous && Number(h.reportSequence) <= previous.reportSequence) return;
    if (previous && previous.profileId !== h.profileId) return invalid();
    for (const row of rows) {
      const older = previous?.sessions.find((item) => item.sessionId === row.sessionId);
      if (older && (row.sequence < older.sequence || (row.sequence === older.sequence && JSON.stringify(row) !== JSON.stringify(older))))
        throw new ObservationReportError(409, "observation_sequence_conflict");
    }
    if (!previous && this.sources.size >= 64) {
      const offline = [...this.sources].filter(([, source]) => !source.connected).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!offline) throw new ObservationReportError(429, "observation_source_limit");
      this.sources.delete(offline[0]);
    }
    const next: Source = { clientId, sourceId: String(h.sourceId), profileId: String(h.profileId),
      reportSequence: Number(h.reportSequence), connected: Boolean(h.connected), truncated: Boolean(h.truncated),
      lastSeenAt: this.now(), sessions: rows };
    this.sources.set(key, next);
    if (!previous || previous.connected !== next.connected || previous.truncated !== next.truncated || JSON.stringify(previous.sessions) !== JSON.stringify(rows)) this.deps.publish();
    if (!this.timer) {
      this.timer = setInterval(() => this.refresh(), 1000);
      this.timer.unref();
    }
  }
  snapshot(): SessionObservationSource[] {
    this.refresh();
    return [...this.sources.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(({ reportSequence: _sequence, ...source }) =>
      ({ ...source, sessions: source.sessions.map((row) => ({ ...row })) }));
  }
  close(): void { clearInterval(this.timer); this.timer = undefined; this.sources.clear(); }
  private refresh(): void {
    let changed = false;
    for (const source of this.sources.values()) {
      if (source.connected && (this.now() - source.lastSeenAt >= 15000 || !this.deps.active(source.clientId))) {
        source.connected = false;
        changed = true;
      }
    }
    if (changed) this.deps.publish();
  }
}
