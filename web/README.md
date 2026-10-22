# 星璇 Web SDK

这是一份可嵌入现有网站的原生 ESM 组件。复用桌宠仓库的角色图集、角色语义映射、行为调度器和陪伴核心；无需框架或第三方 CDN。不包含登录服务器、AI 服务或云同步。

## 本地体验

仓库根目录执行 `node scripts/build-web.mjs`，然后用任意本地静态服务器提供 `dist/web/`，打开 `/web/demo.html`。也可以从仓库根目录提供静态文件后直接打开 `/web/demo.html`。不要使用 `file://`，浏览器会限制模块和资源读取。

`node --test tests/web-policy.test.mjs` 检查身份范围、偏好导出、URL 与内容。`node web/verify-browser.mjs` 使用本机 Chromium/Chrome/Edge 做真实浏览器验收，不下载浏览器；截图写入 `qa/web-*.png`。

## 接入

将构建目录中的 `web/`、`src/`、`assets/` 按原结构一起放到网站的专用路径，例如 `/andromeda/`。保留 NOTICE.md，不把角色授权扩展为通用再分发许可。不要把 Electron 主进程或任何密钥放进网站。

```js
import { mountAndromeda } from '/andromeda/web/andromeda.mjs';
const guide = mountAndromeda({
  container: document.body,
  assetBase: '/andromeda/assets/',
  storageKey: 'your-site.andromeda.preferences.v1',
  tour: [
    {selector: '#tools', title: '找一个工具', text: '从这里开始。'},
    {selector: '#download', title: '下载', text: '选择适合自己的版本。'},
  ],
  avoidSelectors: ['[data-download]', 'form button[type=submit]'],
  onError(error) { console.warn(error.code); },
});
await guide.ready;
// SPA 组件卸载或页面离开时：
guide.destroy();
```

`assetBase` 相对 SDK 模块 URL 解析；使用绝对站内路径通常最清楚。每个 mount 返回独立实例；宿主应保存实例并在重新挂载前 destroy，避免两个角色。Shadow DOM 隔离组件样式。公共 API：`ready/open/play/say/collapse/restore/getPreferences/exportPreferences/importPreferences/receiveTask/refreshSession/destroy`。

`play()` 优先接收共享语义，例如 `greet/happy/think/read/question/pet/sleep/notify/idle`。现有图集缺失动作由共享角色包明确映射到可用动作，譬如 sleep 用 waiting 替代，不表示素材已经有专门睡觉动画。`say(text,{action,force})` 仅显示纯文本；`force` 不会越过关闭、后台、输入或全屏避让。

## 消费编辑器导出的角色包

将角色编辑器导出的 ZIP 解压到宿主网站的专用目录，保留包内相对路径：

```js
const guide = mountAndromeda({
  characterPackUrl: '/pets/my-character/character.json',
});
```

也支持将 `andromeda.character/v1` 清单放在 `assetBase/manifest.json`。加载器使用同一个 `validateCharacterPack` 校验来源、布局、语义和动作，不再要求 192×208；Canvas 逻辑分辨率等于每格尺寸，显示时在原角色边界内等比容纳。没有注视数据时不启用注视，没有语义动作时使用包里的中性姿态。兼容既有 `sprite-atlas/v1` 及网站 `web-v1`。

清单和图片必须与宿主同源。图片仅接受包内相对 PNG/WebP，禁止绝对 URL、目录穿越、data URL 和 SVG；资源请求拒绝重定向，不跟随包中外部地址。单图片最大 32 MB，像素/布局上限由共享校验器限定；失败后保留占位和向导入口。SDK 不在浏览器里自动解压 ZIP，也不执行包内脚本。可选 quality 档只作为元数据保留，本版使用 atlas 指定的基础图集。

外观默认 `classic`。选择 `studio` 才下载 `assets/studio/life-poses-v1.png`（约 2.7 MB）。画室外观是 4×3 的 12 种透明静态姿态，Canvas 按 313.5×418 的格子取样，不把静态切换称为完整动画。`studioUrl` 可指定自己的同规格静态图；加载失败仍用经典图集。面板有星夜/晨光/节日主题。

## 一份公开内容源

默认工具说明和 FAQ 位于 `src/shared/site-content.mjs`。已拥有工具目录的网站应注入目录，避免重复维护下载版本：

```js
import { createSiteContent } from '/andromeda/src/shared/site-content.mjs';
const content = createSiteContent({tools: publicCatalog, origin: location.origin});
const guide = mountAndromeda({content, assetBase: '/andromeda/assets/'});
```

每个公开工具记录包含 `id/name/href/summary`，可含 `en/version/badges`。宿主目录的版本同时用于搜索和页面解释；下载链接默认去发行页，不伪造尚未发布的安装包。不要把私人任务、客户信息或密钥混进公开目录。

## 身份与任务边界

SDK **没有身份验证能力**。宿主必须使用真实登录会话和服务端授权过滤任务流；客户端的 userId 检查只是第二道范围过滤，不能替代服务端访问控制。默认没有会话，所有私人任务事件都会拒绝。

```js
const guide = mountAndromeda({
  getSession: () => yourAuthenticatedSession
    ? {authenticated: true, userId: yourAuthenticatedSession.userId}
    : null,
});
// 仅从经过服务端授权、属于当前用户的任务流接入：
guide.receiveTask({
  userId: authenticatedUserId,
  eventId: 'event-unique-123', taskId: 'task-123',
  status: 'completed', title: '模型生成', text: '你的模型已经完成。',
});
// 登录、注销、用户切换时主动调用；角色会清空旧会话通知。
guide.refreshSession();
```

