# #59 原创橘猫娘默认素材验收

日期：2026-11-03。规格为 [#59](https://github.com/destinyTaoTao/maneki-pet/issues/59)，本地状态与点按验收不替代 #9/#10 的 Runtime、MCP 或 dsh 联通验收，也不代表 M1/M2 整体出口完成。

**状态：素材与功能检查完成，进程树资源预算仍在修正和复测，尚不能宣告全票完成。**

## 素材、授权与获取

- 定稿身份图 SHA-256：`e207a3cbf31b9d2114f91de0d386076360fa8b23e0e64851388b11eaeb976001`。用户确认设定图及待机/招手/工作三段试片后，批准扩展其余动作；2026-11-03 明确选择 MIT。
- 17 段真实动画覆盖 7 个 PetState 和 10 个动作。包 ID `xiaozhao-default`，版本 `1.1.0`；状态、动作、优先级仍遵守包 v1 和 Core 既有规则。
- 静音 VP9-alpha：384×384、24 fps、120 帧、5 秒。兼容透明 PNG：每帧 256×256、8 fps、40 帧，单横排 10,240×256。34 个素材文件共 31,707,047 字节。
- 处理保留构图比例、统一画幅及脚底锚点；状态循环与歪头动作显式取前半往返，思考起点 0.75 秒、庆祝起点 0.6 秒。不是把原片宣称为天然无缝循环。
- 等待 v001 的字幕、出错 v001 的手套图案漂移、点击回应 v001 的顶边裁切均已排除，采用重新生成的 v002；歪头只使用未触及顶边的前段。原始拒绝任务和修改理由保留在来源记录。
- 所有原片整段严格解码，交付的 17 段视频逐帧核对 alpha、画幅边缘、帧数与静音，PNG 全部解码。全帧透明检查不等于完整艺术质量判断。
- 源码中的[可移植处理配方](../../apps/desktop/recipes/orange-catgirl-release-v1.1.0.json)、[生成来源记录](../../apps/desktop/recipes/orange-catgirl-provenance-v1.1.0.json)、[交付摘要](../../apps/desktop/recipes/orange-catgirl-delivery-v1.1.0.json)记录实际输入摘要、提示词、种子、模型指纹、裁切和输出。内置图像工具未暴露的模型版本/种子不虚构；重跑不保证逐像素重复。
- 本地交付为 `renders/orange-catgirl/maneki-catgirl-default-1.1.0.zip`，包含版本目录、MIT、原片、参考图、处理记录、预览及 `SHA256SUMS.txt`。大二进制不入 Git，没有公开下载地址或自动下载；克隆代码不自动获得正式素材。源原片可能含模型音轨，运行包已全部去音轨。
- ZIP SHA-256：`fe000b9ed33a77daa0df1f72ba213db7eedb50a40eee5a28b50604145128a977`。包描述 SHA-256：`29db7b6628fe436c8c663d236068c191a8bccbf195d0bbb40d0749ddbb5587b8`；素材清单 SHA-256：`16fc5833222fac7d27658579af353f11c593e62d0db4b4bc95e90a9755c4233c`。

## Windows 功能证据

基线 `a1f5baf`，Windows 11、i5-13600K、64 GiB、RTX 4070，WebView2 156.0.4314.58。实际 Tauri release 可执行文件独立配置目录运行，使用内嵌正式素材，不以 Vite 小占位包代替；ComfyUI 已停止。隔离壳不附带 sidecar，另起真实发行 Runtime 并使用临时目录、随机端口和 token 验证 `/v1/health`；壳未配对此实例。

- 设置中完整列出十项中文动作；七状态和十动作逐项播放。
- working → wave → working 正确；首选 wave 视频请求失败后，实际显示 10,240 像素宽的兼容 PNG，点播仍可用。
- 换 mint-test 后重载保持选择，再换回正式默认；现有选择不会被升级重置。
- 原生 WebView2 绘制视频读取 alpha：角落 0、角色主体 255。
- 47 个公开 DOM 状态/动作事件到首个解码视频帧回调的样本，p95 31.7 ms、最大 31.7 ms；该指标不包含 Runtime/harness 事件传输。
- 角色默认包和安全 fallback 经全仓构建/测试与 release 构建后摘要保持不变。构建不启动模型，缺失时仅补程序占位；损坏包诊断并保留现场，正式导入为显式操作。

## 资源复测中的失败证据

口径为 release 壳全部后代（包括 GPU/WebView2）加真实 Runtime Private Bytes；不计测试驱动、制作模型，未强制 GC，未排除 GPU 或放宽预算。

| 版本/场景 | Shell 树 | Runtime | 合计 | 结论 |
|---|---:|---:|---:|---|
| 384 像素兼容图，冷启动 | 256,548,864 B | 65,126,400 B | 321,675,264 B（306.77 MiB） | 超预算 |
| 256 像素兼容图，冷启动 | 207,990,784 B | 64,937,984 B | 272,928,768 B（260.29 MiB） | 超预算 |
| 256 像素兼容图，47 次切换后 | 278,851,584 B | 64,831,488 B | 343,683,072 B（327.76 MiB） | 超预算 |

外部制作项目 `C:\AI_video\projects\2026\11\02\maneki-catgirl-motion-trials\notes` 留存全帧检查、原片质量复核及资源诊断；实际进程列表与样本在仓库忽略的 `scratch/catgirl-release-acceptance-256/memory-samples.jsonl`。早先出现合计为空的采样无效，不用于结论。256 兼容图减量已通过真实 CLI 回归，但不能据此宣称总内存通过。

只读 CDP 观测发现同源待机每 5 秒仍销毁、新建 WebMediaPlayer；JavaScript 活跃堆约 4 MiB，DOM 中只保留一个视频，单纯引用数量不足以证明浏览器媒体资源已回收。正在核对同源视频管线复用；HTTP 双缓存和 ImageBitmap 泄漏均未被确认。

## 验证范围

资源修正前全仓 `pnpm -r build`、`pnpm -r test`（225 项）、`pnpm -r typecheck` 和 `git diff --check` 通过；独立标准与规格审查覆盖至 `7488275`，兼容图减量审查覆盖 `68010f5..a1f5baf`，均无新增发现。后续生命周期修正须另附验证。

macOS/Linux 未在本机验证；Windows 安装器、长时间资源稳定性、dsh 插件复用、外部任务状态联通以及走动/转向/悬空/落地交互另行验收，不以本地动画展示代替。
