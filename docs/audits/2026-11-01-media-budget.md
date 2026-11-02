# #54 大素材资源验证记录

2026-11-01：Windows 11 专业版 10.0.26200，i5-13600K、约 64 GiB 内存、RTX 4070；WebView2 156.0.4314.58。使用当前源码构建的 Tauri debug 壳、Vite 和独立 WebView2 数据目录；测试壳副本没有 Runtime sidecar，因此下列数字不包含 Runtime，不能与包含 Runtime 的空闲预算直接比较。通过 CDP 在正式页面将测试素材及对应清单注入测试动作包，其他素材保持原样。

探针为有效 PNG：2048×4096、62,948,946 字节、SHA-256 `e5d30ee434db5e52427211249eafcde6a528b859c280f6bbf3a404325053751a`；用 FFmpeg 8.1.1 和 `python apps/desktop/scripts/generate-budget-fixture.py <新文件路径>` 可重建。脚本向普通 PNG 添加 60 个各 1 MiB 的私有 ancillary chunk，内容可压缩但不参与像素解码；`ffmpeg -v error -i <文件> -f null -` 完整解码通过。不同 FFmpeg 版本可能产生不同摘要，需使用重建结果的实际大小和摘要生成清单。

| 场景 | 壳及 WebView2 进程树私有内存 | 工作集 | 观察 |
|---|---:|---:|---|
| 默认素材基线 | 191.67 MiB | 406.87 MiB | 单次采样；包括壳、conhost 和全部 WebView2 子进程 |
| 大 PNG 活跃 | 321.87 MiB | 560.91 MiB | 图片实际宽高 2048×4096；一个对象 URL，62,948,946 字节；按钮可操作 |
| 第一次切回默认 | 218.03 MiB | 449.91 MiB | 默认视频 readyState 4；一个对象 URL，约 4 KiB |
| 连续三轮切换后，大 PNG 活跃 | 449.59 MiB | 667.99 MiB | 每次切换后对象 URL 数均为 1；活跃资源峰值并未持续采样 |
| 三轮后切回默认 | 261.42 MiB | 462.53 MiB | WebView2 内部缓存未完全回到基线，不能据此声称物理内存立即释放 |

还验证了有效 4096×4096 PNG 在调用 `createImageBitmap` 前被拒绝、页面提示资源限制且原形象可用；延迟的大素材请求在切回默认时被取消，默认视频继续播放。2026-11-02 在 WebView2 真实页面分别验证 VP8、VP8L 和 VP8X WebP 各一份有效样本可显示。Vite/调试环境中 Runtime 故意不可用，控制台的 Runtime 健康检查连接失败属于该隔离条件。

尺寸头部依据 [PNG 第三版规范](https://www.w3.org/TR/png-3/)和 [WebP 容器规范](https://developers.google.com/speed/webp/docs/riff_container)；这只是解码前预算筛选，完整格式验证仍由媒体解码器和动作包校验负责。

**未完成的验收：**上表是固定场景的少量采样，不是峰值、长时间稳定性或 GPU 专用显存测量；三轮后仍高于基线，尚不能证明浏览器内部资源不会持续积累。视频解码尺寸边界、播放器关闭后所有浏览器资源回收、更多素材尺寸及 Windows 安装版仍需实测；macOS/Linux 未验证。图片头部尺寸检查不替代动作包格式与恶意媒体完整校验，#4 仍须完成。
