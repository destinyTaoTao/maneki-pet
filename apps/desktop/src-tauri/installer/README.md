# NSIS 模板

基于 Tauri CLI **2.12.4** 的 [官方模板](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)，上游原文件 SHA-256 为 `d00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d`。MIT 许可随 `TAURI-LICENSE-MIT` 保留。

定制在常量声明后定义占用检查函数，并在安装 `.onInit` 中提前调用检查、拒绝旧 MSI 自动迁移；实际动作位于 `hooks.nsh`。安装/卸载阶段移除上游可终止进程的 CheckIfAppIsRunning 调用，以只拒绝的占用检查替代，避免检查后新启动的进程被强制结束。上游的 PREINSTALL hook 晚于旧版卸载入口，不能单独保证升级时不被旧卸载器强杀，因此保留该固定版本模板。升级 Tauri CLI 须对照上游更新模板并重跑独立身份安装/升级/卸载验收。
