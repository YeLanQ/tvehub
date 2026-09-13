// ---------------------------------------------------------------------------
// 目标节点（场景选中）与预览应用：把采样值直接写到选中节点的三维对象/UI 节点
// 数据，不进撤销历史（非破坏），换目标/停止时还原姿势与 UI 字段。通道组分应
// 用与播放器 animclip.mjs 的编译应用镜像。
// ---------------------------------------------------------------------------
import { computed } from "vue";
import * as THREE from "three";
import type { Node } from "../../../framework/prototype/Node";
import { evaluateClip, type AnimProp } from "../../../framework/animation/clip";
import { getEditorStore } from "../../stores/editor";
import { animEditMode } from "../../lib/anim-edit-mode";
import type { AnimEditorCtx, PreviewApi } from "./ctx";

const D2R = Math.PI / 180;

/** UI 节点数据字段的最小写入面（Widget/Layout 共有 + 可选扩展字段） */
interface UiFieldView {
  anchoredPosition: { x: number; y: number };
  size: { x: number; y: number };
  sortOrder: number;
  fontSize?: number;
  spacing?: { x: number; y: number };
  padding?: { left: number; right: number; top: number; bottom: number };
}

/** UI 节点数据快照（预览前保存、停止/换目标时还原） */
interface UiSnapshot {
  anchoredPosition: { x: number; y: number };
  size: { x: number; y: number };
  sortOrder: number;
  fontSize?: number;
  spacing?: { x: number; y: number };
  padding?: UiFieldView["padding"];
}

function uiViewOf(node: Node): UiFieldView | null {
  const w = node as unknown as Partial<UiFieldView>;
  if (!w.anchoredPosition || !w.size) return null;
  return w as UiFieldView;
}

function uiSnapshotOf(node: Node): UiSnapshot | null {
  const w = uiViewOf(node);
  if (!w) return null;
  return {
    anchoredPosition: { ...w.anchoredPosition },
    size: { ...w.size },
    sortOrder: w.sortOrder,
    fontSize: w.fontSize,
    spacing: w.spacing ? { ...w.spacing } : undefined,
    padding: w.padding ? { ...w.padding } : undefined,
  };
}

function restoreUiSnapshot(node: Node, snap: UiSnapshot): void {
  const w = uiViewOf(node);
  if (!w) return;
  w.anchoredPosition = { ...snap.anchoredPosition };
  w.size = { ...snap.size };
  w.sortOrder = snap.sortOrder;
  if (w.fontSize !== undefined && snap.fontSize !== undefined) w.fontSize = snap.fontSize;
  if (w.spacing && snap.spacing) w.spacing = { ...snap.spacing };
  if (w.padding && snap.padding) w.padding = { ...snap.padding };
}

