# 终端任务与桌宠连接

`scripts/run-with-pet.mjs` 是一个显式使用的命令包装器。它运行你在 `--` 后面写出的程序，并把开始、成功、失败或取消状态送到本机桌宠。普通命令不经过它时，不会被监听。

## 使用方法

1. 打开桌宠的「陪伴空间 → 偏好与连接」，选择「开启本机任务桥」。默认关闭，退出桌宠后关闭。
2. 在「一起专注 → 创作任务 → 接入方式」读取当前端口与会话令牌。桥每次重新开启都会生成新令牌。
3. 在当前终端中设置下面两个环境变量，再显式运行包装器。不要把令牌写进项目、脚本、命令行参数或日志。

PowerShell 示例（在仓库根目录执行；输入令牌时不会回显）：

```powershell
$env:ANDROMEDA_BRIDGE_PORT = Read-Host '粘贴端口数字'
$andromedaSessionSecret = Read-Host '粘贴会话令牌' -AsSecureString
try {
  $env:ANDROMEDA_BRIDGE_TOKEN = [System.Net.NetworkCredential]::new('', $andromedaSessionSecret).Password
} finally {
  $andromedaSessionSecret.Dispose()
  Remove-Variable andromedaSessionSecret
}

node scripts/run-with-pet.mjs --title "构建网页" -- npm run build:web
$LASTEXITCODE

# 本次使用结束后，从当前终端环境移除凭据。
Remove-Item Env:ANDROMEDA_BRIDGE_PORT, Env:ANDROMEDA_BRIDGE_TOKEN -ErrorAction SilentlyContinue
```

也可以运行某个程序的完整路径，或直接用 Node 执行 JavaScript 入口：

```powershell
node scripts/run-with-pet.mjs --title "检查项目" -- node --test tests/companion.test.mjs
```

`--title` 可省略，默认显示「终端任务」。标题为 1–200 字符，不接受控制字符；它是你主动提供给桌宠的文本，请用简短任务名。`--` 必需；适配器不接受 URL、令牌、输出文件等额外选项。命令参数按照当前终端的普通规则传入，适配器不会再拼成一条 shell 命令。

## 运行与状态

每次运行产生独立 `taskId`，开始发送 `working`，结束发送且只发送一次 `completed`、`failed` 或 `cancelled`。成功和失败保留程序的原退出码；程序不存在返回 `127`，不支持的 Windows 批处理入口返回 `126`，适配器参数错误返回 `2`。Ctrl+C 取消返回 `130`；收到 SIGTERM 取消返回 `143`。

Windows 取消会对本次启动的 PID 使用 `taskkill /PID … /T /F` 清理子进程树；该辅助程序没有 shell，也不会接收桥接凭据。非 Windows 使用独立进程组终止与兜底强制结束；本轮实际进程验收在 Windows 完成，其他系统仍需实机验证。

没有开启桥、凭据过期、请求被拒绝或本机连接故障时，命令仍照常运行，退出码不变，只显示一条简短提示。一次状态请求最多等待 750 ms，不重试、不排离线队列；短暂断连可能让桌宠保留最后收到的状态。适配器不把 HTTP 重定向转发到其他地址。

命令输出直接继承终端。适配器不读取、缓存或发送 stdout/stderr，也不把命令、参数、源码、当前目录、文件路径或环境变量加入任务消息。桥接端口和令牌从所启动的子进程环境中剥离。任务标题属于显式输入，会发给本机桌宠。

## Windows 的 npm 与批处理

全部启动采用 `spawn(file, args, {shell: false})`。Windows 的 `npm` / `npm.cmd` 会解析现有 Node/npm 安装中的 `npm-cli.js`，再由 Node 直接执行，参数逐项保留。找不到入口时给出明确提示；不会退回拼接 `cmd /c`。

其他 `.cmd` / `.bat` 暂不支持；请使用对应 `.exe` 或 `node 工具入口.js`。PowerShell 别名和 shell 内建命令同样不由适配器解析。用户主动选择运行 npm 脚本时，npm 自身仍会按项目定义执行该脚本。

## 协议范围

地址固定为 `POST http://127.0.0.1:<环境变量端口>/events`，不接受远程地址，不读取代理设置。令牌只放在 `Authorization: Bearer …` 请求头中，内容为以下五个字段：

```json
{
  "eventId": "cli-9b0c5f92-7c1a-4be8-9d8a-7f05c648ef93-completed",
  "taskId": "cli-9b0c5f92-7c1a-4be8-9d8a-7f05c648ef93",
  "status": "completed",
  "title": "构建网页",
  "text": "命令完成，退出码 0。"
}
```

接收器位于 `src/services/task-bridge.cjs`，只接受本机会话认证请求并校验字段；共享引擎按 `eventId` 去重、按 `taskId` 更新同一任务。桥默认关闭，限制请求体为 8 KiB、每分钟最多 60 次请求，不对浏览器开放。一次普通命令产生两个请求。

这是可实际使用的终端入口。尚未包含编辑器扩展、自动发现开发任务、跳转项目/编辑器的深层链接、远程任务服务或可靠消息重试。

## 验收

```powershell
node --test tests/run-with-pet.test.mjs
```

本轮 Windows + Node 24.22.0：9 项通过，0 跳过。覆盖真实临时 HTTP 接收器、真实 Node 子进程、退出码与输出、元字符参数原样传递、无桥和重定向降级、启动失败、取消清理子进程及孙进程、实际 npm 入口，以及真实 `createTaskBridge` 接收后更新共享引擎任务。测试使用临时测试数据，不读取用户项目内容或真实令牌。
