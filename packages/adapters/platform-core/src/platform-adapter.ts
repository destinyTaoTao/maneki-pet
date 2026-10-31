/**
 * 平台对接器框架（architecture §10.2）：Gateway 层新 Adapter 类型。
 * 能力枚举限定为草稿、发布就绪包导出、回执采集与只读数据解析——
 * 不做发送类自动化（合规红线：AI 备料 + 人工发布 + 证据回流）。
 */
export type PlatformCapability = "draft" | "package_export" | "receipt_capture" | "ops_data_parsing";

export interface PlatformCapabilities {
  capabilities: readonly PlatformCapability[];
  /** 人工发布入口（native route）：dsh/平台创作中心的用户可达地址。 */
  manualPublishRoute: string;
}

/** 内容草稿：六步逐次确认（任务要求：用户逐次确认，无全自动档）。 */
export type DraftStep = "topic" | "script" | "title" | "intro" | "tags" | "cover";

export const DRAFT_STEPS: readonly DraftStep[] = ["topic", "script", "title", "intro", "tags", "cover"];

export interface PublishDraft {
  topic: string;
  script: string;
  title: string;
  intro: string;
  tags: string[];
  /** 封面建议：文案与构图要点；封面图片由用户提供（AI 不生成图片）。 */
  coverSuggestion: string;
}

export type DraftStepRecord = { step: DraftStep; confirmedAt: string };

/** 逐步确认状态机：只能按顺序确认当前步；每步一次显式用户确认。 */
export class DraftFlow {
  private readonly records: DraftStepRecord[] = [];

  constructor(
    public readonly draft: PublishDraft,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get confirmedSteps(): readonly DraftStepRecord[] {
    return this.records;
  }

  get currentStep(): DraftStep | null {
    return DRAFT_STEPS[this.records.length] ?? null;
  }

  get complete(): boolean {
    return this.records.length === DRAFT_STEPS.length;
  }

  /** 显式用户确认当前步；跳步/重复确认/未知步拒绝。 */
  confirm(step: DraftStep): DraftStepRecord {
    const expected = this.currentStep;
    if (expected === null) {
      throw new Error("draft already fully confirmed");
    }
    if (step !== expected) {
      throw new Error(`draft confirmation out of order: expected "${expected}", got "${step}"`);
    }
    const record: DraftStepRecord = { step, confirmedAt: this.now().toISOString() };
    this.records.push(record);
    return record;
  }
}
