// ---------------------------------------------------------------------------
// 事件反应路由：外部输入与场景图事件 → 各子系统的同步分发。
// - handleGraphChange：SceneChange → 同步器/辅助线/音频/物理/粒子/导航/逻辑
//   的差异化同步 + 天空/雾重算 + 未解析资产预取 + 广播 graph:changed；
// - onSelectionChanged / onViewportMouseDown：选择变化与视口点选；
// - syncGizmoTransformToNode：gizmo 拖拽中变换实时回写数据节点（UI 锚点
//   托管节点换算回 anchoredPosition）；
// - 捕获阶段拦截（gizmo 拖动独占输入）；
// - syncAudioComponents / syncPhysicsNode：组件模式的增量化绑定（图事件与
//   整体重建共用）。
// ---------------------------------------------------------------------------
import type { EditorEngine } from "./EditorEngine";
import type { SceneChange } from "../scene/SceneClient";
import { radToDeg } from "../prototype/types";
import { isAudioSourceComponent, type Node } from "../prototype/Node";
import {
  AudioNode,
  FsmRunnerNode,
  BtRunnerNode,
  MeshNode,
  NavAgentNode,
  NavAreaNode,
  ParticleSystemNode,
  UIWidgetNode,
} from "../prototype/derived/Primitives";
import { uiParentRectInOwnSpace } from "./modules/ui";
import { uiInverseAnchoredPosition, vec2, type UIRect } from "../prototype/nodes/ui-shared";
import { pickSelectableNodeId } from "./modules/picking";
import { isSelectableInViewport, isUIPositionManaged } from "./viewportQuery";
import { refreshMaterialNodes } from "./assetRefresh";
import { applyFogFromGraph } from "./fogEnv";
import { applySkyFromGraph } from "./skyEnv";
import { syncPreviewView } from "./previewView";
import { resyncNavAreas } from "./navSources";
export function handleGraphChange(engine: EditorEngine, c: SceneChange): void {
  // 场景数据变化 = 视口活动：空闲降帧立即恢复全速渲染本次变更；
  // 同时标脏阴影图（变换/几何/增删都会改变投影内容）
  engine.renderer.markActivity();
  engine.renderer.markShadowDirty();
  engine.synchronizer.onGraphChange(c, engine.graph);
  engine.helperSystem.onGraphChange(c, engine.graph, engine.synchronizer.getObjectMap());
  // 节点子树移除 → 其动画绑定（mixer/骨骼辅助线）一并解除
  if (c.kind === "remove") {
    engine.animation.unbind(c.nodeId);
    // 选中节点在被移除子树内（撤销/回滚/删除）→ 先清选中，
    // 避免 gizmo 持有已摘除对象反复报 "must be a part of the scene graph"
    if (
      engine.selectedId &&
      (c.nodeId === engine.selectedId || engine.graph.isDescendant(c.nodeId, engine.selectedId))
    ) {
      engine.select(null);
    }
  }
  // 音源节点：入图/属性变更 → 按最新数据同步音源；移除 → 解绑销毁
  if (c.kind === "remove") {
    engine.audio.unbind(c.nodeId);
  } else {
    const n = engine.graph.get(c.nodeId);
    if (n instanceof AudioNode && (c.kind === "add" || c.kind === "properties")) {
      const obj = engine.synchronizer.getObjectMap().get(n.id);
      if (obj) engine.audio.syncNode(n, obj);
    }
  }
  // 音源组件（组件模式）：入图/属性变更 → 按组件数据增量化同步；移除 → 全部解绑
  if (c.kind === "remove") {
    for (const compId of engine.audioCompBindings.get(c.nodeId) ?? []) engine.audio.unbind(compId);
    engine.audioCompBindings.delete(c.nodeId);
  } else if (c.kind === "add" || c.kind === "properties" || c.kind === "replace") {
    const n = engine.graph.get(c.nodeId);
    if (n) syncAudioComponents(engine, n);
  }
  // 物理组件：入图/属性变更 → 差异同步刚体/碰撞体；移除 → 解绑
  if (c.kind === "remove") {
    engine.physics.unbind(c.nodeId);
  } else if (c.kind === "add" || c.kind === "properties") {
    const n = engine.graph.get(c.nodeId);
    if (n) syncPhysicsNode(engine, n);
  }
  // 粒子系统节点：入图/属性变更 → 按最新设置同步发射器（结构参数变化重建，
  // 其余原地更新不打断已存活粒子）；移除 → 解绑释放
  if (c.kind === "remove") {
    engine.particles.unbind(c.nodeId);
  } else if (c.kind === "add" || c.kind === "properties") {
    const n = engine.graph.get(c.nodeId);
    if (n instanceof ParticleSystemNode) {
      const obj = engine.synchronizer.getObjectMap().get(n.id);
      if (obj) engine.particles.syncNode(n, obj);
    }
  }
  // 导航节点：区域入图/属性变更 → 按签名重烘焙（产物写 userData 后回调刷新
  // 可视化叠层）；代理入图/属性变更 → 重绑；任一移除 → 解绑 + 清缓存。
  // 其余节点变化（网格移动/编辑、地形雕刻、障碍增删、重挂）→ 全部区域重检
  // 签名：采样源与障碍变了才真正重烘焙（地形时代这些不触发，需手动点重烘焙）。
  if (c.kind === "remove") {
    engine.nav.unbind(c.nodeId);
    engine.navFieldCache.delete(c.nodeId);
    engine.navMeshBoundsCache.delete(c.nodeId);
    resyncNavAreas(engine);
  } else if (c.kind === "add" || c.kind === "properties" || c.kind === "replace") {
    const n = engine.graph.get(c.nodeId);
    const obj = engine.synchronizer.getObjectMap().get(c.nodeId);
    if (n && obj) {
      if (n instanceof NavAreaNode) engine.nav.syncArea(n, obj);
      else if (n instanceof NavAgentNode) engine.nav.syncAgent(n, obj);
    }
    if (!(n instanceof NavAreaNode) && !(n instanceof NavAgentNode)) resyncNavAreas(engine);
  } else if (c.kind === "reparent") {
    resyncNavAreas(engine);
  }
  // 逻辑运行器节点：入图/属性变更 → 按最新设置同步（绑定资产变化即热重建）；
  // 移除 → 解绑清理运行态
  if (c.kind === "remove") {
    engine.logic.unbind(c.nodeId);
  } else if (c.kind === "add" || c.kind === "properties" || c.kind === "replace") {
    const n = engine.graph.get(c.nodeId);
    const obj = engine.synchronizer.getObjectMap().get(c.nodeId);
    if (obj && n instanceof FsmRunnerNode) engine.logic.syncFsm(n, obj);
    else if (obj && n instanceof BtRunnerNode) engine.logic.syncBt(n, obj);
  }
  engine.events.emit("graph:changed", c);
  syncPreviewView(engine);
  // 场景结构/属性变化（增删/重挂/属性/整体替换）→ 天空背景可能变化；纯变换/改名不重算
  if (
    c.kind === "add" ||
    c.kind === "remove" ||
    c.kind === "reparent" ||
    c.kind === "properties" ||
    c.kind === "replace" ||
    c.kind === "clear"
  ) {
    applySkyFromGraph(engine);
    applyFogFromGraph(engine);
  }
  // 新入图/属性变更引用了尚未解析的材质资产（如撤销/重做改回引用）→ 异步预取后刷新
  const n = engine.graph.get(c.nodeId);
  if (n instanceof MeshNode && !engine.materials.has(n.material)) {
    const rel = n.material;
    void engine.materials.preload([rel]).then(async () => {
      await engine.shaders.preload([engine.materials.shaderFor(rel)].filter((s) => s.length > 0));
      refreshMaterialNodes(engine, rel);
    });
  }
  // 同理：尚未解析的模型资产 → 预取后经 models.onChanged 自动刷新网格与动画
  if (
    n instanceof MeshNode &&
    n.source === "model" &&
    n.model &&
    !engine.models.has(n.model)
  ) {
    void engine.models.preload([n.model]);
  }
}

