# 随包 Node 许可

`Node-v24.12.0-LICENSE` 原样保留 [Node.js 官方 v24.12.0 LICENSE](https://github.com/nodejs/node/blob/v24.12.0/LICENSE)，包含其第三方声明。Windows 预览固定分发该版本 x64 可执行文件；`build-runtime-bundle.mjs` 校验实际 Node 版本并复制完整许可到安装资源，同时从 esbuild 实际打包依赖生成 Runtime 第三方声明。升级 Node 时须同步此文件和发行版本约束。
