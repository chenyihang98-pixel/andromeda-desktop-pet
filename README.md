# 星璇（Andromeda）桌宠

蓝发与星饰，安静陪在桌面一角。星璇平时安静站着，偶尔做个小动作；挡住工作时，就把她拖到屏幕边缘藏起来。

![星璇](assets/neutral.png)

## 下载与开始

1. 到 [v0.2.0 下载页](https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases/tag/v0.2.0)下载 `Andromeda-0.2.0-windows-x64-portable.zip`
2. 完整解压到一个新文件夹，再打开 `Andromeda.exe`，不用安装 Node.js
3. 如果正在使用旧版，先退出，再打开新版本；原来的设置可以沿用

当前源码已加入 [Windows 修复和全屏自动隐藏实验功能](CHANGELOG.md)，尚未打进 v0.2.0 下载包。自行构建的程序与原发行包不同，版本号仍为 `0.2.0`。

适用于 Windows 10/11 x64。目前是未签名的开发版，可能出现 SmartScreen 提示；请核对下载来源和随包的 SHA-256，不要关闭系统安全防护。

## 怎么和她玩

- **拖动**角色，放到喜欢的位置；双击角色或点 `⋯` 打开设置
- **藏到边缘**：在屏幕左、右、上、下边缘附近松手，只留下星形小把手。鼠标悬停时展开，移开约 0.7 秒后收回，拖向屏幕内侧就能带出来
- **随时找回来**：点击小把手、点托盘图标，或选择「重置位置」。托盘也能隐藏、恢复和退出
- **调成舒服的样子**：支持 75%–200% 缩放、置顶，以及挥手、小跳、等候和检查动作
- **不想挡住点击**：可开启整窗点击穿透，再点托盘图标恢复。穿透默认关闭，重启后也会关闭

边缘收纳以不含任务栏的工作区为准，只有松手才吸附，跨屏拖动不会提前收起。打开设置或右键菜单时会保持展开；如果松手后指针正好压在把手上，先移开再移回即可。

## 安静陪伴

默认「安静」模式，每隔 45–90 秒才轻轻动一次，不会自动走来走去。也可以选「静止」，或把节奏调成 12–20 秒一次的「轻快」。

近距离注视和全桌面注视都可按需开启。全桌面注视只在本机读取鼠标方向，不记录轨迹、不上传；开启后以注视代替自主小动作，手动互动仍可使用。

隐藏或收起时会停止动画。应用支持系统减少动画偏好，并为锁屏、休眠和恢复处理了暂停状态；手动隐藏后不会被自动唤回。

没有聊天、AI 模型、语音、账号、遥测或开机自启。除了主动打开「检查新版本」页面，日常运行不需要联网。

设置保存在 `%APPDATA%\Andromeda\settings.json`，不随解压文件夹移动。关闭程序后删除该文件可重置设置。

源码中的 Windows 选项「全屏时自动隐藏（实验）」默认关闭，需要可用托盘。同屏前台应用全屏时隐藏角色，退出全屏后不抢焦点地恢复，并保留手动隐藏。普通带边框的最大化窗口和桌面不会触发；部分游戏和播放器可能无法识别。点托盘显示、重置位置、运行中再次打开程序、手动播放动作或在自动隐藏期间打开设置，都会关闭此选项。

## 从源码运行

需要 Node.js 22.12+ 和 npm，建议使用受支持的 LTS。首次安装和构建需要访问 npm 与 Electron 官方下载源。Windows 源码运行与打包还需要系统自带的 .NET Framework 4 C# 编译器和运行时；没有新增第三方运行库包。

```sh
npm ci
npm run verify
npm run test:ui
npm start
npm run build:win
npm run pack:assets
```

`build:win` 会生成 Windows x64 ZIP 和 `dist/SHA256SUMS.txt`，不会自动发布。`pack:assets` 用于准备独立角色素材。构建保留中文、英文语言资源和运行时许可证；不同机器生成的 ZIP 不保证逐字节相同。

Windows 上的 `npm start` 会先编译本地全屏检测组件；打包也会编译并附带该组件。已打包程序使用附带组件，不会在用户电脑上下载或编译代码。当前 Windows 打包必须在 Windows 上进行，从 Linux 交叉构建会明确报错。

`test:ui` 会查找已安装的 Chrome、Edge 或 Chromium，并保持浏览器沙箱开启。找不到时可用 `CHROMIUM_PATH` 指定路径：

```powershell
$env:CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:ui
```

Linux 可用 `CHROMIUM_PATH=/usr/bin/chromium npm run test:ui`。首次启动 Electron 会下载锁定的运行时，也可提前运行 `node node_modules/electron/install.js`。

## 版本与验证范围

当前下载包面向 Windows x64，更新通过「检查新版本」手动查看发布页。全屏检测已通过单屏受控窗口检查；游戏、真实鼠标交互、混合 DPI、多屏、锁屏/休眠和 RDP 等完整实机验收仍待完成。具体证据见[测试记录](docs/TESTING.md)，透明像素穿透、自动更新、其他平台和体积优化的后续安排见[续做说明](docs/CODEX-HANDOFF.md)。

## 素材与继续开发

角色是 **3D 风格的透明 2D 图像**，不包含可旋转的 3D 模型。`assets/andromeda.png` 保留原始图集，`assets/manifest.json` 记录布局和播放参数；适配其他平台需要支持精灵裁切与播放。

- [素材格式与 ChatGPT Pets 导入说明](docs/ASSET-FORMAT.md)
- [架构与安全边界](docs/ARCHITECTURE.md)
- [英文 Codex 续做说明](docs/CODEX-HANDOFF.md)
- [版本记录](CHANGELOG.md)
- [权利与第三方声明](NOTICE.md)

项目尚未采用开源许可证。公开下载不代表授予商业使用或再分发许可，请先阅读权利声明。
