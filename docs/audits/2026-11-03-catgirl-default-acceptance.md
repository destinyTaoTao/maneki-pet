# #59 原创橘猫娘默认素材验收

日期：2026-11-03。规格为 [#59](https://github.com/destinyTaoTao/maneki-pet/issues/59)，本地状态与点按验收不替代 #9/#10 的 Runtime、MCP 或 dsh 联通验收，也不代表 M1/M2 整体出口完成。

**状态：素材与功能检查完成，250 MiB 私有内存目标尚未通过；预算/渲染取舍待维护者明确，不能宣告全票完成。**

## 素材、授权与获取

- 定稿身份图 SHA-256：`e207a3cbf31b9d2114f91de0d386076360fa8b23e0e64851388b11eaeb976001`。用户确认设定图及待机/招手/工作三段试片后，批准扩展其余动作；2026-11-03 明确选择 MIT。
- 17 段真实动画覆盖 7 个 PetState 和 10 个动作。包 ID `xiaozhao-default`，版本 `1.1.0`；状态、动作、优先级仍遵守包 v1 和 Core 既有规则。
- 静音 VP9-alpha：384×384、24 fps、120 帧、5 秒。兼容透明 PNG：每帧 256×256、8 fps、40 帧，单横排 10,240×256。34 个素材文件共 31,707,047 字节。
- 处理保留构图比例、统一画幅及脚底锚点；状态循环与歪头动作显式取前半往返，思考起点 0.75 秒、庆祝起点 0.6 秒。不是把原片宣称为天然无缝循环。
- 等待 v001 的字幕、出错 v001 的手套图案漂移、点击回应 v001 的顶边裁切均已排除，采用重新生成的 v002；歪头只使用未触及顶边的前段。原始拒绝任务和修改理由保留在来源记录。
- 所有原片整段严格解码，交付的 17 段视频逐帧核对 alpha、画幅边缘、帧数与静音，PNG 全部解码。全帧透明检查不等于完整艺术质量判断。
- 最终独立创作复核查看 227 个视频时间样本、187 个实际 256 PNG 精灵帧、17 段 2.5 秒时点的原尺寸浅/暗底合成以及安全 fallback；未发现新的阻断视觉缺陷，34 个媒体摘要与发行副本逐一相同。抽样支持角色身份、动作意图与修补结果，不冒充逐帧连续人工观看。浅底细暗轮廓和缩小后的零食道具细节弱为现存观感限制，证据在外部 `notes/media-quality-final-v003.md`。
- 源码中的[可移植处理配方](../../apps/desktop/recipes/orange-catgirl-release-v1.1.0.json)、[生成来源记录](../../apps/desktop/recipes/orange-catgirl-provenance-v1.1.0.json)、[交付摘要](../../apps/desktop/recipes/orange-catgirl-delivery-v1.1.0.json)记录实际输入摘要、提示词、种子、模型指纹、裁切和输出。内置图像工具未暴露的模型版本/种子不虚构；重跑不保证逐像素重复。
- 本地交付为 `renders/orange-catgirl/maneki-catgirl-default-1.1.0.zip`，包含版本目录、MIT、原片、参考图、处理记录、预览及 `SHA256SUMS.txt`。大二进制不入 Git，没有公开下载地址或自动下载；克隆代码不自动获得正式素材。源原片可能含模型音轨，运行包已全部去音轨。
- ZIP SHA-256：`6294ef90934acd2940158097128d583cd225611e33da6bb8c59c24c493cf8406`。包描述 SHA-256：`29db7b6628fe436c8c663d236068c191a8bccbf195d0bbb40d0749ddbb5587b8`；素材清单 SHA-256：`16fc5833222fac7d27658579af353f11c593e62d0db4b4bc95e90a9755c4233c`。发行 README 的安装命令已实测修正为从根目录直接运行安装器，71 份文件摘要与 ZIP CRC 已重新核验。

## Windows 功能证据

基线 `a1f5baf`，Windows 11、i5-13600K、64 GiB、RTX 4070，WebView2 156.0.4314.58。实际 Tauri release 可执行文件独立配置目录运行，使用内嵌正式素材，不以 Vite 小占位包代替；ComfyUI 已停止。隔离壳不附带 sidecar，另起真实发行 Runtime 并使用临时目录、随机端口和 token 验证 `/v1/health`；壳未配对此实例。

- 设置中完整列出十项中文动作；七状态和十动作逐项播放。
- working → wave → working 正确；首选 wave 视频请求失败后，实际显示 10,240 像素宽的兼容 PNG，点播仍可用。
- 换 mint-test 后重载保持选择，再换回正式默认；现有选择不会被升级重置。
- 原生 WebView2 绘制视频读取 alpha：角落 0、角色主体 255。
- 47 个公开 DOM 状态/动作事件到首个解码视频帧回调的样本，p95 31.7 ms、最大 31.7 ms；该指标不包含 Runtime/harness 事件传输。
- 角色默认包和安全 fallback 经全仓构建/测试与 release 构建后摘要保持不变。构建不启动模型，缺失时仅补程序占位；损坏包诊断并保留现场，正式导入为显式操作。

## 资源复测与测量条件

口径为 release 壳全部后代（包括 GPU/WebView2）加真实 Runtime Private Bytes；不计测试驱动、制作模型，未强制 GC，未排除 GPU 或放宽预算。下面首表保留的是开启调试端口的诊断实验；完整测试还包括视频失败回退、换装和页面重载，不只是 47 次切换，不能直接当作正常桌面运行占用。

| 版本/场景 | Shell 树 | Runtime | 合计 | 结论 |
|---|---:|---:|---:|---|
| 384 像素兼容图，冷启动 | 256,548,864 B | 65,126,400 B | 321,675,264 B（306.77 MiB） | 超预算 |
| 256 像素兼容图，冷启动 | 207,990,784 B | 64,937,984 B | 272,928,768 B（260.29 MiB） | 超预算 |
| 256 像素兼容图，完整调试功能测试后 | 278,851,584 B | 64,831,488 B | 343,683,072 B（327.76 MiB） | 诊断样本，不作正常运行口径 |

外部制作项目 `C:\AI_video\projects\2026\11\02\maneki-catgirl-motion-trials\notes` 留存全帧检查、原片质量复核及资源诊断；实际进程列表与样本在仓库忽略的 `scratch/catgirl-release-acceptance-256/memory-samples.jsonl`。早先出现合计为空的采样无效，不用于结论。256 兼容图减量已通过真实 CLI 回归，但不能据此宣称总内存通过。

只读 CDP 观测发现同源待机每 5 秒仍销毁、新建 WebMediaPlayer；JavaScript 活跃堆约 4 MiB，DOM 中只保留一个视频，单纯引用数量不足以证明浏览器媒体资源已回收。HTTP 双缓存和 ImageBitmap 泄漏均未被确认。

`dcdfa4b`（集成至 `c7b7bf5`）仅修正播放器视频生命周期：单元素复用，同源保留 src/URL、seek/play；每轮仍经过 Core complete 与新的 playback ID，切源、转兼容图、换包或 dispose 才释放视频。真实 384 VP9-alpha 在独立 Chrome 中连续三次自然结束，红灯为四个 native player，绿灯为一个；120 次动作/状态快速切换、迟到 ended/error、动作自然结束回 working、视频失败进精灵图、换包旧 URL 撤销及 dispose 均通过。记录在外部 `notes/resource-video-lifecycle-tdd.md`。该边界回归不替代原生 release 进程树复测。

生命周期修正后的实际 release UI 又完成 47 次切换，使用 `loadeddata/seeked` 后的首帧回调避免将旧视频帧计入；p95 32.4 ms、最大 32.5 ms。视频错误回退、working 回归、换装偏好与 alpha 仍通过，原始结果在外部 `notes/release-reuse-functional-cli.txt`。

### 无调试器的实际桌面基线

新 profile 没有设置 remote-debugging 参数，也未连接 Playwright/CDP；通过 Windows Computer Use 操作原生 UI。对应实现为 `c7b7bf5`（撤销实验后的代码树与 `674e3a0` 一致）。Runtime 在隔离临时目录正常启动并经 token 验证健康；未加载生成模型。

| 正式 384 视频/256 兼容图场景 | Shell 树 | Runtime | 合计 |
|---|---:|---:|---:|
| 冷启动 | 205,713,408 B | 64,720,896 B | 270,434,304 B（257.91 MiB） |
| 七状态通过实际键鼠依次切换后 | 210,763,776 B | 64,720,896 B | 275,484,672 B（262.72 MiB） |

原始记录在 `scratch/catgirl-release-no-debugger/memory-samples.jsonl`。这是少量固定场景采样，不是内存峰值或长期稳定性结论；已经足以确认旧 250 MiB 目标未通过。不能将 Runtime 单独约 62 MiB 达标写成总预算达标。

撤销实验后从 `5d6ee81` 再次构建 release，使用另一全新无调试器 profile，通过原生控件逐项选择并点播完整十动作后关闭设置，透明角色恢复待机。冷启动合计 279,703,552 B（266.74 MiB），十动作后为 Shell 227,602,432 B + Runtime 65,150,976 B = 292,753,408 B（279.19 MiB）；继续自然待机约六分钟后为 283,148,288 B（270.03 MiB），期间未强制 GC。Runtime 没有子进程。原始记录在 `scratch/catgirl-final-native-no-debugger/memory-samples.jsonl`；这是正常桌面检查的最终独立样本，未将调试功能矩阵的更高读数混入。较早新 profile 的差异也说明不能用某一次接近门槛的数字宣称稳定达标。

### 未采用的优化实验

- 同一 17 视频的无 PNG v1 诊断包，与完整包的原生冷启动几乎相同；不能断言 PNG 校验是主要根因。只保留诊断产物，没有削弱正式包完整性或格式校验。
- 流聚合 Blob、自有 ArrayBuffer 释放、Worker、跨源不清 src 等隔离实验未给出足够真实产品收益证据，未引入代码。所有此类自动浏览器探针都连接了 Network instrumentation；[Chromium 网络检查器](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/inspector/inspector_network_agent.cc)会保留响应内容，可能影响增长数字。未将其当作产品永久泄漏或精确双份复制的证明，详见外部 `notes/media-isolation-20261103/REPORT.md`。
- 256 视频/192 兼容图对照包的 2,040 视频帧与 680 精灵帧检查通过，体积降至 18,899,546 B；实际无调试器冷启动 272,162,816 B（259.55 MiB）、静置 265,334,784 B（253.04 MiB），仍未过旧目标，故保留正式 384 视频/256 兼容图及其画质，不以降低素材字节数代替进程实测。
- WebView2 失焦 `Low`/获焦 `Normal` 原生实验：Normal 总 Private 266,436,608 B，Low 268,017,664 B，静置后 268,558,336 B；工作集下降但 Private 没有相应下降。实现 `3c80b84` 及设计 `39d24c1` 已由 `5d6ee81` 撤销，不保留无效策略、额外依赖或为它扩建日志框架。两项针对实验的审查发现随功能移除一并消失。

2026-11-03 已向维护者明确提出三种取舍：300 MiB 总预算且 Runtime 仍 75 MiB、坚持 250 MiB 继续调整渲染、或先交付素材并保留预算未完成。未得到明确选择前继续使用 250 MiB，不修改该目标，不关闭 #59。

## 验证范围

全仓 `pnpm -r build`、`pnpm -r test`（225 项）、`pnpm -r typecheck` 和 `git diff --check` 通过；撤销实验后的 Windows `cargo check --offline --locked` 通过。全量双轴审查覆盖 `583d4a0..c7b7bf5`：Standards 的状态同步问题及另列发行命令问题已由 `674e3a0` 修复，Spec 除已披露预算阻断外无新增发现；撤销实验的 fresh 双审 Standards 0、Spec 0。原生 release 编译、素材摘要保留和功能证据独立于静态审查记录。

macOS/Linux 未在本机验证；Windows 安装器、长时间资源稳定性、dsh 插件复用、外部任务状态联通以及走动/转向/悬空/落地交互另行验收，不以本地动画展示代替。
