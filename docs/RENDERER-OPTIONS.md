# 星璇渲染路线与模型适配边界

日期：2026-10-22。结论：本版继续使用 **2D 精灵作为默认运行形态**，可选 Studio 静态姿态作为另一种表现。Live2D 与可动画 3D 是有明确素材和验证门槛的后续路线。本文件完成路线比较与接口设计，不代表已完成模型制作、绑定、SDK 接入或原生验收。

## 现有资产的确切能力

### Classic 精灵

`assets/andromeda.png` 是 1536×2288 的透明 2D PNG，单格 192×208。9 组帧动画与 16 向注视已经由 `assets/manifest.json` 描述。16 向是头脸注视姿态，并不等于全身旋转；左右跑步与工作/思考有不同语义。

共享 `src/shared/character.mjs` 已提供角色包校验、来源/权利、归一化锚点、质量档、语义动作映射及显式 fallback。`src/shared/behavior.mjs` 管理队列、冷却、抢占和暂停恢复。它们不依赖 Canvas 或某个模型 SDK，因此后续可以复用行为事件而更换绘制层。

### Studio 姿态

Studio 是本轮新增、可选的透明静态姿态集合。当前应明确标注为静态姿态切换：适合更清楚的立绘、坐姿、表情和导览反馈，不等同于完整连贯动画。静态图之间的淡入淡出也不构成骨骼、口型或真正多角度动画；Classic 仍是默认与失败回退。

### 网站现有 3D 模型：已核对二进制结构

网站源码中的 `public/models/xingxuan.glb` 可以用于旋转展示，但没有可驱动的人形骨骼或动作。2026-10-22 对该本地 GLB 2.0 文件只读解析 JSON chunk，结果如下：

| 项目 | 核对结果 |
|---|---|
| 文件字节数 | 693,864 |
| SHA-256 | `f52da5e474e9f10e0bbeae87bc448b3afd1e5acdcae4cbcfec6e02166f0e7ef0` |
| 生成信息 | `Modelwright 0.1.0 (glTF-Transform 4.5.1)` |
| glTF 版本 | 2.0 |
| 节点 / 网格 | 2 / 1 |
| 三角面 | 7,999 |
| `skins` / `animations` | 0 / 0 |
| 带 `targets` 的 morph primitive | 0 |
| `extensionsUsed` | 空 |

