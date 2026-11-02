# 小招 · 拟人橘猫娘 v1 素材配方

日期：2026-11-03。范围、外观方向、第一版设定图与三段试片观感均已由用户确认；全量 17 段动画覆盖七状态十动作，素材与 Windows release 功能检查通过。用户明确确认总预算 300 MiB、Runtime 75 MiB，保留原画质，固定场景资源采样符合新预算；正式默认 `xiaozhao-default@1.1.0` 已完成交付，附 MIT 授权。证据与剩余边界见[验收记录](../../../docs/audits/2026-11-03-catgirl-default-acceptance.md)，规范基线见 [architecture §3.1](../../../docs/architecture.md#31-动画与交互)。

增量规格：[Spec #59：默认形象与首版动作包](https://github.com/destinyTaoTao/maneki-pet/issues/59)。

## 制作与留存

- 使用内置 `image_gen` 制作原创设定图；不复制 dsh-pet 的角色、动画、提示词或源视频。
- 工具未暴露可选模型版本、随机种子及采样参数，不虚构这些值；生成不保证逐像素可重复。
- 首张设定图采用非透明浅色底，方便审阅三视图与表情；它不是可直接播放的动画或透明精灵图。
- 生成图保存到仓库已忽略的 `renders/orange-catgirl/2026-11-02/character-sheet-v1.png`；文件摘要与尺寸在同目录的 `generation-record.json` 留存。
- 确认设定图后才制作待机、招手、工作试片；素材未通过校验与 Windows 实测前保留当前可用默认包。

## 第一版设定图记录

- 2026-11-02：内置 `image_gen` 生成，1536×1024 PNG，1,721,439 字节。
- 输出 SHA-256：`e207a3cbf31b9d2114f91de0d386076360fa8b23e0e64851388b11eaeb976001`。
- 已视觉检查：三视图、四种表情、橘色短发与猫耳、奶油白裙装、焦糖围裙、红领结、金铃铛和条纹尾巴均有呈现；形象方向一致。
- 设定图阶段记录：2026-11-02 用户已视觉确认，可以定稿。设定图本身不验证动画循环、跨片角色一致、透明边缘与桌面播放，不视作已交付动作包；后续试片见下节。

## 三段试片记录

- 2026-11-02：待机、招手、工作原片由本机 H3 离线生成，736×416、24 fps；原片保留，模型音轨不进入交付。用户已查看三段透明动画并确认沿此风格扩展后续动作；这不是完整七状态十动作或正式默认验收。
- 角色来源为本项目原创设定图与独立生成素材，不使用 dsh-pet 图像、动画或提示词。代码 MIT 许可不代替最终形象授权，正式素材发行须另附来源、授权说明及校验记录；当前试片不视为已发布的正式素材授权包。
- 原片任务：待机 `20261102-224159-f92acda4`，招手 `20261102-225922-71c4017d`，工作 `20261102-230256-a41024e1`。均在本机 `C:\AI_video\projects\2026\11\02\maneki-catgirl-motion-trials` 保存；此路径是制作证据位置，不是代码或运行依赖。
- 同项目 `notes/pack-trial-v001.recipe.json` 记录实际输入，`outputs/deliveries/pack-pipeline-v001/xiaozhao-catgirl-trial.build.json` 记录 FFmpeg 版本、命令、输入/输出大小与 SHA-256、媒体检查。独立试片包位于同目录 `xiaozhao-catgirl-trial/`；大素材独立交接，不能靠提示词重跑的近似角色冒充定稿原件。
- v001 试片历史处理为裁切 `416×416 @ (160,0)`，去绿幕与去溢色后缩至 384×384。待机/工作取前 60 帧再倒序 60 帧，招手取连续前 120 帧；这是显式往返循环修整，不声称原片天然无缝。输出 5 秒、24 fps、120 帧、无音轨 VP9-alpha；当时 fallback 每秒 8 帧，共 40 帧，单横排 15,360×384，总计 5,898,240 像素。此处保留原产物事实，当前重建规格见下节。
- 技术管线通过真实 FFmpeg 解码、alpha 首帧提取、尺寸/帧数/音轨检查及现有 v1 安装器；独立的手工透明检查位于同项目 `notes/*-alpha-check.json`，覆盖各片全部 120 帧。用户观感通过不替代 Windows 正式包切换、状态抢占、回退、资源释放、全量性能或 macOS/Linux 验收。

## 可重复处理入口

前置：Node ≥22、仓库依赖及已构建 Core，本机 PATH 中可运行 `ffmpeg`/`ffprobe`（包含 `libvpx-vp9`、`chromakey`、`despill`）。它们是离线制作依赖，不是桌宠终端运行依赖；不安装模型、不联网、不调用付费服务。

复制 [orange-catgirl-trial.example.json](./orange-catgirl-trial.example.json) 到独立制作目录，按实际原片调整 `input`（相对配方文件解析）、裁切、起点及循环方式，再执行。下列占位符须替换为实际绝对路径：pnpm 会在 `apps/desktop` 下执行脚本，命令行配方、输出和导入源目录不能误用仓库根目录相对路径。

```sh
pnpm --filter @maneki-pet/core build
pnpm --filter @maneki-pet/desktop build:catgirl-pack "<absolute-recipe.json>" --packs-dir "<absolute-candidate-output-dir>"
pnpm --filter @maneki-pet/desktop import:pack "<absolute-candidate-output-dir>/xiaozhao-catgirl-trial"
```

此示例与完整候选配方均使用固定输出：主视频 384×384、24 fps、120 帧；兼容 PNG 独立为每帧 256×256、8 fps、40 帧，单横排 10,240×256（2,621,440 像素）。尺寸不作为配方字段开放。历史诊断：2026-11-03 完整素材的 384×384 兼容图版本在开启调试端口的 Windows release 冷启动下测得 Shell + Runtime Private Bytes 合计 321,675,264 字节（306.77 MiB），超过当时 250 MiB 预算；改用 256 像素兼容图及播放器生命周期修正后，最终无调试器固定场景仍未过旧目标，约 267–279 MiB。用户随后明确确认调整总预算至 300 MiB，保留当前 384 视频/256 兼容图画质，完成正式默认交付。这是预算决策，不是优化至 250 MiB 的成果。资源复测以[验收记录](../../../docs/audits/2026-11-03-catgirl-default-acceptance.md)为准，不能沿用 v001 试片观感或旧媒体检查代替验收；首次失败证据保留在制作项目 `notes/resource-acceptance-failure.md`。

输入不足、源媒体损坏、裁切越界、输出不符规格或包超预算都会失败；不会重复静帧补足，不会把半包替换已有候选。原片须整段含音轨严格解码，即使损坏处在截取片段之后也拒绝。输出先在临时目录完成并通过既有 `installPack` 校验安装，再将候选与同级 `<id>.build.json` 制作记录一起发布；写入或替换失败回滚两者，不承诺跨文件掉电原子性，未扩充 v1 Schema。当前构建入口保留 `xiaozhao-default`，不提供自动晋升选项。

历史三段试片只声明 `idle/working` 和 `wave`，其余状态沿用既有 idle 回退；当前全量配方见 [orange-catgirl-release-v1.1.0.json](./orange-catgirl-release-v1.1.0.json)，17 段真实动画与七状态十动作映射均已完成。重建仍使用独立 candidate ID，缺少任何被引用原片即失败。设置面板按当前包的 `actions` 提供选择与点播，沿用现有播放链；换包更新选项，无动作禁用，不增加测试专用入口。

正式晋升须在七状态十动作、用户观感与本票 Windows 桌面验收通过后进行；2026-11-03 已按用户确认的新预算完成本次晋升。重做步骤：保留候选包及验收证据，复制到独立发行目录，明确更新描述中的 `id/name/version` 为默认发行版本，复核素材清单；从同版本 idle 准备同角色 `public/fallback.png`，用 `import:pack` 显式安装到内置目录（源目录使用绝对路径），再执行 `prepare:packs`、构建、测试、重启和换装验证。用户此前选择其他包的偏好沿用既有持久化逻辑，不重置全部用户设置。启动 Vite/桌面读取可能使 Windows 目录暂时被锁；遇到安装失败先停止读取者再显式重试，旧包应保持可用。

目前没有正式素材下载渠道；交接时提供版本化目录、发行授权与同版本哈希记录，缺素材直接诊断，不静默获取近似素材或使用云端回退。

2026-11-03 移除旧程序招财猫：`generate:packs` 缺包时仅生成 `1.0.1` 中性三方块开发占位，不再绘制旧角色；生成与 `prepare:packs` 均拒绝精确匹配 `xiaozhao-default` / `小招 · 招财猫` / `1.0.0` 的退役默认并保留文件，按上面的显式导入步骤迁移。其他合法包不自动替换；若要替换旧测试形象，须显式导入新 `mint-test@1.0.1`。仅旧 fallback 的已知字节指纹迁移为中性图，其他已准备 fallback 保留；图标源复用当前 fallback，隔离 `--public-dir` 不写应用图标。这不改变正式素材晋升条件或资源预算。

## 设定图完整提示词

```text
Use case: stylized-concept
Asset type: original desktop companion character reference sheet, first visual proposal for Maneki / Xiaozhao.
Create a polished landscape character design sheet, approximately 1536x1024, on a very light warm ivory background. Clean and spacious art-direction layout. The sheet must show the SAME original orange tabby catgirl mascot consistently from front, strict side, and back, plus a small row of four facial expression portraits. This is a character reference sheet, not a sprite atlas or animation.

Character: an adult female catgirl translated into a compact approximately three-head-tall chibi mascot. Human feminine face and human-shaped body with two arms and two legs, orange tabby cat ears and exactly one fluffy striped orange tail. Warm orange short bob haircut with simple recognizable locks and darker tabby accents, cream inner ears, cream-toned face, amber eyes, soft relaxed smile. Keep the silhouette clear and memorable at desktop-pet scale. Ears and hair shapes must match in all views. The tail emerges naturally from the lower back and remains fully visible in side and back views.

Costume: simple cream-white short-sleeved dress with a caramel-brown small apron, restrained warm orange/caramel edging, a compact red bow at the collar with one small gold bell. Cream cat-paw mittens with subtle caramel paw pads, cream socks and simple caramel ankle shoes. The apron has simple practical straps and a tied waist bow visible from the back. Keep the costume identical and structurally plausible across every view. Minimal trim, no elaborate lace or dangling decorations.

Rendering: premium soft 3D cartoon character render, smooth matte materials, gently sculpted hair and ears, subtle cloth texture, rounded forms, soft studio illumination, restrained shadows and crisp silhouettes. Warm orange, cream, caramel, red and gold palette. Adult character expressed through chibi proportions; fully dressed, friendly and wholesome. Friendly attentive personality with a little relaxed feline curiosity.

Layout: upper two-thirds, three equally sized full-body orthographic-like views: front, side, back, all standing naturally with arms slightly away from the body, at identical scale and aligned feet, ample separation, fully visible ears, shoes and tail, no cropping. Lower band: four consistent head-and-shoulder portraits showing relaxed, thinking, delighted, and sleepy expressions. Add a small unobtrusive palette strip of five swatches without hex labels. Exact text allowed only: title "小招 · 橘猫娘" and view labels "正面", "侧面", "背面". Small clean typography, no extra commentary or invented text.

Constraints: one original character shown repeatedly, identity and outfit consistent across views and portraits; exactly two arms, two legs, two cat ears and one tail per full-body view; readable design with no busy scenery, no watermark, no logos. No reference character copying. Do not add human ears, extra tails, extra limbs, props, wings, headwear or a separate animal companion.
```