/** 选中变化反应（select:changed 事件挂载）：骨骼辅助线跟随 + 预览相机跟随 */
export function onSelectionChanged(engine: EditorEngine): void {
  // 骨骼辅助线跟随选中（仅选中节点的模型显示）
  engine.animation.setSelected(engine.selectedId);
  if (!engine.previewMode) return;
  syncPreviewView(engine);
}

export function onViewportMouseDown(engine: EditorEngine, e: MouseEvent): void {
  // Only handle left-click (button 0) and only when not dragging in orbit/gizmo
  if (e.button !== 0) return;
  if (engine.gizmo.isDragging()) return;
  // 地形绘制模式：左键归笔刷（点选/框选语义暂停）
  if (engine.terrainPaint?.active) return;
  // 预览渲染无编辑器选择语义
  if (engine.previewMode) return;

  // Calculate mouse position in normalized device coordinates (-1 to +1)
  const rect = engine.renderer.domElement.getBoundingClientRect();
  engine.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  engine.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  // Set up raycasting from camera through mouse position
  engine.raycaster.setFromCamera(engine.mouse, engine.renderer.camera);

  // Get all mapped scene objects
  const objectMap = engine.synchronizer.getObjectMap();
  const objects = Array.from(objectMap.values());

  // Find intersections with scene objects
  const intersects = engine.raycaster.intersectObjects(objects, true);
  if (intersects.length === 0) {
    // Clicked empty space — clear selection (unless shift is held for multi-select)
    if (!e.shiftKey && !e.ctrlKey) {
      engine.clearSelection();
    }
    return;
  }

  // 命中解析：跳过场景根节点与「不可见/未激活」的候选（节点自身或祖先隐藏都不该被选中，
  // 隐藏对象"穿透"——继续看它后面的命中，从而能选中被挡住的可见对象）。
  const rootId = engine.graph.root?.id ?? null;
  const pickedId = pickSelectableNodeId(intersects, {
    objectMap,
    rootId,
    isSelectable: (id) => isSelectableInViewport(engine, id),
  });
  if (!pickedId) {
    // Clicked empty space (or only resolved to the scene root) — clear selection
    // (unless shift is held for multi-select)
    if (!e.shiftKey && !e.ctrlKey) {
      engine.clearSelection();
    }
    return;
  }
  if (e.shiftKey || e.ctrlKey) {
    engine.toggleSelection(pickedId);
  } else {
    engine.select(pickedId);
  }
}

