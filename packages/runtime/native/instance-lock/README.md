# Windows Runtime 实例锁

受信 Node-API 模块在 Runtime 进程内持有 Windows 文件句柄；不启动持锁 helper，不回退 PID 删除锁。

源码构建需要 Windows x64、Rust **1.88 或更新版本**及 MSVC 工具链。napi-rs 3 的 MSRV 为 1.88，因此组合构建要求高于桌面壳原声明的 1.77.2。安装包附带编译后的 `.node`，使用者无需安装 Rust。macOS/Linux 原生实现和打包本轮未提供。

在仓库根目录执行：

```powershell
corepack pnpm --filter @maneki-pet/runtime build
node packages/runtime/scripts/build-runtime-bundle.mjs
```

`Cargo.lock` 固定依赖；构建不使用 napi CLI，不下载 Node 二进制。生成 `.node` 与 Cargo `target/` 被忽略。源码/dist 使用固定 `native/instance-lock/maneki-instance-lock.node`；发行 bundle 使用相邻同名文件，缺失拒绝启动。

升级 Cargo 依赖后，用 `node packages/runtime/scripts/instance-lock-notices.mjs` 更新原生许可清单。正常构建仅检查清单；发行脚本把原生与 JavaScript 许可合入 `Runtime-THIRD-PARTY.txt`。

取得 OS 排他权限后才读取不超过 4 KiB 的元数据；旧存活 PID、未知旧元数据与非空半 JSON 均保守拒绝。已持锁进程正常释放时先按句柄标删除再关闭；进程异常退出由 OS 关闭句柄。空文件及已完成写入的新版残留可恢复；这不承诺任意掉电或写入中断产生的损坏记录自动恢复。恢复锁后仍须执行现有数据库恢复流程。
