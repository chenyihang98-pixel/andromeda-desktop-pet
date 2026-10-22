# 0.3.2 Windows 构建交接

日期：2026-10-22。构建源码提交：`3cd3e2fda4a6e7c67286fa5f6d21b913d2ef7bb1`。本记录在构建完成后生成，没有嵌入该 ZIP；源码推送和本地构建不代表新建 GitHub Release。

- 文件：`Andromeda-0.3.2-windows-x64-portable.zip`
- 字节：151764955（约 145 MiB）
- SHA-256：`4533d343d8573fb06145da41fd3729bd339c73b5f604ee8abff9981e3df35ef9`
- 命令：`npm run build:win`，默认 normal 压缩、Windows x64 ZIP、`--publish never`。
- 构建前静态检查和 360/360 单测通过；完整分层证据见 [复审验证](VALIDATION-0.3.2.md)。
- 7-Zip 完整性检查通过：52 文件、6 文件夹。
- ASAR 中 43 份代码/素材与构建源码逐文件一致，版本 0.3.2；不含 QA、测试、开发依赖或环境文件。
- ASAR SHA-256：`5004f2e3e7b60113abd036595273510bba673db3c849c110222846d8b4ff8e6b`。
- 随附 README、NOTICE、CHANGELOG、原生检测组件与 Electron/Chromium 许可证已核对。
- 仓库 Electron 直接加载构建后 ASAR，27 项原生应用检查通过，包括真实面板重开和任务桥状态、当前物理屏幕五档比例。此测试不等于签名安装器、协议注册或全部设备验收。

完整解压后运行 `Andromeda.exe`。程序未签名；本地包和 `SHA256SUMS.txt` 位于忽略目录 `dist/`，公开 v0.2.0 Release 和附件保留。原始角色图集的 SHA-256 未变。

网站集成提交：`bccf74a77fe17c591083304a7a3d4caa3af4fb8a`。13 个 SDK 文件与标准化 LF 的 Web 构建字节、大小及 SHA-256 一致。Cloudflare 报告该提交预览部署成功；另从 [此次分支预览](https://a9b33e53.xingxuan-platform.pages.dev) 实际下载清单、13 份 SDK 和网站主脚本，与本地构建逐一比对通过。主脚本 `main-BH1V5dh2.js` 为 24,581 字节。

网站变更保留在既有集成分支和草稿 PR，生产主分支未合并；公开展示仓库以“未发布”同步进度。远端证据覆盖静态产物一致性，六页浏览器回归在本地生产构建执行。原始记录：`qa/asar-verification-0.3.2.json`、`qa/native-asar-smoke.json`、`qa/zip-0.3.2.log`、`qa/preview-0.3.2.json`。

13 项已确认缺陷已修复，54 项功能路线图仍保留原完成范围；实际混合 DPI、多屏热插拔和手机软键盘等限制见验证记录。
