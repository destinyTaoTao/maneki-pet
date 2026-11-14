# 小招 · 三色形象与招牌动作 v2

日期：2026-11-14。目标是在不改变 Pet Pack v1、七状态或既有交互逻辑的前提下，将点播动作从 10 个扩展到 20 个，并提供同一角色的橘猫、白猫、黑猫三套完整动作包。

## 新增动作

| 动作 ID | 中文名称 | 状态 |
|---|---|---|
| bow | 鞠躬致谢 | 原片已生成并目视检查 |
| clap | 鼓掌 | 原片已生成并目视检查 |
| dance | 轻轻摇摆 | 原片已生成并目视检查 |
| spin | 转个圈 | 原片已生成并目视检查 |
| jump | 开心一跳 | 原片已生成并目视检查 |
| salute | 敬礼 | 原片已生成并目视检查 |
| finger-heart | 比心 | 原片已生成并目视检查 |
| cover-laugh | 捂嘴偷笑 | 原片已生成并目视检查 |
| look-around | 好奇张望 | 原片已生成并目视检查 |
| excited-rub | 期待搓爪 | 原片已生成并目视检查 |

这些动作只进入 `actions`，不增加 PetState、自动触发器或工程执行能力。原有点播优先级、`interruptible` 与状态回退规则保持不变。

## 原片与生成环境

- 角色首帧沿用已批准的 `neutral-green-v001.png`，不复制 dsh-pet 的角色、视频或提示词。
- 本机 ComfyUI 0.39.0 + MiniMax H3，普通 20 步，736×416、24 fps、124 帧约 5.1667 秒；每个动作保留独立 seed、提示词、请求、环境和 history。
- 制作项目：`C:\AI_video\projects\2026\11\14\maneki-catgirl-signature-actions`。生成原片复制到 `renders/orange-catgirl/signature-actions/v2.0.0/sources/`，任务映射见同目录 `generation-plan.json`。
- 前两次模型读取失败没有成片；释放模型内存后成功。失败与恢复证据保留，未复用失败 job_id。

## 白猫 / 黑猫

`recolor-catgirl.py` 对验收后的橘猫成片逐帧换色，不重新生成角色。白猫使用暖瓷白，黑猫使用带蓝灰层次的炭黑；保留动作几何、alpha、帧率和明暗。静态眼部遮罩在低头时会产生伪影，已弃用；最终眼睛随整体色调统一处理，红领结和纹理保留。

白/黑包登记在 `config/optional-packs.json`：存在时完整校验，未导入时跳过开发构建；损坏的已导入包仍拒绝。运行不需要 Python、H3 或网络，只有重做换色时需要工作室现有 Python、NumPy、Pillow 和 FFmpeg。

## 重建入口

先完成全部 10 个新动作的验收，再执行：

```sh
node apps/desktop/scripts/prepare-catgirl-v2-recipe.mjs
pnpm --filter @maneki-pet/core build
pnpm --filter @maneki-pet/desktop build:catgirl-pack "C:/myProject/maneki-pet/apps/desktop/recipes/orange-catgirl-release-v2.0.0.json" --packs-dir "C:/myProject/maneki-pet/renders/orange-catgirl/signature-actions/v2.0.0/candidate"
```

候选包含 27 段动画（七状态 + 20 动作），仍须通过安装器和 Windows 桌面检查。橘猫默认晋升须显式将描述 ID/name 改回 `xiaozhao-default` 与目标版本，不能直接覆盖用户当前包。

三色版本从同一候选重建：

```sh
C:/AI_video/environments/comfyui/Scripts/python.exe apps/desktop/scripts/recolor-catgirl.py <expanded-orange-pack> <white-output> --variant white --id xiaozhao-white --name "小招 · 白猫娘" --version 2.0.0
C:/AI_video/environments/comfyui/Scripts/python.exe apps/desktop/scripts/recolor-catgirl.py <expanded-orange-pack> <black-output> --variant black --id xiaozhao-black --name "小招 · 黑猫娘" --version 2.0.0
```

生成原片、动作包和角色小标记均为忽略文件，不进入 Git。配方、脚本、任务映射与本说明入库。

## 最终验证

- `xiaozhao-default@2.0.0`、`xiaozhao-white@2.0.0`、`xiaozhao-black@2.0.0` 均已通过现有安装器完整校验；每包 27 段动画、20 项点播动作。
- 三种角色卡片、当前形象标记与轨道色已在实际组件中切换检查；自定义包保留通用“招”标记。
- `corepack pnpm -r build`、`corepack pnpm -r test`、`corepack pnpm -r typecheck` 全部通过，共 406 项测试通过、2 项真实设备测试默认跳过。Windows `tauri build --no-bundle` 通过。
- 测试基础设施补充了临时 Fetch 禁用端口重选和 CLI 子进程失败清理；未改变正式 Runtime 的固定端口或业务断言。
- 真实原生连续动作观感、鼠标命中、多屏/DPI、长期内存与既有 #66 人工语音验收仍分别保留；本记录不把这些项写成已通过。