仅接受 working/waiting/completed/failed/cancelled；eventId 用于去重。用户切换不恢复上一用户状态；私人任务与通知不落 localStorage。后台/收起/输入时不会为了任务唤醒角色。没有持久后台任务系统；关闭页面就停止。示例页面始终匿名，不提供假登录开关。

## 偏好与生命周期

默认 quiet、sound=false。导出为 `andromeda.preferences/v1`，仅包含桌面/网页共有的 motion/sound/reducedMotion/visualStyle/theme。网页注视、装饰、输入反馈、位置、身份、任务、密钥、聊天和记忆不在导出白名单内。导入不改变当前位置/停靠/收起状态。缺少所选外观资源时保留经典角色；SDK 不自动联网同步。

角色支持鼠标/触屏拖动和方向键移动；左右边缘停靠后折叠，按钮可恢复。经典动画和画室姿态均按当前 Canvas 帧的透明度判断点击/拖动，透明边缘不会启动角色互动。Enter/空格打开面板，Escape 关闭/收起。外部输入获得焦点时自动避让；全屏或后台暂停。手机面板保留安全区与滚动空间。静音默认不创建 AudioContext；只在用户主动开启声音时初始化。

输入节奏反馈默认关闭。开启后只统计本页外部输入框的 keydown 次数，不读取 event.key、event.code、输入框 value、剪贴板或输入内容。每 200ms 最多刷新一次收起按钮中的次数，停笔 1.4 秒、离开输入、进入后台或关闭选项后恢复安静；输入期间不弹提示泡、不改变焦点、不播放声音。计数只存在当前实例内存中，不保存、不导出、不上传。

## 单页阅读彩蛋

只有宿主明确声明的一个公开文章/项目容器才支持阅读彩蛋，默认关闭进度计数：

```js
const guide = mountAndromeda({
  reading: {
    kind: 'project', // 或 article
    id: 'my-project-intro-v1',
    selector: '#public-project-intro',
    title: '项目介绍',
  },
});
```

用户可在面板主动开启“本页阅读进度彩蛋”，组件只计算这个容器的可见停留和几何进度；默认可见停留 12 秒并达到 85% 时，在面板内点亮星光卡，不主动弹窗。`minimumVisibleMs` 可设置 1–60 秒。该进度不是阅读理解或完成证明，用户始终可以直接手动领取，也可以关闭本页彩蛋；内容和工具访问不受奖励影响。

只在对应稳定 id 的独立本地键保存 earned/dismissed 两个布尔值，不读取浏览记录，不保存 URL、文章文字、滚动轨迹或跨站数据。进度本身仅留在当前实例内存中。宿主未配置容器时没有进度监听任务；进入后台、离开容器或关闭功能后停止计时。星匠集成只声明了模匠上手、星璇站宠说明这两个项目段落，其他页面未开启此能力。

## 关键操作避让与回桌面

`avoidSelectors` 接受宿主明确选择的下载、提交、主要入口等选择器（最多 16 条、每次至多 64 个可见区域）；不默认遍历所有网页按钮。布局、尺寸变化、滚动和面板开闭时，SDK 优先使用保存的拖放位置，只在它遮住目标时临时移到最近的安全位置。展开形态无处可放时暂时收成小入口；点击可手动展开，关闭面板恢复避让。临时位置不覆盖用户的拖放偏好，拖动过程中不会抢夺指针。极小视口或整屏都被指定区域占满时，入口仍保留可恢复能力，不能保证零遮挡。

面板的“回桌面陪伴”是固定协议链接 `andromeda-pet://open?target=companion`，只在用户点击时交给浏览器处理。SDK 不探测是否安装、不自动启动桌宠、不设定时弹窗；“还没安装？下载桌宠”始终在旁边。浏览器/操作系统可能请求用户选择应用，未安装时使用下载回落即可。SDK 不接受任意 URL 或命令作为协议参数，也不从网页传送私人数据。

destroy 会终止资源请求、取消调度计时、注销全局监听器、关闭音频并移除 DOM。资源加载失败保留静态形象或星形占位；页面导航与公开 FAQ 保持可用。无摄像头、麦克风、AI、遥测或推送权限请求。宿主网站自身的数据采集不由本组件声明覆盖。

销毁也会立即回收待释放的导出 Blob URL；异步偏好文件读取完成后会再次检查销毁状态，避免退出后写存储或回调。宿主自己注册的按钮/页面监听器由宿主管理。静置沿用 45–90 秒动作截止时间，没有连续 RAF；隐藏、收起和减动状态按需停止。资源探针 `node web/measure-resources.mjs current <网站构建目录>` 与布局矩阵 `node web/verify-layout.mjs` 的口径和结果见 [性能审查](../docs/PERFORMANCE-0.3.1.md)。

## 集成到星匠

集成基于现有星匠网站源码，保留原站功能。网站主分支连接 Cloudflare Pages，推送可能自动部署；集成在网站集成分支进行。0.3.2 已合入主分支并正式上线。具体接入与本地验收见 `docs/site-integration.md`，正式部署证据见 [上线记录](../docs/SITE-DEPLOYMENT-0.3.2.md)。


0.3.2 补充：偏好文件导入与 `importPreferences()` 使用同一路径更新核心、主题和画布；挂载时检查已聚焦的输入控件。音频在用户已开启声音的前提下由可信前台手势恢复，单纯回到前台不发声。导览每站设置下一步按钮焦点，支持 Escape 退出。回归范围见 [0.3.2 验证](../docs/VALIDATION-0.3.2.md)。