这是实际文件结构检查，不只是读取展示文案。与[星璇介绍页](https://starwright.xyz/tools/xingxuan/)“静态模型，没有骨骼和动画”的现状一致。页面展示由网站 `src/viewer/model-viewer.ts` 的 Three.js / GLTFLoader / OrbitControls 完成，旋转相机不是角色动作。

glTF 将网格、蒙皮、morph targets 与动画作为不同结构；有 GLB 文件并不能推出它有骨骼或动画。无蒙皮模型仍可以作为整体物体位移/旋转，但那不等于人物挥手、行走或口型。[Khronos glTF 2.0 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)

## 三条路线的适用取舍

| 路线 | 最适合的目标 | 需要的输入 | 本项目可复用 | 当前缺少的关键部分 | 当前选择 |
|---|---|---|---|---|---|
| 2D sprite / 静态姿态 | 小体积、统一画风、离线陪伴、网站轻向导 | 同一角色的高质量图集、动作时长、锚点、命中轮廓 | 角色、Canvas、语义事件、静态降级 | 循环/转场、高 DPI 资产、触摸/睡眠/指路完整动画 | 默认路线，逐批补素材 |
| Live2D | 面部表情、呼吸、眼神、上半身说话和温和摆动 | 原创分层绘画、模型参数/网格、物理、动作/表情文件 | 人设、事件、情绪、调度、宿主接口 | 分层原画与模型制作、运行时集成、许可与性能测试 | 可选原型，未接入 |
| 骨骼 3D / VRM | 真正转身、多视角、坐卧走跳、换装模型 | 合理拓扑、骨骼/权重、表情/口型、动作、材质和授权 | 静态模型参考、查看器经验、语义事件 | 当前 GLB 无蒙皮/动画/表情；重拓扑检查、绑定与相机适配 | 独立试制，不替换默认 |

这是本项目的工程判断，不是声称某路线必然更省内存。2D 图集扩大后会增加下载和解码内存，Live2D/3D 会引入模型更新和图形上下文；实际开销应在同一设备、显示尺寸、帧率及静止/交互负载下测量。

Live2D 官方 SDK 定义了眨眼、呼吸、口型、物理、动作与表情等组件，可作为原型能力检查表；它不会自动将现有扁平 PNG 变成合格分层模型。[Live2D Cubism SDK 手册](https://docs.live2d.com/en/cubism-sdk-manual/top/)

若选择 VRM，可以评估 Three.js + GLTFLoader + `@pixiv/three-vrm` 的官方加载链。当前无 VRM 扩展的 GLB 不是已经做好的人形 VRM 角色。[three-vrm 官方仓库](https://github.com/pixiv/three-vrm)

## 可落地的适配接口设计

以下是后续适配器合同，**不是已经实现的全部接口**。现有角色包校验只接受 PNG/WebP 与明确 atlas schema；引入模型时应增加新版本/schema 分支，不应悄悄放任意脚本或 URL。

```ts
type RendererCapabilities = {
  kind: 'sprite' | 'static-poses' | 'live2d' | 'vrm';
  actions: string[];
  gaze: boolean;
  expressions: string[];
  mouth: 'none' | 'amplitude' | 'viseme';
  arbitraryView: boolean;
  hitRegions: string[];
};

interface CharacterRenderer {
  load(packageData: ValidatedCharacterPackage, signal: AbortSignal): Promise<void>;
  capabilities(): RendererCapabilities;
  resize(size: {width: number; height: number; pixelRatio: number}): void;
  play(plan: {id: string; action: string; durationMs: number; static: boolean}): void;
  setGaze(direction: {x: number; y: number} | null): void;
  setExpression(name: string, weight: number): void;
  setMouth(value: {amplitude?: number; viseme?: string} | null): void;
  hitTest(point: {x: number; y: number}): string | null;
  anchor(name: 'ground' | 'face' | 'dialogue'): {x: number; y: number};
  pause(reason: 'hidden' | 'background' | 'drag' | 'system'): void;
  resume(reason: 'hidden' | 'background' | 'drag' | 'system'): void;
  destroy(): void;
}
```

宿主处理窗口、托盘、显示器、网页路由、权限和网络；行为调度决定 action；渲染器仅表现已批准计划。模型不能直接调用系统操作、读文件、唤回隐藏桌宠或绕过访客/主人数据隔离。

接入顺序：

1. 先包装现有 Canvas 为 SpriteRenderer，保持行为输出相同，形成可执行的公共接口测试。
2. 为静态姿态提供 StaticPoseRenderer，明确 `mouth:'none'`、`arbitraryView:false`；缺动作回退 Classic 或中性。
3. 新模型先做独立预览器：正确加载/销毁，列出真实动作与表情，输出资源大小、帧时间和错误。
4. 通过最小动作矩阵后再接双端宿主；仍保留 Classic 作为加载失败、显卡失败和用户选择的回退。
5. 最后接可选语音口型。音量驱动标注为幅度口型，不宣传准确音素同步；静音、取消和后台暂停同时终止嘴部活动。

## 制作与验收门槛

### 2D 当前可执行的补强

- 固定头饰侧、头身比、发色、白靴和服饰结构；保留原图集和身份。
- 新动作有进入/循环/退出，使用固定地面/对话锚点；相同事件不造成脚底抖动或突然换比例。
- 原生尺寸、125%/200% 与高 DPI 检查；黑/白及网页深浅背景检查透明边缘。
- Studio 每个姿态注明真实用途和来源；先验证一致性，再增加数量；不将静态图计为连续动画。

### Live2D 进入产品前

- 有可编辑分层源文件、可加载模型、参数/动作/表情清单及权利记录。
- 最少验证 idle、greet、think、happy、question；眼神和嘴部参数独立检查；缺动作明确降级。
- 加载、损坏、取消、更换、销毁和 WebGL 丢失不遗留渲染循环或监听。
- 实测 Windows 透明窗口和目标网站手机端的尺寸、帧时间、资源和背景暂停。
- 分别核对 Framework、Core、模型、字体/音频及发行许可；代码许可不替代模型许可。

### 3D / VRM 进入产品前

- 网格/材质可复现，骨骼层级和蒙皮权重通过检查，关节弯曲不明显破面。
- 有所选挥手、左右行走、跳跃、等待/思考、坐/睡动作，转场不滑步；骨骼与 morph 表情分别验证。
- 若用 VRM，明确规范和元数据；实测人形映射、注视、表情、材质和动作兼容。
- 正/侧/背面不穿帮；透明窗相机和地面锚点一致；手机保留轻量版本与海报。
- 记录设备、显卡、分辨率、模型哈希和运行时版本；测试加载、切模型、后台、长时运行、销毁。

## 明确未完成的事项

- 当前 GLB 尚未绑定为有骨骼、表情、口型和动作的可用角色。
- 尚未交付已集成的 Live2D/VRM 渲染器，也未通过对等原型测试宣布某路线获胜。
- 窗口物理策略不等于坐在其他应用窗口表面；全局键盘监听也不属于现有渲染能力。
- Windows 签名、macOS 签名/公证、ARM64/macOS/Linux 硬件验收各有独立依赖，不能用浏览器预览或单元测试代替。

A09 当前交付是**技术比较、真实模型结构核验及适配合同设计**。完成“模型试制比较后选路线”仍需要实际制作候选模型、接入原型并测量；本版不把这些依赖写成已完成。