export function useAnimPreview(ctx: AnimEditorCtx): PreviewApi {
  const editorStore = getEditorStore();
  const { engine } = editorStore;

  const targetNode = computed<Node | null>(() => {
    // 聚焦编辑模式锁定到目标子树根（组件所在节点）；否则跟随场景选中
    const id = animEditMode.active ? animEditMode.rootId : editorStore.state.selectedId;
    return id ? (engine.graph.get(id) ?? null) : null;
  });

  const targetObj = computed<THREE.Object3D | null>(() => {
    const n = targetNode.value;
    return n ? (engine.synchronizer.getObjectMap().get(n.id) ?? null) : null;
  });

  /** 按点路径写属性值（"color.r" → target.color.r） */
  function setPath(target: unknown, path: string, v: number): void {
    const segs = path.split(".");
    let cur: any = target;
    for (let i = 0; i < segs.length - 1; i++) {
      cur = cur ? cur[segs[i]] : undefined;
      if (cur == null) return;
    }
    if (cur != null) cur[segs[segs.length - 1]] = v;
  }

  /**
   * UI 通道（ui.*）→ 节点数据字段直写（真属性：anchoredPosition/size 等，
   * 与播放器 ui.updateSettings 同一收敛规则），返回是否有写入；
   * 调用方在全部通道应用后整卡刷新一次（锚点标注递增画布布局版本，
   * 下一帧布局解析生效；几何/文本贴图按签名缓存，值不变不重建）。
   */
  function applyUiChannels(node: Node, values: Map<AnimProp, number>): boolean {
    const w = uiViewOf(node);
    if (!w) return false;
    let touched = false;
    for (const [prop, v] of values) {
      if (!prop.startsWith("ui.")) continue;
      const key = prop.slice(3);
      switch (key) {
        case "anchoredPosition.x":
          w.anchoredPosition = { x: v, y: w.anchoredPosition.y };
          touched = true;
          break;
        case "anchoredPosition.y":
          w.anchoredPosition = { x: w.anchoredPosition.x, y: v };
          touched = true;
          break;
        case "size.x":
          w.size = { x: Math.max(0.01, v), y: w.size.y };
          touched = true;
          break;
        case "size.y":
          w.size = { x: w.size.x, y: Math.max(0.01, v) };
          touched = true;
          break;
        case "sortOrder":
          w.sortOrder = Math.round(Math.min(999, Math.max(-999, v)));
          touched = true;
          break;
        case "fontSize":
          if (typeof w.fontSize === "number") {
            w.fontSize = Math.round(Math.min(512, Math.max(4, v)));
            touched = true;
          }
          break;
        case "spacing.x":
          if (w.spacing) {
            w.spacing = { x: v, y: w.spacing.y };
            touched = true;
          }
          break;
        case "spacing.y":
          if (w.spacing) {
            w.spacing = { x: w.spacing.x, y: v };
            touched = true;
          }
          break;
        case "padding.left":
        case "padding.right":
        case "padding.top":
        case "padding.bottom":
          if (w.padding) {
            const part = key.split(".")[1] as "left" | "right" | "top" | "bottom";
            w.padding = { ...w.padding, [part]: v };
            touched = true;
          }
          break;
      }
    }
    return touched;
  }

  /** 通道分组应用（与播放器 animclip.mjs 的编译应用镜像） */
  function applyChannels(node: Node, obj: THREE.Object3D, values: Map<AnimProp, number>): void {
    let uiTouched = false;
    for (const [prop, v] of values) {
      const i = prop.indexOf(".");
      if (i < 0) continue;
      const group = prop.slice(0, i);
      const path = prop.slice(i + 1);
      if (group === "position" || group === "rotation" || group === "scale") {
        const axis = path as "x" | "y" | "z";
        if (group === "position") obj.position[axis] = v;
        else if (group === "rotation") obj.rotation[axis] = v * D2R;
        else obj.scale[axis] = Math.max(0.001, v);
      } else if (group === "material") {
        const anyObj = obj as unknown as { material?: unknown };
        const m = Array.isArray(anyObj.material) ? anyObj.material[0] : anyObj.material;
        setPath(m, path, v);
      } else if (group === "light") {
        let light: THREE.Light | null = null;
        obj.traverse((o) => {
          if (!light && (o as THREE.Light).isLight) light = o as THREE.Light;
        });
        // 聚光角度：通道值为度（与节点/检查器一致），three 灯光为弧度
        setPath(light, path, path === "angle" ? v * D2R : v);
      } else if (group === "camera") {
        // 相机投影参数（fov/near/far）：编辑器视口不经场景相机渲染（节点对象是
        // 图标 Group，无可写投影参数），此组仅播放器侧生效；曲线/K 帧不受影响
      } else if (group === "ui") {
        // UI 节点数据字段：循环后按整张值表统一攒写 + 一次刷新
        uiTouched = true;
      }
    }
    if (uiTouched && applyUiChannels(node, values)) engine.synchronizer.refreshUINode(node);
  }

  let appliedNodeId: string | null = null;
  let savedPose: { p: THREE.Vector3; r: THREE.Euler; s: THREE.Vector3 } | null = null;
  let savedUi: UiSnapshot | null = null;

  function beginApply(obj: THREE.Object3D, node: Node): void {
    if (appliedNodeId !== node.id) {
      restorePreview();
      appliedNodeId = node.id;
      savedPose = { p: obj.position.clone(), r: obj.rotation.clone(), s: obj.scale.clone() };
      savedUi = uiSnapshotOf(node);
    }
  }

  function restorePreview(): void {
    const obj = appliedNodeId ? engine.synchronizer.getObjectMap().get(appliedNodeId) : null;
    if (obj && savedPose) {
      obj.position.copy(savedPose.p);
      obj.rotation.copy(savedPose.r);
      obj.scale.copy(savedPose.s);
    }
    if (appliedNodeId && savedUi) {
      // 还原动画前需要拿到节点实例（对象表仍在，节点可能已切走）
      const node = engine.graph.get(appliedNodeId) ?? null;
      if (node) {
        restoreUiSnapshot(node, savedUi);
        engine.synchronizer.refreshUINode(node);
      }
    }
    appliedNodeId = null;
    savedPose = null;
    savedUi = null;
  }

  function previewAt(t: number): void {
    const d = ctx.clip.doc.value;
    const obj = targetObj.value;
    const node = targetNode.value;
    if (!d || !obj || !node) return;
    beginApply(obj, node);
    applyChannels(node, obj, evaluateClip(d, t));
  }

  return { targetNode, targetObj, applyChannels, previewAt, restorePreview };
}
