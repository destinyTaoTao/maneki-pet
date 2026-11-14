/** 轻陪伴协议 v1。时间均为 UTC Unix 毫秒；不携带鉴权身份。 */
export interface CompanionPreferences {
  murmurEnabled: boolean;
  murmurSnoozedUntil: number | null;
}
export interface CompanionAttempt {
  utteranceId: string;
  at: number;
  dayKey: string;
  timeZone: string;
  templateId: string;
  contentHash: string;
}
export interface CompanionUsedTemplate {
  templateId: string;
  contentHash: string;
  lastUsedAt: number;
}
export interface CompanionBudget {
  formatVersion: 1;
  initializedAt: number;
  firstEligibleAt: number | null;
  lastTrustedWallAt: number;
  lastAutomaticAttemptAt: number | null;
  attempts: CompanionAttempt[];
  usedTemplates: CompanionUsedTemplate[];
  lastAutomaticTheme: string | null;
}
export type CompanionBusyReason = "input" | "voice" | "drag" | "panel" | "important";
export interface CompanionDisplayState {
  visible: boolean;
  busyReasons: CompanionBusyReason[];
  activitySeq: number;
}
export interface CompanionLease {
  runtimeEpoch: string;
  connectionId: string;
  displayInstanceId: string;
  leaseId: string;
  stateSeq: number;
  serverNow: number;
  expiresAt: number;
  leaseMs: 15000;
  policyRevision: number;
}
export interface CompanionUtterance {
  runtimeEpoch: string;
  displayInstanceId: string;
  leaseId: string;
  utteranceId: string;
  protocolVersion: 1;
  mode: "automatic" | "manual";
  templateId: string;
  theme: string;
  text: string;
  actionId: string | null;
  createdAt: number;
  expiresAt: number;
  replyExpiresAt: number;
  displayStateSeq: number;
  policyRevision: number;
  settingsVersion: number;
  historyEpoch: number;
  displayDurationMs: 6000;
}
export interface CompanionReplyTo {
  runtimeEpoch: string;
  displayInstanceId: string;
  utteranceId: string;
}
export interface CompanionReference {
  utteranceId: string;
  text: string;
  mode: "automatic" | "manual";
  createdAt: number;
}
export const companionLimits = { minIntervalMs: 7200000, maxPerLocalDay: 4, maxPerRolling24h: 4, leaseMs: 15000, renewEveryMs: 5000, candidateTtlMs: 15000, replyTtlMs: 600000 } as const;
export type CompanionAutomaticBlock = "disabled" | "snoozed" | "dnd" | "storage_unavailable" | "clock_untrusted" | "no_display" | "warming_up" | "budget" | "no_content" | null;
export interface CompanionPolicyEvent {
  runtimeEpoch: string;
  policyRevision: number;
  settingsVersion: number;
  historyEpoch: number;
  dnd: boolean;
  companion: CompanionPreferences | null;
  healthy: boolean;
}
export interface CompanionStatus extends Omit<CompanionPolicyEvent, "healthy"> {
  protocolVersion: 1;
  serverNow: number;
  automaticBlock: CompanionAutomaticBlock;
  nextEligibleAt: number | null;
  limits: typeof companionLimits;
}
interface CompanionRequest {
  protocolVersion: 1;
  runtimeEpoch: string;
}
export interface CompanionAcquireRequest extends CompanionRequest {
  connectionId: string;
  displayInstanceId: string;
  state: CompanionDisplayState;
}
export interface CompanionRenewRequest extends CompanionRequest {
  leaseId: string;
  stateSeq: number;
  state: CompanionDisplayState;
}
export interface CompanionReleaseRequest extends CompanionRequest {
  leaseId: string;
}
export interface CompanionSayRequest extends CompanionReleaseRequest {
  requestId: string;
  requestSeq: number;
}
export interface CompanionSayResponse {
  utterance: CompanionUtterance;
  supersedes: string[];
}
export interface CompanionAckRequest extends CompanionReleaseRequest {
  utteranceId: string;
  result: "displayed" | "discarded";
}
export type CompanionAcquireResponse = CompanionLease;
export type CompanionRenewResponse = CompanionLease;
export interface CompanionReleaseResponse {
  released: true;
}
export interface CompanionAckResponse {
  recorded: true;
}
