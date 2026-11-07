# 按键语音实现与局部验证（2026-11-07）

基线：`feat/m1-catgirl-default`，文字助手 `798dacf` 之后的本轮实现。设计先行提交为 `949ec7b`、`46a602f`、`b7fa7da`、`cf88fbf`。本文记录代码与局部运行证据，不代表 M3、安装包或真实设备整体验收。

## 已落地范围

- 只增加 dsh 既有 `/maneki assistant` 所打开面板的按键语音；插件仍仅 express，无麦克风/个人数据权限扩张。桌宠麦克风入口只打开面板，关闭状态引导设置，不隐式采集。
- Core 定义 ASR/TTS 独立端口、PCM WAV 校验与单 owner 租约；Runtime 具体 IO，Shell 采集/播放。麦克风、识别、朗读各自默认关闭，关闭模型不阻断规则式待办提醒。
- AudioWorklet 内存采集，松开即停 MediaStream，统一成单声道 16 kHz PCM16 WAV；0.3–30 秒与能量门限。Worklet 构建为独立同源资产，未放宽 CSP。所有临时媒体资源均有取消/结束清理路径。
- Runtime 租约 8 秒、Shell 约 2 秒续租并用单调时钟自行截止。绑定 client、requestId、epoch、设置版本；失联、关闭设置、撤销、清空时停止当前轮次。重启前有活跃标识时隔离 8 秒，不立即给新 owner。实际 Provider 未结束前保留工作槽，拒绝重叠调用。
- ASR 先产生内存候选，只有当前轮次仍有效的 Shell 才自动 submit；不需要用户二次确认。submit 不接受替换文本。请求持久去重、清空墓碑与失败查询，取消/清空后的迟到 ASR 不新建事项。已提交事项不假报撤销。
- 本地 whisper.cpp stdin 音频 / stdout 文本；Windows System.Speech 通过固定 PowerShell 内存流生成 WAV。半双工，先停止播报再采集，停止采集后才合成/播放。不保存录音/转写文件，不进行云端语音回退。
- SQLite v4 → v5 先备份，语音表只存请求身份/哈希/epoch/状态/错误，无录音或转写副本。识别文字复用主会话，旧设置缺 voice 读默认、保存保留已有设置。升级/使用见[说明](../voice.md)。

## 自动验证

本轮全仓 `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 通过：330 项测试通过、2 项设备测试默认跳过（Core 96、Runtime 107、Desktop 81、dsh 插件 7、dsh Adapter 22、platform-core 8、B站 5、CLI 4）。相关新增覆盖：

- WAV 格式/大小/时长/静音、采样转换与租约不抢占。
- express 凭证不能用语音、跨客户端租约/结果不能串用、默认关闭和旧配置兼容、v4 备份迁移。
- 超过原 64 KiB 限制的合法语音请求、只扩大 transcribe 路由上限、转写后提交且同 ID 不重复办事。
- 候选尚未提交时取消/失联、识别后取消、清空/设置关闭/撤销/重启、迟到 ASR/TTS 隔离；不响应取消的 Provider 不阻塞 HTTP 取消或 Runtime 退出，仍占槽直到结束。
- 权限等待期间松开、迟到设备授权立即释放、续租网络挂起时本地到期、结束/播放失败的资源释放、半双工和按键轮次隔离。
- 面板“取消”绑定当前语音停止流程，读取历史不会误取消正在进行的任务。

`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`：5 项通过。`pnpm --filter @maneki-pet/desktop tauri build --no-bundle`：Windows 原生发布构建通过，不打安装器。

## 真实本地引擎验证

环境为 Windows 11 专业版，build 26200、Node 24。仅在 TEMP 准备官方 [whisper.cpp v1.9.5 源码](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5)，提交 `d1be6fde11ac6e0407606b4e42fe72d34add8037`，VS 2022 Build Tools / MSVC 19.44、CPU 构建、4 线程。模型为 multilingual ggml-tiny，77,691,713 字节，SHA-256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`。引擎、DLL、模型均不入库，应用没有自动下载实现。

