import type { CompanionUtterance } from "./companion-types.js";
export interface CompanionTemplate {
  id: string;
  theme: string;
  text: string;
  actionId: string | null;
  hours: readonly number[];
}
/** 随应用发行的原创角色台词，不推断用户行为。动作缺省为纯文字。 */
export const companionTemplates: readonly CompanionTemplate[] = [
  { "id": "company_1", "theme": "company", "text": "小招在这里，陪你把今天慢慢展开。", "actionId": null, "hours": [] },
  { "id": "company_2", "theme": "company", "text": "不用急着回应，我在旁边安静待着。", "actionId": null, "hours": [] },
  { "id": "company_3", "theme": "company", "text": "给今天留一点空白，也留一只小招。", "actionId": null, "hours": [] },
  { "id": "company_4", "theme": "company", "text": "我把尾巴收好了，这一小块桌面就交给我。", "actionId": null, "hours": [] },
  { "id": "stretch_1", "theme": "stretch", "text": "我先伸个懒腰，陪你慢慢来。", "actionId": null, "hours": [] },
  { "id": "stretch_2", "theme": "stretch", "text": "爪子往前伸一伸，小招的伸展时间到了。", "actionId": null, "hours": [] },
  { "id": "stretch_3", "theme": "stretch", "text": "把肩膀放松一点也不错，我先示范一个懒腰。", "actionId": null, "hours": [] },
  { "id": "stretch_4", "theme": "stretch", "text": "小招抖抖耳朵，换个舒服的姿势。", "actionId": null, "hours": [] },
  { "id": "cheer_1", "theme": "cheer", "text": "先走一小步也很好，小招给你招招手。", "actionId": null, "hours": [] },
  { "id": "cheer_2", "theme": "cheer", "text": "今天的好运先放这里，随时可以来拿。", "actionId": null, "hours": [] },
  { "id": "cheer_3", "theme": "cheer", "text": "给正在尝试的你，送一朵小小的纸花。", "actionId": null, "hours": [] },
  { "id": "cheer_4", "theme": "cheer", "text": "小招举爪：愿下一步比想象中顺利。", "actionId": null, "hours": [] },
  { "id": "quiet_1", "theme": "quiet", "text": "我把音量调到零，陪伴还在。", "actionId": null, "hours": [] },
  { "id": "quiet_2", "theme": "quiet", "text": "安静也是一种很舒服的相处方式。", "actionId": null, "hours": [] },
  { "id": "quiet_3", "theme": "quiet", "text": "这一刻不说大道理，小招只负责待在这里。", "actionId": null, "hours": [] },
  { "id": "quiet_4", "theme": "quiet", "text": "让思绪慢一点，我陪你守着这片小角落。", "actionId": null, "hours": [] },
  { "id": "play_1", "theme": "play", "text": "如果桌面有阳光，小招想在那里打个滚。", "actionId": null, "hours": [] },
  { "id": "play_2", "theme": "play", "text": "小招认真考虑了一下：今天也要做一只好猫。", "actionId": null, "hours": [] },
  { "id": "play_3", "theme": "play", "text": "给想象中的小鱼干排个队，第一条留给好运。", "actionId": null, "hours": [] },
  { "id": "play_4", "theme": "play", "text": "我练习了一次招财手势，感觉还挺像那么回事。", "actionId": null, "hours": [] },
  { "id": "greeting_1", "theme": "greeting", "text": "早安，小招把今天的第一声招呼放这里。", "actionId": null, "hours": [5, 6, 7, 8, 9, 10] },
  { "id": "greeting_2", "theme": "greeting", "text": "午间好，愿这一小段时光轻松些。", "actionId": null, "hours": [11, 12, 13] },
  { "id": "greeting_3", "theme": "greeting", "text": "下午好，给桌面添一点软乎乎的元气。", "actionId": null, "hours": [14, 15, 16, 17, 18] },
  { "id": "greeting_4", "theme": "greeting", "text": "晚上好，小招陪你把节奏放缓一点。", "actionId": null, "hours": [19, 20, 21, 22, 23, 0, 1, 2, 3, 4] },
];
export function selectCompanionTemplate(input: {
  mode: CompanionUtterance["mode"];
  hour: number;
  excludedIds: ReadonlySet<string>;
  lastTheme: string | null;
  lastTemplateId: string | null;
}, templates: readonly CompanionTemplate[]): CompanionTemplate | null {
  const pool = templates.filter(t => t.hours.length === 0 || t.hours.includes(input.hour));
  const fresh = pool.filter(t => !input.excludedIds.has(t.id) && (input.mode === "manual" || t.theme !== input.lastTheme) && t.id !== input.lastTemplateId);
  if (fresh.length)
    return fresh[0]!;
  if (input.mode === "automatic")
    return null;
  // 手动池耗尽才复用，仍不紧邻重复；单条目录时宁可报告无内容。
  return pool.find(t => t.id !== input.lastTemplateId) ?? null;
}
