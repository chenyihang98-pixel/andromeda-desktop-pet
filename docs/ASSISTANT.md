# 可选智能服务接口

模块：`src/services/assistant.cjs`，Node CommonJS。所有智能能力默认关闭，不影响原有离线陪伴。此文件说明服务模块；主进程 IPC、界面、麦克风录制和声音播放由宿主接入。

## 创建与初始化

```js
const { createAssistantService } = require('./services/assistant.cjs');
const assistant = createAssistantService({
  directory: absoluteUserDataDirectory,
  safeStorage, // Electron safeStorage；缺省或不可用时 key 仅存当前会话
  fetchImpl: globalThis.fetch,
  onEvent: event => sendToTrustedRenderer(event),
  now: () => Date.now(),
  capture: async ({ signal }) => takeOneExplicitlyRequestedScreenshot(signal),
  toolHandlers: {
    openWebsite: {
      label: '打开星匠网站',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      validate: args => Object.keys(args).length === 0,
      run: () => openFixedStarwrightUrl(),
    },
    addTodo: {
      label: '添加待办',
      parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['title'], additionalProperties: false },
      validate: args => Object.keys(args).length === 1
        && typeof args.title === 'string' && args.title.length > 0 && args.title.length <= 100,
      run: (args, { signal }) => addUserTodo(args.title, signal),
    },
  },
});
await assistant.load();
```

`directory` 必须是宿主选择的绝对路径。服务不会查找现有密钥、环境变量、其他应用配置、文件或屏幕。只能通过可信主进程接收设置，不能把整个服务对象开放给任意网站。`onEvent` 监听器抛错不会破坏请求。

## 方法

| 方法 | 说明 |
|---|---|
| `await load()` | 读取本模块的 `assistant.json`，返回 snapshot；损坏或缺失设置有安全回退 |
| `await configure(patch)` | 严格校验后更新，取消当前请求，再保存；返回 snapshot |
| `snapshot()` | 返回配置、`hasApiKey`、`keyStorage`、额度、状态、有限历史、允许工具及待确认卡；没有 API key 或密文 |
| `exportData()` | 导出公开配置、当前会话历史和请求计数；没有 API key、密文、截图或待确认权限 |
| `await chat({text,context?,memory?,image?})` | 使用本次显式选中的资料和有限对话历史；返回 `{requestId,text}` |
| `await transcribe({audio,mimeType})` | 上传本次选择的录音，返回 `{requestId,text}`；不自动接着聊天 |
| `await synthesize({text})` | 返回 `{requestId,mimeType,audioBase64}`，不自动播放 |
| `cancel(requestId?)` | 取消当前/指定请求，返回是否成功；不等 fetch 配合才结束等待 |
| `clearHistory()` | 取消正在进行的聊天并清空会话历史，返回 snapshot |
| `await captureOnce({confirmed:true})` | 仅在 captureEnabled 开启且本次确认时调用注入截图函数；返回 `{requestId,image}` |
| `proposeTool({name,args?})` | 为注入白名单工具生成待确认卡；返回 `{id,name,label,args,createdAt,expiresAt}`，不执行 |
| `await confirmTool({id,confirmed})` | `true` 执行一次；`false` 拒绝并删除；成功返回 `{requestId,tool,result}` |

异常均为 `AssistantError`，有 `code` 和中文 `message`。不包含远端原始错误、Authorization、堆栈日志或任意远端响应体。常见 code：`DISABLED`、`NOT_CONFIGURED`、`INVALID_CONFIG`、`INVALID_INPUT`、`BUSY`、`LIMIT`、`CANCELLED`、`TIMEOUT`、`NETWORK`、`AUTH`、`RATE_LIMIT`、`REMOTE`、`RESPONSE`、`TOO_LARGE`、`PERMISSION`、`TOOL`、`TOOL_FAILED`、`CAPTURE_FAILED`。

服务一次只运行一项异步操作。界面可用 `cancel()` 后再发新请求；所有事件有 requestId 时应按该 ID 对应当前任务，避免旧任务的取消提示覆盖新任务状态。

## 配置字段与上限

