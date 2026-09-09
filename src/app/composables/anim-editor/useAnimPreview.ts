// ---------------------------------------------------------------------------
// 目标节点（场景选中）与预览应用：把采样值直接写到选中节点的三维对象，
// 不写节点数据（非破坏），换目标/停止时还原姿势。通道组分应用与播放器
// animclip.mjs 的 applyValues 镜像。
// ---------------------------------------------------------------------------
import { computed } from "vue";
import * as THREE from "three";
import type { Node } from "../../../framework/prototype/Node";
import { evaluateClip, type AnimProp } from "../../../framework/animation/clip";
import { getEditorStore } from "../../stores/editor";
import { animEditMode } from "../../lib/anim-edit-mode";
import type { AnimEditorCtx, PreviewApi } from "./ctx";

const D2R = Math.PI / 180;

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

  /** 通道分组应用（与播放器 animclip.mjs 的 applyValues 镜像） */
  function applyChannels(obj: THREE.Object3D, values: Map<AnimProp, number>): void {
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
        setPath(light, path, v);
      }
    }
  }

  let appliedNodeId: string | null = null;
  let savedPose: { p: THREE.Vector3; r: THREE.Euler; s: THREE.Vector3 } | null = null;

  function beginApply(obj: THREE.Object3D, node: Node): void {
    if (appliedNodeId !== node.id) {
      restorePreview();
      appliedNodeId = node.id;
      savedPose = { p: obj.position.clone(), r: obj.rotation.clone(), s: obj.scale.clone() };
    }
  }

  function restorePreview(): void {
    const obj = appliedNodeId ? engine.synchronizer.getObjectMap().get(appliedNodeId) : null;
    if (obj && savedPose) {
      obj.position.copy(savedPose.p);
      obj.rotation.copy(savedPose.r);
      obj.scale.copy(savedPose.s);
    }
    appliedNodeId = null;
    savedPose = null;
  }

  function previewAt(t: number): void {
    const d = ctx.clip.doc.value;
    const obj = targetObj.value;
    const node = targetNode.value;
    if (!d || !obj || !node) return;
    beginApply(obj, node);
    applyChannels(obj, evaluateClip(d, t));
  }

  return { targetNode, targetObj, applyChannels, previewAt, restorePreview };
}