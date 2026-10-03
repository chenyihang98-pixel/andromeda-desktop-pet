# 星璇（Andromeda）桌宠

一款开发中的桌宠

蓝发、星饰、安静陪伴。第一版使用现有的透明 2D 精灵图，在 Windows 桌面上显示星璇。角色是 **3D 风格的 2D 图像**，不包含可旋转的 3D 模型。

![星璇](assets/neutral.png)

## 快速开始

1. 下载 `Andromeda-0.1.0-windows-x64-portable.zip`
2. **完整解压**到一个文件夹，不要只取出 `.exe`
3. 双击 `Andromeda.exe`。无需安装 Node.js，也无需安装器
4. 拖住角色移动；双击角色或点击悬浮的 `⋯` 打开设置
5. 右键角色或系统托盘图标打开菜单；隐藏后点托盘图标即可找回；菜单或设置内可明确退出

这是开发版，尚无代码签名。若 Windows 阻止执行，请先核对发布来源和 SHA-256；不要关闭系统安全防护。当前包以 Windows 10/11 x64 为目标；ARM 和其他桌面系统不在第一版验收范围。

## 已实现

- 透明无边框窗口、默认置顶、拖动、75%–200% 缩放
- 默认「安静」：保持中性站姿 45–90 秒后轻动一次；无自动走动、无快速眨眼循环
- 「静止」关闭自主动作；「轻快」将间隔缩至 12–20 秒；动作触发可由你手动选择
- 可选的近距离鼠标注视（鼠标位于角色窗口内时）
- 挥手、小跳、等候、检查四种手动互动
- 系统托盘隐藏 / 恢复 / 退出；单实例；断开显示器后将角色移回可见范围
- 本地保存大小、节奏、位置、置顶和注视设置；每次重新启动都会显示角色
- 遵循系统减少动画偏好；隐藏时停止角色动画计时

本版无聊天、AI 模型、语音、账号、遥测、自动更新或开机自启，也不会自动在桌面四处走动。透明窗口的矩形区域会接收鼠标，不支持透明像素自动穿透。

「便携」指免安装解压运行。设置保存在 Windows 用户数据目录的 `Andromeda` 文件夹中，不写回压缩包目录；关闭程序后，删除该目录可重置设置。路径通常为 `%APPDATA%\Andromeda\settings.json`。

## 开发与构建

使用 Node.js 22.12+（建议受支持的 LTS）和 npm。首次安装与构建需要网络访问 npm / Electron 官方发布源；应用运行时不需要网络。

```sh
npm ci
npm run verify
npm start
npm run build:win
npm run pack:assets
```

`build:win` 生成免安装 Windows x64 ZIP 及 `dist/SHA256SUMS.txt`，不会自动发布。依赖版本和锁文件固定，构建流程可复现；跨机器 ZIP 时间戳等可能不同，不承诺逐字节相同。Windows 文件资源信息尚未定制，可能显示 Electron；窗口与应用内标识为 Andromeda。

浏览器渲染检查：

```sh
# 已安装 Chromium 的 Linux / 开发环境
CHROMIUM_PATH=/usr/bin/chromium npm run test:ui
```

该检查运行本地临时 HTTP 服务和浏览器测试，仅用于开发。它不能代替 Windows 原生窗口、托盘、DPI 和系统安全提示测试。详见 [测试记录](docs/TESTING.md)。

## 素材复用

`assets/andromeda.png` 为未重绘的原始透明图集，`assets/manifest.json` 提供精确帧位置、原始时长、16 向注视和本项目播放策略。`npm run pack:assets` 生成可单独携带的素材文件夹。

- [素材格式与 ChatGPT Pets 导入说明](docs/ASSET-FORMAT.md)
- [架构与安全边界](docs/ARCHITECTURE.md)
- [版本记录](CHANGELOG.md)
- [权利与第三方声明](NOTICE.md)

素材复用需要目标平台自己实现裁切、透明显示与播放。不承诺任意桌宠或游戏引擎直接导入；本仓库未授予开源或再分发许可。

## 已知限制

- Linux 构建环境不能完成 Windows 真实桌面验收；已测与未测项逐条记录
- 非签名开发包可能触发 SmartScreen；本版不提供自动升级
- Electron 包体较大；这是使用成熟桌面窗口与托盘能力的取舍
- 极小尺寸、远程桌面、系统合成器、多个 DPI 不同的显示器可能影响边缘或位置表现
- 没有全屏应用自动隐藏、锁屏感知、点击穿透或全桌面鼠标追踪

开发参考：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[窗口定制](https://www.electronjs.org/docs/latest/tutorial/window-customization)、[electron-builder](https://www.electron.build/)