/** gizmo 拖动独占：捕获阶段拦截其它鼠标按下（避免左键串扰变换） */
export function onCapturePointerDown(engine: EditorEngine, e: PointerEvent): void {
  if (engine.gizmo && engine.gizmo.isDragging()) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/** gizmo 拖动独占：捕获阶段拦截键位输入（W/E/R、Delete、Ctrl+Z 等） */
export function onCaptureKeyDown(engine: EditorEngine, e: KeyboardEvent): void {
  if (engine.gizmo && engine.gizmo.isDragging()) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/**
 * gizmo 拖动中调用：把当前被拖 three 对象的变换实时写回数据节点
 * （不产生历史命令，undo 仍以拖动起点/终点为准），并广播 transform 变化，
 * 让属性面板数值与 gizmo 同步。
 * UI 锚点托管节点（画布子树内的 Widget/布局容器）：位置换算回 anchoredPosition
 * （拉伸轴不可表达、忽略），缩放除以拉伸比折算回 2D 缩放；位置/缩放字段由
 * UISystem 每帧布局解析接管，transform.position 不再是位置源。
 */
export function syncGizmoTransformToNode(engine: EditorEngine): void {
  const id = engine.selectedId;
  if (!id) return;
  const node = engine.graph.get(id);
  const obj = id ? engine.synchronizer.getObjectMap().get(id) : undefined;
  if (!node || !obj) return;
  const rot = radToDeg({ x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z });
  if (node instanceof UIWidgetNode && isUIPositionManaged(engine, id)) {
    const u = obj.userData;
    // 父矩形归一化到父自身局部空间（原点 = 父矩形中心；uiRect 存储语义按节点类型而异）
    const parentRect = uiParentRectInOwnSpace(obj.parent);
    if (parentRect) {
      const inv = uiInverseAnchoredPosition(
        parentRect,
        {
          anchorMin: u.uiAnchorMin,
          anchorMax: u.uiAnchorMax,
          pivot: u.uiPivot,
          anchoredPosition: u.uiAnchorPos,
          offsetMin: u.uiOffsetMin,
          offsetMax: u.uiOffsetMax,
          size: u.uiSize,
        },
        obj.position.x,
        obj.position.y,
      );
      if (inv.x !== null) node.anchoredPosition = vec2(inv.x, node.anchoredPosition.y);
      if (inv.y !== null) node.anchoredPosition = vec2(node.anchoredPosition.x, inv.y);
    }
    // obj.scale = 2D 缩放 × 解析比 → 除回解析比得到纯 2D 缩放
    const rx = u.uiRect && u.uiSize ? (u.uiRect as UIRect).w / Math.max(0.01, u.uiSize.x) : 1;
    const ry = u.uiRect && u.uiSize ? (u.uiRect as UIRect).h / Math.max(0.01, u.uiSize.y) : 1;
    node.transform.setScale(obj.scale.x / rx, obj.scale.y / ry, obj.scale.z);
    node.transform.setRotation(rot.x, rot.y, rot.z);
    engine.graph.notifyTransformChanged(node.id);
    return;
  }
  node.transform.setPosition(obj.position.x, obj.position.y, obj.position.z);
  node.transform.setRotation(rot.x, rot.y, rot.z);
  node.transform.setScale(obj.scale.x, obj.scale.y, obj.scale.z);
  engine.graph.notifyTransformChanged(node.id);
}

/**
 * 音源组件同步（组件模式）：按节点上 audioSource 组件增量化绑定 AudioSystem
 * （以组件 id 为绑定键，运行时播放/暂停控制同 id 寻址）；组件被移除/停用后
 * 解绑。绑定键集合记录在 audioCompBindings，供节点移除时集中解除。
 */
export function syncAudioComponents(engine: EditorEngine, node: Node): void {
  const obj = engine.synchronizer.getObjectMap().get(node.id);
  if (!obj) return;
  const prev = engine.audioCompBindings.get(node.id) ?? new Set<string>();
  const next = new Set<string>();
  for (const c of node.components) {
    if (!isAudioSourceComponent(c) || !c.enabled) continue;
    next.add(c.id);
    engine.audio.syncNode({ id: c.id, audio: c.audio }, obj);
  }
  for (const compId of prev) {
    if (!next.has(compId)) engine.audio.unbind(compId);
  }
  if (next.size) engine.audioCompBindings.set(node.id, next);
  else engine.audioCompBindings.delete(node.id);
}

/** 节点物理组件同步（有刚体/碰撞体组件 → 绑定；无 → 解绑） */
export function syncPhysicsNode(engine: EditorEngine, node: Node): void {
  const hasPhysics = node.components.some(
    (c) => c.type === "rigidBody" || c.type === "collider",
  );
  const obj = engine.synchronizer.getObjectMap().get(node.id);
  if (!obj) return;
  if (hasPhysics) engine.physics.syncNode(node, obj);
  else engine.physics.unbind(node.id);
}
