# 自定义角色 Canvas 适配器

`src/custom-character.mjs` 接受 `andromeda.character/v1` 元数据、主进程已验证并保存在本机的 PNG/WebP `data:` URL，以及宿主现有的 Canvas。它不加载元数据里的路径、不联网、不调用 Electron API，不创建新的拖动层或菜单。

```js
import {createCustomCharacter} from './custom-character.mjs';
const custom = createCustomCharacter({
  canvas,
  pack,
  imageDataURL,
  reducedMotion: false,
  showAnchors: false,
});
try {
  await custom.ready;
  custom.draw('greet');
} catch {
  custom.destroy(); // 宿主回到内置角色，并显示导入图片无法解码。
}
```

接口：

- `ready: Promise<boolean>`：图片实际解码尺寸必须与角色包一致；成功为 `true`，加载期间销毁为 `false`，解码失败或尺寸不一致则拒绝。
- `draw(semantic)`：通过共享语义表查找动作，完整播放一次后回到角色包的 `neutral`；返回解析后的动作信息。图片加载前只保存最后一次请求。
- `neutral()`：取消当前动作并显示包内静止帧。`stop()` 仅取消动画及待载入请求，保留已绘制的画面。
- `gaze(dx, dy)`：使用包内实际角度和布局选择最近注视帧，向上为 0°，顺时针递增。小于 24 的距离回到静止。正在播放动作时不覆盖动作；缺失注视布局时回到静止。
- `setReducedMotion(boolean)`：与系统减少动态效果设置合并。减少动态效果只显示动作首帧，不安排动画计时器；恢复偏好不会自行重播已经停止的动作。
- `anchors()`：返回 `ground/body/face/dialogue` 在 Canvas 像素坐标中的位置副本。`showAnchors` 可显示调试标记，但标记不参与命中检测。
- `hitTest(x, y)`：传入 Canvas 像素坐标；只检测实际角色透明度，大于 16/255 为命中。客户端坐标需要宿主按 `canvas.width / rect.width`、`canvas.height / rect.height` 换算。
- `destroy()`：取消动画、解除监听、释放图像引用和命中缓冲、清空宿主 Canvas；可重复调用。销毁后迟到的图片回调不会绘制。

单元帧按比例缩放，水平居中、底部对齐，不修改宿主 Canvas 尺寸。显示 Canvas 限制为每边 1–4096 像素，图集和帧尺寸遵循共享角色包校验。图片最多 8 MiB，仅接受 PNG/WebP base64 URL；原始文件完整性和 ZIP 格式必须由导入服务先行验证。模块还会核验浏览器实际解码尺寸。

页面隐藏时取消动画并显示静止帧，恢复可见不会自动重播。锁屏、睡眠和角色切换仍由宿主调用 `neutral()` / `stop()` / `destroy()`。先销毁旧实例再创建新实例，避免旧实例清空新角色。经典桌宠的拖动、双击、右键、台词和音乐律动继续由现有增强层负责，只需把视觉动作、注视和透明度命中转交此适配器。

测试使用模拟 Canvas、图片解码和计时器，不产生网络请求或原生操作；真实桌面交互和素材观感仍需宿主集成测试覆盖。