真实验证发现 Windows CLI 的 `-of -` 输出会走 CON，不能直接用于重定向；stdin `-f -` 还会影响默认实时回调。现固定非 `-` 的 `-of maneki-stdout-only`，同时不启用任何文件输出格式开关，得到 stdout 文本且不创建文件。调用前校验精确版本 `1.9.5(-dev)`；工作目录固定到引擎目录，不从项目目录加载后端库。

可选设备测试 `packages/runtime/tests/speech-device.test.ts` 实际通过：

1. 从 System.Speech 检出 Huihui（zh-CN）、Zira、David（en-US）。
2. 用 Huihui 把“添加待办，买牛奶。”合成为内存 WAV，再重采样传 whisper stdin；其中一次单次转写含版本检查约 576 ms，非 p95 / 冷启动承诺。
3. 再经真实 Runtime voice transcribe → recognized（此时无会话消息）→ submit → 主会话消息链路通过；未调用真实云端模型。
4. 取消真实识别进程得到 voice_cancelled，完成/取消后检查引擎目录无新增输出文件，测试目录无录音文件。

**准确率未通过验收。** tiny 对上述合成句输出为“天交改版 買牛奶”，只证明引擎/管道与文本进入主会话，不证明正确识别“添加待办”。没有为迁就该样本修改解析规则。真实麦克风、口音/环境噪声与所选模型必须人工验收。

复测命令（自行提供受信引擎与模型路径）：

```powershell
$env:MANEKI_WHISPER_TEST_DIR = '<whisper-cli.exe 与 DLL 所在绝对目录>'
$env:MANEKI_WHISPER_TEST_MODEL = '<GGML 模型绝对路径>'
pnpm --filter @maneki-pet/runtime exec vitest run tests/speech-device.test.ts
```

普通套件跳过此测试，不要求开发机安装模型；已有原生通知设备测试也仍为 opt-in。

## 原生面板与资源样本

使用 TEMP 发行布局、隔离 Runtime APPDATA 启动本轮 Windows release；未替换用户已安装应用。原生 UI 确认默认按键/朗读禁用，设置中三个开关均关闭；只点击只读“检测语音组件”，显示 ASR、TTS 就绪及上述系统语音列表。未代替用户打开隐私开关、授权麦克风或播放真实扬声器声音。测试桌面与后台进程已清理。

该次模型仅在磁盘、未加载时，相关进程树 Private Bytes 样本约 **283.43 MiB**，其中 Runtime **34.45 MiB**，无 whisper 常驻进程。单次采样符合 300 / 75 MiB 空闲目标，不代表长期峰值或所有场景。

另用官方 jfk.wav 的活跃 CLI 单次采样：约 598 ms，10 ms 间隔采到 whisper Private Bytes 峰值约 **679.54 MiB**。这是活跃模型额外资源，不能纳入“空闲低内存”承诺，也不是准确全局峰值或 p95。更大模型的内存/延迟需重新测量。

## 保留的人工验收与限制

- 真实麦克风授权拒绝/允许/占用、Windows WebView2 AudioWorklet 采集及真实扬声器播放/打断/回声。替身与 System.Speech 内存管道通过不等于设备通过。
- 真实命令识别准确率、端到端对话体验、冷启动/ASR p95 与资源矩阵、休眠/切换设备、长时稳定性。
- dsh 原生配对授权（包括之前的 human-acceptance profile）、托盘/原生退出确认、安装器更新/回退及已有 DPI/多显示器人工项。
- 对话模型的真实云端使用与计费未验收；没有进行真实计费调用。语音不开放工程派发、审批或外部任务取消。
- macOS/Linux 未在本机验证；当前具体 ASR/TTS 为 Windows 实现，不宣称跨平台语音已支持。

M1/M2/M2b/M3 整体出口继续保留，不能以本轮局部通过替代人工项。
