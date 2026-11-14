import type { CompanionReference } from "@maneki-pet/core";
import type { AssistantStore } from "./assistant-store.js";
import { AssistantError } from "./assistant-settings.js";

/** 已提交的引用与消息共享事务，调用方负责验证来源及引用期限。 */
export class CompanionReferences {
  constructor(private readonly store: AssistantStore) {}

  put(epoch: number, userSeq: number, reference: CompanionReference): void {
    this.store.set(`companion.reference.${epoch}.${userSeq}`, JSON.stringify({
      formatVersion: 1, epoch, userSeq, ...reference,
    }));
  }

  get(epoch: number, userSeq: number): CompanionReference | undefined {
    const raw = this.store.get(`companion.reference.${epoch}.${userSeq}`);
    if (raw === null) return undefined;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.formatVersion !== 1 || value.epoch !== epoch || value.userSeq !== userSeq ||
          typeof value.utteranceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.utteranceId) ||
          typeof value.text !== "string" || value.text.length === 0 || value.text.length > 80 ||
          (value.mode !== "automatic" && value.mode !== "manual") ||
          !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0 || Number(value.createdAt) > 253402300799999) throw new Error();
      return { utteranceId: value.utteranceId, text: value.text, mode: value.mode, createdAt: value.createdAt as number };
    } catch {
      throw new AssistantError(503, "companion_state_unavailable");
    }
  }

  clear(): void { this.store.clearCompanionReferences(); }
  pruneOrphans(): void { this.store.transaction(() => this.store.pruneCompanionReferences()); }
}
