import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { AssistantError } from "./assistant-settings.js";

export interface SpeechHostRegistration {
  protocolVersion: 1;
  sourceSecret: string;
  sourceId: string;
  providerId: string;
  locality: "local";
  languages: string[];
  ready: boolean;
}
type Host = SpeechHostRegistration & { clientId: string; expires: number };
type Job = {
  id: string; clientId: string; sourceId: string; sourceSecret: string; providerId: string; audio: Uint8Array | undefined; language: string;
  claimed: boolean; cancelled: boolean; finish: (error?: AssistantError, text?: string, settled?: boolean) => void;
};

/** 受限来源的内存队列；不暴露其他客户端工作，也不持久化音频。 */
export class SpeechHostBroker {
  private readonly hosts = new Map<string, Host>();
  private job: Job | undefined;
  constructor(private readonly active: (client: string) => boolean, private readonly now = Date.now, private readonly persistence?: { get(): string | null; set(value: string): void }) {}
  busy(): boolean { return Boolean(this.job || this.persistence?.get()); }
  private key(client: string, source: string) { return `${client}:${source}`; }
  private live(host: Host) { return host.ready && host.expires > this.now() && this.active(host.clientId); }
  register(clientId: string, raw: SpeechHostRegistration): void {
    if (!this.active(clientId) || !raw || raw.protocolVersion !== 1 || typeof raw.sourceSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.sourceSecret) || typeof raw.sourceId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.sourceId) ||
        typeof raw.providerId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(raw.providerId) || raw.locality !== "local" ||
        typeof raw.ready !== "boolean" || !Array.isArray(raw.languages) || raw.languages.length > 8 ||
        raw.languages.some((v) => !["zh", "en", "auto"].includes(v))) throw new AssistantError(400, "speech_host_invalid");
    const key = this.key(clientId, raw.sourceId);
    const existing = this.hosts.get(key);
    if (existing && existing.expires > this.now() && !this.authorized(existing, raw.sourceSecret)) throw new AssistantError(403, "speech_host_invalid");
    if (!this.hosts.has(key) && this.hosts.size >= 64) {
      for (const [k, v] of this.hosts) if (!this.live(v)) this.hosts.delete(k);
      if (this.hosts.size >= 64) throw new AssistantError(429, "speech_host_limit");
    }
    this.hosts.set(key, { ...raw, languages: [...raw.languages], clientId, expires: this.now() + 15000 });
    if (!raw.ready && this.job?.clientId === clientId && this.job.sourceId === raw.sourceId)
      this.job.finish(new AssistantError(503, "asr_host_unavailable"));
  }
  private authorized(host: Host | undefined, secret: string): boolean {
    return Boolean(host && typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret) && timingSafeEqual(Buffer.from(host.sourceSecret), Buffer.from(secret)));
  }
  list() { return [...this.hosts.values()].filter((host) => this.live(host)).map(({ expires: _, sourceSecret: __, ...host }) => host); }
  available(clientId: string, sourceId: string, language: string): boolean {
    const host = this.hosts.get(this.key(clientId, sourceId));
    return Boolean(host && this.live(host) && host.languages.includes(language));
  }
  async transcribe(clientId: string, sourceId: string, audio: Uint8Array, language: string, signal: AbortSignal): Promise<{ text: string }> {
    if (!this.available(clientId, sourceId, language)) throw new AssistantError(503, "asr_host_unavailable");
    if (this.busy()) throw new AssistantError(409, "voice_host_cleanup_pending");
    if (signal.aborted) throw new AssistantError(499, "voice_cancelled");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const onAbort = () => finish(new AssistantError(499, "voice_cancelled"));
      const providerId = this.hosts.get(this.key(clientId, sourceId))!.providerId;
      const sourceSecret = this.hosts.get(this.key(clientId, sourceId))!.sourceSecret;
      const timer = setInterval(() => { if (!this.available(clientId, sourceId, language) || this.hosts.get(this.key(clientId, sourceId))?.providerId !== providerId || !this.authorized(this.hosts.get(this.key(clientId, sourceId)), sourceSecret)) finish(new AssistantError(503, "asr_host_unavailable")); }, 500);
      const deadline = setTimeout(() => finish(new AssistantError(504, "speech_timeout")), 45000);
      timer.unref();
      deadline.unref();
      const finish = (error?: AssistantError, text?: string, settled = false) => {
        if (this.job?.id !== id || this.job.cancelled) return;
        clearInterval(timer); clearTimeout(deadline); signal.removeEventListener("abort", onAbort);
        this.job.audio = undefined;
        if (error && this.job.claimed && !settled) this.job.cancelled = true;
        else { this.job = undefined; this.persistence?.set(""); }
        if (error) reject(error); else resolve({ text: text! });
      };
      this.job = { id, clientId, sourceId, sourceSecret, providerId, audio: audio.slice(), language, claimed: false, cancelled: false, finish };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  claim(clientId: string, sourceId: string, secret: string): { jobId: string; audio: string; language: string; providerId: string } | null {
    const job = this.job;
    if (!job || job.clientId !== clientId || job.sourceId !== sourceId || job.claimed || !this.authorized(this.hosts.get(this.key(clientId, sourceId)), job.sourceSecret) || !this.authorized(this.hosts.get(this.key(clientId, sourceId)), secret) || !this.available(clientId, sourceId, job.language) || this.hosts.get(this.key(clientId, sourceId))?.providerId !== job.providerId) return null;
    job.claimed = true;
    this.persistence?.set(JSON.stringify({ clientId, sourceId, jobId: job.id, secret: createHash("sha256").update(secret).digest("hex") }));
    const audio = Buffer.from(job.audio!).toString("base64");
    job.audio = undefined;
    return { jobId: job.id, audio, language: job.language, providerId: job.providerId };
  }
  pending(clientId: string, sourceId: string, secret: string, jobId: string): boolean {
    const job = this.job;
    return Boolean(job && job.claimed && !job.cancelled && job.id === jobId && job.clientId === clientId && job.sourceId === sourceId && this.authorized(this.hosts.get(this.key(clientId, sourceId)), job.sourceSecret) && this.authorized(this.hosts.get(this.key(clientId, sourceId)), secret) && this.available(clientId, sourceId, job.language) && this.hosts.get(this.key(clientId, sourceId))?.providerId === job.providerId);
  }
  complete(clientId: string, sourceId: string, secret: string, jobId: string, text: string): boolean {
    if (!this.pending(clientId, sourceId, secret, jobId) || typeof text !== "string" || !text.trim() || text.length > 4000) return false;
    this.job!.finish(undefined, text.trim()); return true;
  }
  fail(clientId: string, sourceId: string, secret: string, jobId: string): boolean {
    if (!this.pending(clientId, sourceId, secret, jobId)) return false;
    this.job!.finish(new AssistantError(503, "speech_failed"), undefined, true); return true;
  }
  acknowledge(clientId: string, sourceId: string, secret: string, jobId: string): boolean {
    const job = this.job;
    if (job && (job.id !== jobId || job.clientId !== clientId || job.sourceId !== sourceId || secret !== job.sourceSecret)) return false;
    let saved: { clientId: string; sourceId: string; jobId: string; secret: string };
    try { saved = JSON.parse(this.persistence?.get() || "null"); } catch { return false; }
    if (this.persistence && (!saved || saved.clientId !== clientId || saved.sourceId !== sourceId || saved.jobId !== jobId || saved.secret !== createHash("sha256").update(secret).digest("hex"))) return false;
    if (!job && !this.persistence?.get()) return false;
    if (job && !job.cancelled) job.finish(new AssistantError(503, "asr_host_unavailable"), undefined, true);
    this.job = undefined; this.persistence?.set(""); return true;
  }
  recover(): boolean {
    if ([...this.hosts.values()].some((host) => host.expires > this.now() && this.active(host.clientId)) || (this.job && !this.job.cancelled)) return false;
    this.job = undefined; this.persistence?.set(""); return true;
  }
  revoke(clientId: string): void {
    for (const [key, host] of this.hosts) if (host.clientId === clientId) this.hosts.delete(key);
    if (this.job?.clientId === clientId) this.job.finish(new AssistantError(503, "asr_host_unavailable"));
  }
}
