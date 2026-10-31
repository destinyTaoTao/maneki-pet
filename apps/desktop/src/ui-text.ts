import type { PetState } from "@maneki-pet/core";

export const uiText = {
  loading: "正在唤醒小招…",
  settings: "设置",
  closeSettings: "收起设置",
  packLabel: "形象",
  stateLabel: "状态",
  petAction: "摸摸小招，招手回应",
  invalidPack: "动作包未通过校验",
  integrityFailure: "动作包素材哈希或大小不匹配",
  mediaFailure: "动作包素材格式不正确",
  loadFailure: "动作包加载失败，请重试",
  playbackFallback: "素材无法播放，已使用内置安全 idle",
  states: {
    idle: "待机",
    thinking: "思考",
    working: "工作",
    waiting_input: "等待输入",
    celebrating: "庆祝",
    error: "出错",
    sleeping: "睡觉",
  } satisfies Record<PetState, string>,
};
