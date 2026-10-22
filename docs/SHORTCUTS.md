# 本地应用快捷入口

`src/services/shortcuts.cjs` 为 Windows 桌宠提供主人自行选择的应用白名单。它不扫描已安装应用，不读取注册表，不接收 AI 生成的路径，不执行 shell 命令字符串。添加不会启动应用；每次启动必须来自主人明确点击已添加的入口。

```js
const { createShortcutStore } = require('./services/shortcuts.cjs');
const shortcuts = createShortcutStore({
  directory: app.getPath('userData'),
  openPath: selectedPath => shell.openPath(selectedPath),
});
shortcuts.load();

// 必须在可信主进程中打开系统文件选择器；不能让网页提交 path。
const selected = await dialog.showOpenDialog(ownerWindow, {
  properties: ['openFile'],
  filters: [{ name: '应用与快捷方式', extensions: ['exe', 'lnk'] }],
});
if (!selected.canceled && selected.filePaths.length === 1) {
  shortcuts.add({ name: ownerSuppliedDisplayName, path: selected.filePaths[0] });
}
// 渲染器只收到 {id,name}，启动时只提交保存过的 id。
const items = shortcuts.list();
await shortcuts.launch(items[0].id);
```

| 方法 | 返回值与行为 |
|---|---|
| `load()` | 同步读取私有存储，返回 `[{id,name}]`；损坏、超限或格式非法时返回空列表，不自动重写文件 |
| `list()` | 返回独立的 `[{id,name}]` 副本，没有磁盘路径 |
| `add({name,path})` | 校验并同步原子保存，返回新 `{id,name}`；只接收系统文件选择器的路径 |
| `remove(id)` | 同步保存，成功移除返回 true；合法但不存在的 ID 返回 false |
| `await launch(id)` | 重新检查文件存在且不是目录，调用注入的 `openPath(savedPath)`；成功返回 true |

名称1–80字符，路径最多1024字符，最多32项。路径必须是本机磁盘盘符绝对路径且扩展名为 `.exe` 或 `.lnk`，拒绝相对路径、URL、UNC网络路径、设备命名空间、路径遍历、控制字符、Windows非法字符和目录。文件在添加及启动时都要存在；重复路径按Windows不区分大小写去重。`.lnk` 的目标和预设参数由用户选择的快捷方式决定，本模块不解析或修改它们。

存储文件 `shortcuts.json` 位于宿主给定的私有用户目录，包含版本、名称、随机ID和原始本机路径。采用临时文件写入再 rename；保存失败会保留原内存列表并删除临时文件。这个文件不属于可分享偏好，不应进入网站站宠、公共备份或日志。应用暂时丢失时仍可在列表中移除，启动则返回通用错误。

错误统一为 `ShortcutError`，带 code：`INVALID_INPUT`、`INVALID_NAME`、`INVALID_PATH`、`NOT_FOUND`、`DUPLICATE`、`LIMIT`、`SAVE_FAILED`、`LAUNCH_FAILED`。错误消息不包含文件路径，也不转发 Electron 返回的原始错误字符串。

宿主 IPC 必须限制为主人面板及主框架，并在锁屏/挂起时拒绝操作。只开放“选择应用”“删除ID”“启动ID”，不要把 `add({path})` 原样暴露给网页，也不要把启动能力加入无需确认的 AI 工具。这个白名单防止未选择的路径被调用，但不会判断主人选中的程序是否安全，也无法阻止该文件被其他本机进程替换。

验证命令：`node --test tests/shortcuts.test.cjs`。测试使用临时假 `.exe/.lnk` 和模拟 `openPath`，覆盖私有路径隔离、已保存ID启动、撤销、目录/格式/长度/数量边界、重复项、文件消失、原子保存失败和错误脱敏；不执行任何实际应用。文件行为测试在 Windows 运行，其他平台只执行路径验证，因本轮只提供 Windows 应用白名单。
