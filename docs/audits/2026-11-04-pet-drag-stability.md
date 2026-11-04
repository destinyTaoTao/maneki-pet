# 桌宠拖拽稳定性修复（2026-11-04）

## 触发条件与证据

用户反馈拖动时抖动、重影。`window-drag.ts` 原实现用 `clientX/clientY` 相对按下时的坐标计算窗口位置；窗口移动后局部坐标也发生变化，后续输入会把窗口拉回。每次 pointermove 又独立提交 `setPosition`，没有帧合并和在途上限。

新增回归直接驱动 `attachWindowDrag`，模拟窗口移动后局部坐标变化：旧代码在连续向右移动时返回 x=330，预期 x=360；同帧三个输入产生三次原生移动调用。两项测试均在修复前失败，修复后通过。此证据确认坐标反馈与请求积压问题，不单独证明所有显卡/桌面合成器的动态重影已消除。

## 最小修复

- 使用屏幕坐标差值与按下时 DPI 计算窗口位移，消除窗口移动对输入坐标的反馈。
- 拖拽按动画帧合并最新位置，原生位置更新最多一个在途；松手后的甩抛等待最后一次拖动完成。
- 用交互代次隔离旧初始化与甩抛回调；取消、失去指针捕获、卸载时停止待处理运动，释放指针捕获。
- 保留点击、甩抛与显示器边界规则，不增加依赖、媒体解码或缓存。

## 验证与交付

- `pnpm --filter @maneki-pet/desktop exec vitest run src/window-drag.test.ts`：9 项通过，覆盖坐标反馈、150% 缩放、高频/慢速 IPC、点击抑制、取消/失去捕获、旧初始化、再次拖动/卸载与甩抛交错。
- `pnpm --filter @maneki-pet/desktop typecheck` 通过。
- `pnpm -r build`、`pnpm -r test` 通过；当前工作区共 274 项测试，其中包含既有未提交交互区改动的测试。
- `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过。已更新并重启用户实际运行的 `apps/desktop/src-tauri/target/release/maneki-desktop.exe`；旧可执行文件备份为同目录 `maneki-desktop.pre-drag-fix.exe`。
- Windows release 真窗口通过 Computer Use 完成向右拖动，窗口移动、人物动画及控制条仍可用。窗口截图只能验证拖动前后状态，未采集逐帧屏幕录像，不把此结果当作动态重影完全消失的验收。

边界：本轮没有安装器重打包、长期资源采样、混合 DPI 多屏实测；macOS/Linux 未在本机验证。现有 M1 整阶段出口保持未勾选。