| 字段 | 默认 / 范围 |
|---|---|
| `enabled` | `false`，控制对话/ASR/TTS 网络能力 |
| `endpoint` | 空；填写兼容 API **基础地址**，例如 `https://service.example/v1`，不要附 `/chat/completions` |
| `model` / `asrModel` / `ttsModel` | 空；按实际提供商填写，服务不猜测模型，也不预设收费服务 |
| `apiKey` | 只写字段；传空字符串清除；最大512字符，无空白/控制字符 |
| `persona` | 星璇简洁陪伴人设；最大4000字符 |
| `voice` | `alloy`；可按提供商填写其它合法标识符 |
| `timeoutMs` | 30000；100–120000 |
| `maxInputChars` | 8000；1–16000；TTS另限4096字符 |
| `maxOutputChars` | 12000；1–32000 |
| `maxTokens` | 1024；1–8192，作为请求最大输出token参数 |
| `tokenParameter` | `max_tokens`；可改 `max_completion_tokens`，取决于提供商和模型 |
| `dailyRequestLimit` | 50；1–1000；chat/ASR/TTS共享计数，UTC日期更新时重置 |
| `historyMessages` | 16；0–40，0表示不保留对话历史 |
| `captureEnabled` / `toolsEnabled` | 都为 `false`；与网络能力分别启用 |

endpoint 仅接受 HTTPS，或显式 `http://localhost`、`http://127.0.0.1`、`http://[::1]`（可带端口）。拒绝 URL 凭据、query、fragment、路径遍历、转义路径、其他明文 HTTP 和非 HTTP 协议。网络请求拒绝重定向；地址只能来自配置，不能从模型返回内容或网页链接推导。

更换 endpoint 会清除旧 key，除非同一个 configure patch 明确提供新 key。更换 endpoint/model/persona 会清空会话历史，避免将旧服务会话意外发给新服务。每次 configure 都取消当前操作，迟到响应不会写回历史。

`context` 最大8000字符，`memory` 最大4000字符；两者只在明确传入的这次请求发送，不从磁盘自动检索，也不写入会话历史。文本提示（含有限历史）总计限制约64000字符，超出的旧历史从前方截断。图片只接受不超过4 MiB的 PNG/JPEG/WebP data URL，不接受远程图片 URL；传 image 还要求 captureEnabled。截图返回给界面供预览/选择，随后只有显式 `chat({image})` 才上传。截图、参考资料、记忆和音频不自动持久化。

## 密钥与存储

`assistant.json` 只保存版本、配置、UTC请求数和可选加密密钥。使用 `safeStorage.isEncryptionAvailable()`，并拒绝 Linux `basic_text` 后端。可加密时调用 Electron `encryptString`；不可加密或加密失败时 key 只保存在内存。`keyStorage` 为 `none`、`session`、`encrypted` 或加载解密失败时的 `unavailable`。后两种异常情况应由界面解释需重新输入密钥。

保存采用独立临时文件和原子 rename，串行排队；持久化失败通过 snapshot.persistenceError 展示，保留本会话可用状态。历史只保存在会话内，导出必须由用户主动触发。API Key 原文不进入 snapshot/export/onEvent；远端错误体不读取，流式文本回显已知 key 时先跨 chunk 缓冲再脱敏。该脱敏不是通用隐私过滤器：用户选中的资料仍会发给其配置的服务，密钥与服务选择应由可信界面操作。

请求计数在实际尝试前保存；取消、超时和远端失败也占一次额度，不自动重试。它是本设备请求护栏，**不是供应商账单、精确费用或多设备全局额度**。用户修改本机存储可改变计数，不能拿它做服务端计费安全边界。

## 流式与音频兼容性

- `POST /chat/completions`：支持标准 SSE `data:` 事件、UTF-8分段、CRLF、`[DONE]` 和 finish_reason；也接受返回 application/json 的兼容服务。缺失结束标记/finish_reason、损坏数据、空回复或超限均失败，不提交部分历史。
- SSE/JSON文本响应最多256 KiB；输出字符也单独限额。取消和超时使用 AbortController 加独立竞速，不依赖提供商及时中止。旧请求不能提交结果到新请求。
- `POST /audio/transcriptions`：FormData，字段 model/file/response_format=json。输入为 Buffer、Uint8Array 或纯base64；支持 audio/webm、audio/wav、audio/mpeg、audio/mp4，最大8 MiB。由宿主决定何时录音、停止和上传；服务不打开麦克风。
- `POST /audio/speech`：JSON，model/voice/input/response_format=mp3；流式读取但只在完整接收后返回音频，最大8 MiB。界面负责字幕、明确的合成语音标识、播放/静音以及取消播放；服务 cancel 不能暂停已经交给音频播放器的字节。
- 不支持 Realtime/WebRTC、后台持续监听、声音克隆、自动电脑操作或模型自动执行 tool_calls；这些能力不能仅由本接口推断为完成。

