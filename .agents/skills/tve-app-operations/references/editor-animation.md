# 单元：动画编辑器

## 操作面：入口与聚焦模式

- 新建 .anim：资产面板右键「新建动画」→ 命名弹窗 → 模板创建（useAssetActions.ts:151）。
- 打开：检查器动画组件卡「在动画编辑器中打开」（AnimationClipFields.vue:92）→
  面板切到底部动画 dock。
- **聚焦编辑模式**：打开时带节点 id → 场景选中锁定该节点子树、其它节点不可选
  （setSelectionFilter 谓词）、其余对象材质压暗 0.35、面板切换锁定、出现「退出
  编辑」（anim-edit-mode.ts:1）；不带 nodeId = 只读蒙版查看。

## 操作面：剪辑与轨道

- 剪辑切换/时长/循环开关（useAnimClip/useAnimTracks）；**改动 600ms 防抖自动写盘**
  .anim（useAnimClip.ts:29）——无手动保存按钮。
- 「添加属性」菜单按选中节点能力分组逐级下钻（变换 ▸ 位置 ▸ X），已加通道禁用：
  可动画属性 = Transform Position/Rotation/Scale XYZ、Material Color RGB/Metalness/
  Roughness/EmissiveIntensity、UI Position/Size/SortOrder/FontSize（anim-props.ts:78）。
- K 帧：keyAll/keyChannel 一键打关键帧；关键帧右键菜单改插值/切线/删除。

## 操作面：曲线与时间轴（dope/curve 双视图）

- 关键帧拖拽改时间/数值；空白点击插帧；贝塞尔切线手柄（自动态虚影、拖即固化、
  对称联动、权重柄）；中键平移；数值轴自动适配（useAnimCurve.ts）。
- 时间轴：滚轮缩放、Ctrl+滚轮平移、scrub、吸附（useAnimTimeline.ts）。

## 操作面：播放与录制

- 播放预览：单 rAF 推进 + **录制 auto-key**（开启后通道值变化即写关键帧，
  useAnimPlayback.ts:38）。
- 预览采样直写选中节点（3D/UI），**非破坏**——停止/换目标自动还原姿势
  （useAnimPreview.ts:1）。

## 规则/要点

- .anim = 变换通道曲线（AnimationClipData 形状）；运行期由 AnimationClip 组件
  播放（脚本 `@property(AnimationClip)`，模板见 `tve-sdk-scripting` tween-anim.md）。
- 聚焦模式的材质压暗是克隆实现，退出还原；动画聚焦期间布局视图的 UI 选中过滤
  不越权覆盖（editor.ts:148 注释）。
- 曲线求值契约（钳制/插值）在 `src/framework/animation/clip.ts`——检查器 UI 与
  播放运行时共用同一求值器。

## 测试例

- 真实 spec：`src/framework/animation/clip.spec.ts`——parseAnimationClip 收敛
  （关键帧/插值/钳制）与 evaluateCurve 采样（核心桶 90/85）。
- 面板组合函数（anim-editor 8 个）无 spec；纯时间轴数学若抽离可按
  `tve-unit-testing` pattern-logic.md 补测。
