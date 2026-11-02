# 小招 · 拟人橘猫娘 v1 素材配方

日期：2026-11-02。范围与外观方向已由用户确认；生成设定图仍待视觉确认，动画与默认替换尚未验收。规范基线见 [architecture §3.1](../../../docs/architecture.md#31-动画与交互)。

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
- 当前状态：待用户视觉确认。尚未验证动画循环、跨片角色一致、透明边缘与桌面播放；不将设定图视作已交付动作包。

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