协议参考（只使用 mock 测试，未发起真实付费请求）：[Chat Completions流式协议](https://developers.openai.com/api/docs/guides/streaming-responses)、[文件语音转写](https://developers.openai.com/api/docs/guides/speech-to-text)、[语音合成](https://developers.openai.com/api/docs/guides/text-to-speech)。第三方“兼容”服务仍可能在模型名、token参数、音频格式或认证规则上不同，需要用户提供配置后单独验收。

## 工具确认与截图边界

工具只能来自创建服务时注入的名称白名单。带参数工具必须提供 `validate(args)`，且严格返回 true；参数为大小/深度受限的JSON，拒绝原型污染键。纯函数快捷形式只接受空参数，适合固定站点。只有显式提供合法 `parameters` 且 `toolsEnabled=true` 的工具会进入本次聊天请求的 `tools`；没有 schema 的旧 handler 仍可由主人手动创建操作卡，但不会暴露给模型。

`parameters` 是有界 JSON Schema 子集，顶层必须是 object，支持 object/array/string/number/integer/boolean/null 单一 type、description、原始值 enum，以及对应的 properties/required/items、字符串长度、数组数量和数值上下界。对象自动补 `additionalProperties:false`，不允许设置 true；拒绝 `$ref`、pattern、组合 schema、未知关键字和原型键。深度最多4、节点最多64、单对象最多20个属性、enum最多20项、单 schema 最多8 KiB；一次最多暴露16个工具。schema是调用格式说明，服务还会按同一子集和 handler 的 validate 双重检查参数，不能依赖模型遵守它。

支持标准 Chat Completions SSE 的 `delta.tool_calls` 按 index 拼接，也支持兼容 JSON 响应的 `message.tool_calls`。单回复最多4个调用，index为0–3、名称最多64字符、每个 arguments 最多4 KiB UTF-8。完成后只接受本次实际提供给模型的工具名，解析 arguments 为对象、校验 schema 和 handler，再生成5分钟有效的待确认卡；不会执行 handler。只有工具而没有正文时返回“操作尚未执行，请确认操作卡。”；有正文时也补充未执行提示。原始 tool_calls 不保留在会话历史。

未知工具、非法/超限参数、截断/损坏流、超时或取消都会使这批候选失败，不降格为其它工具执行，也不留下新的待确认卡。同一批在提交前整体检查；已有的主人操作卡保持原状。已知 API Key 原文不得进入操作卡参数，避免脱敏预览掩盖实际要执行的内容。每张卡仍须主人明确确认一次；失败不会重试。确认结果不会自动发回模型或开启下一轮模型调用，界面展示工具结果，下一轮聊天必须由主人主动发起。

协议参照已核对的 [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) 与 [Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。本模块选择在本机确认后执行这一额外边界；只做 mock 验证，没有调用真实收费模型。

卡片最多10张、5分钟有效、一次性使用；确认时再次验证。失败、取消或超时不会自动重试。每个 handler 应遵守 signal，并只操作其明示的固定能力；不要注入任意 shell、任意 URL 打开器、任意路径读取/写入器。服务能停止等待和丢弃迟到结果，但无法撤回已经完成的外部副作用。

截图只能通过注入 `capture({signal})` 单次执行；调用前必须检查用户这一次的确认，不能用定时器自动调用，也不能把 captureEnabled 当成永久授权自动采集。

## 验证范围

运行 `node --test tests/assistant.test.cjs`。测试均注入模拟 fetch/capture/tool/safeStorage，不读取现有凭据、不连接网络，覆盖SSE分段/损坏、取消/超时/迟到响应、输入输出额度、凭据存储/回显泄漏、每日额度恢复、音频边界、截图授权、工具白名单/确认/过期/重放。

仍需宿主集成验收：Electron实机 safeStorage、IPC来源检查、真实录音/播放取消、系统截图权限、具体提供商的兼容性、系统代理/证书、工具 handler 的实际副作用和界面键盘操作。mock通过不表示这些环节已实机验证。

## 本机任务状态桥

`src/services/task-bridge.cjs` 提供默认关闭的本机 HTTP 状态入口，用于构建脚本、编辑器插件或其他本机任务把进度交给桌宠。它只分发状态，不执行命令，不读写输入中的路径，不打开输入中的 URL；`title/text` 是纯展示文本，不能在界面中当 HTML 渲染。

```js
const { createTaskBridge } = require('./services/task-bridge.cjs');
const bridge = createTaskBridge({
  onEvent: event => companionEngine.dispatch(event),
});
// 只能由本机主人面板的显式开关调用；创建对象不会监听。
const credentials = await bridge.start();
// { running: true, host: '127.0.0.1', port, url, token }
await bridge.stop();
// { running: false, host: '127.0.0.1', port: null, url: null, token: null }
```

`start()`、`stop()` 异步、幂等并串行处理；`snapshot()` 同步。只绑定 IPv4 `127.0.0.1` 的系统随机端口，每次重新启动生成32字节密码学随机 token，停止后清空凭据并断开连接。token 不写磁盘、不出现在事件或 HTTP 响应里，认证使用固定长度摘要的 `timingSafeEqual`。**snapshot/start 的返回值包含私有 token，只能返回可信主人面板，不得广播给桌宠渲染器、网站访客、日志或备份。** 应用重启后由用户重新启用。

请求固定为 `POST http://127.0.0.1:<PORT>/events`，携带 `Authorization: Bearer <TOKEN>` 和 `Content-Type: application/json`。不接受 Origin、任何 Sec-Fetch-*、其它 Host、重复认证头、其它路径/query/方法、压缩请求、升级协议或浏览器预检；不会返回 CORS 许可。每分钟最多60次请求，失败认证也占额度；请求体最多8 KiB、头最多4 KiB、最多8条并发连接、连接无活动超时5秒。这个入口针对显式授权的本机工具，不是远程服务，也不能防止已经能读取主人进程内存的本机恶意软件。

请求 JSON 只接受以下字段，不接受 `type` 或其它扩展字段：

| 字段 | 要求 |
|---|---|
| `eventId` | 必填，本次事件唯一 ID，1–120字符，字母数字和 `_.:@-` |
| `taskId` | 必填，任务 ID，同上；一个任务的多个状态使用相同 taskId |
| `status` | 必填，`working` / `waiting` / `completed` / `failed` / `cancelled` |
| `title` | 可选，非空，最多200字符 |
| `text` | 可选，最多500字符，允许空串，不接受控制字符 |

桥传给 onEvent 的对象固定有 `type: 'task.event'`，其余字段已验证。共享陪伴领域负责重复 eventId 去重、同状态聚合和免打扰通知；桥不擅自生成新事件 ID。202表示宿主接收成功；401认证失败，403来源/Host禁止，400格式错误，413过大，429限流，500宿主分发失败。错误不会回显请求内容或异常细节。停止桥可阻止未完成上传继续分发，但不能撤回已被宿主接收的状态。

在主人面板启用后，把显示的端口和 token 填入本机工具。以下 curl 示例使用占位值，不是真实凭据；Windows PowerShell 请使用 `curl.exe`（以下单引号 JSON 写法适用于 PowerShell 7；旧版 PowerShell 可把 JSON 保存为 UTF-8 文件，再使用 `--data-binary '@task-event.json'`）：

```sh
curl --request POST 'http://127.0.0.1:<PORT>/events' \
  --header 'Authorization: Bearer <TOKEN>' \
  --header 'Content-Type: application/json' \
  --data-binary '{"eventId":"build-001-start","taskId":"build-001","status":"working","title":"构建桌宠","text":"开始运行检查"}'
```

Windows PowerShell 单行：

```powershell
curl.exe --request POST 'http://127.0.0.1:<PORT>/events' --header 'Authorization: Bearer <TOKEN>' --header 'Content-Type: application/json' --data-binary '{"eventId":"build-001-done","taskId":"build-001","status":"completed","title":"构建桌宠","text":"检查完成"}'
```

运行 `node --test tests/task-bridge.test.cjs` 验证真实本机 HTTP 请求的认证、浏览器/Host拒绝、大小/类型/Schema边界、限流、异常脱敏、启动/停止/端口释放/凭据轮换和上传途中停止。测试不连接外部网络。锁屏、全屏或免打扰时如何隐藏桌宠由宿主统一处理，桥本身只汇报状态。
