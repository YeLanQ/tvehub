# 单元：composables 组合层索引（`src/app/composables/` + `src/ui-kit/composables/`）

## 契约

组合函数按领域分目录；命名 `useXxx`。这里只做索引，细节进对应源文件读头注释。

**app/composables/inspector/**（13 个，检查器各分区）：
`useInspectorNode / useInspectorComponents / useInspectorMaterial / useInspectorModelMaterial /
useInspectorPhysics / useInspectorTerrain / useInspectorParticles / useInspectorNav /
useInspectorFog / useInspectorLightAudio / useInspectorLogic / useInspectorCameraSky / useInspectorUI`

**app/composables/assets/**（4 个，资产面板动作）：
`useAssetActions`（导入/新建/工坊导入到项目）、`useAssetItemActions`（单项右键动作）、
`useAssetTransfer`（拖放转移）、`useWorkshopMenu`（工坊菜单）

**app/composables/anim-editor/**（8 个，动画编辑器）：
`useAnimClip / useAnimCurve / useAnimEditor / useAnimPlayback / useAnimPreview /
useAnimSelection / useAnimTimeline / useAnimTracks / useAnimView`

**app/composables/ 顶层**：`use-task-scheduler`（任务面板，见 facade-tasks-build.md）、
`graph-canvas`（节点图画布）、`logic-editor`（FSM/BT 编辑器）

**ui-kit/composables/**（4 个，全局单例浮层）：
`confirm` / `toast` / `prompt` / `context-menu`（Promise 式调用）+ `draco-compress`

## 使用例

`src/app/components/inspector/FogSection.vue:62`（检查器分区 + ui-kit NumberField，
commit 事件回写引擎）：

```vue
<NumberField :model-value="s.near" :step="1" :min="..." :max="..."
             @commit="(v) => emit('update', 'Set Fog Near', clamp(v, ...))" />
```

`src/app/components/InspectorPanel.vue:200`（ComponentCard 分区卡片）：

```vue
<ComponentCard title="Asset" :open="true" :type="assetRel.split('.').pop()">
```

`src/app/composables/assets/useAssetActions.ts:120`（工坊脚本导入读源码）。

## 测试例

ui-kit 的 4 个单例 composable **已有真实 spec**，是组合层测试的权威范式：

- `src/ui-kit/composables/toast.spec.ts` — 入队 id、分级默认时长、到期自动离场（fake timers）
- `src/ui-kit/composables/confirm.spec.ts` — Promise 兑现与状态复位
- `src/ui-kit/composables/prompt.spec.ts` — 默认文案、initial 写入、closePrompt 兑现
- `src/ui-kit/composables/context-menu.spec.ts` — 坐标记录、视口钳位、子菜单定位
- `src/ui-kit/composables/draco-compress.spec.ts` — formatBytes、open/close 选项语义

app/composables/ 下当前无 spec；给它们补测试时照 toast.spec 的单例复位模式
（beforeEach 复位 + fake timers + vi.fn 桩），完整模式见 `tve-unit-testing` 技能
references/pattern-singleton.md。
