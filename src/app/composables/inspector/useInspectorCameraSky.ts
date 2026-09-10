// ---------------------------------------------------------------------------
// 相机与天空盒域：相机卡（CameraSection）的类型/参数/清屏设置编辑，天空盒卡
// （SkyboxSection）的材质引用切换与「复制为项目资产」。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit / projectStore /
// assetsStore），域之间互不引用。编辑走 commit → mutateNode（整节点快照进撤销
// 历史），label 决定历史文案；相机参数经 framework/camera 的收敛函数处理。
//
// 背景：从 InspectorPanel.vue 抽出的相机/天空盒部分，逐字搬运（含提前返回
// 条件、clamp 与 hex 截断）。
// ---------------------------------------------------------------------------
import { CameraNode, SkyboxNode } from "../../../framework/prototype/derived/Primitives";
import { clampCameraParam, cameraParamDef, parseCameraClearFlags, type CameraParamKey } from "../../../framework/camera";
import { duplicateMaterialToProject } from "../../lib/materials";
import { logStore } from "../../stores/log";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorCameraSkyApi {
  onCameraEdit: (field: CameraParamKey, value: number) => void;
  onCameraChangeType: (type: string) => void;
  onCameraClearFlags: (flags: string) => void;
  onCameraClearColor: (color: number) => void;
  onSetSkyMaterial: (rel: string) => void;
  onSkyMaterialCopyToProject: () => Promise<void>;
}

export function useInspectorCameraSky(ctx: InspectorNodeApi): InspectorCameraSkyApi {
  const { node, projectStore, assetsStore, commit } = ctx;

  function onCameraEdit(field: CameraParamKey, value: number): void {
    const n = node.value;
    if (!n || !(n instanceof CameraNode)) return;
    const v = clampCameraParam(field, value);
    commit((target) => {
      (target as CameraNode)[field] = v;
    }, `Set ${cameraParamDef(field).label}`);
  }

  /** 切换相机类型（透视/正交）：视锥辅助线与预览渲染按新类型重建 */
  function onCameraChangeType(type: string): void {
    const n = node.value;
    if (!n || !(n instanceof CameraNode) || !type) return;
    if (type !== "perspective" && type !== "orthographic") return;
    commit((target) => {
      (target as CameraNode).cameraType = type;
    }, "Set Camera Type");
  }

  /** 切换清除标志（天空盒/纯色/仅深度/仅颜色）：预览渲染的清屏方式随之变化 */
  function onCameraClearFlags(flags: string): void {
    const n = node.value;
    if (!n || !(n instanceof CameraNode)) return;
    const v = parseCameraClearFlags(flags);
    if (v === n.clearFlags) return;
    commit((target) => {
      (target as CameraNode).clearFlags = v;
    }, "Set Clear Flags");
  }

  /** 修改纯色清屏色（清除标志=纯色时的背景色） */
  function onCameraClearColor(color: number): void {
    const n = node.value;
    if (!n || !(n instanceof CameraNode)) return;
    const v = color & 0xffffff;
    if (v === n.clearColor) return;
    commit((target) => {
      (target as CameraNode).clearColor = v;
    }, "Set Clear Color");
  }

  /** 切换天空盒材质引用（内置或项目资产；类型不变，仅切换引用的 .mat） */
  function onSetSkyMaterial(rel: string): void {
    const n = node.value;
    if (!n || !(n instanceof SkyboxNode) || !rel || rel === n.material) return;
    commit((m) => {
      (m as SkyboxNode).material = rel;
    }, "Set Sky Material");
  }

  /** 把当前天空材质（内置只读）复制为项目资产并绑定到本节点 */
  async function onSkyMaterialCopyToProject(): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof SkyboxNode)) return;
    const root = projectStore.currentPath;
    if (!root) return;
    const dup = await duplicateMaterialToProject(root, n.material, n.name);
    if (!dup) {
      logStore.log("error", "复制天空盒材质资产失败", "engine");
      return;
    }
    commit((m) => {
      (m as SkyboxNode).material = dup;
    }, "复制天空材质到项目");
    void assetsStore.load(root);
  }

  return {
    onCameraEdit,
    onCameraChangeType,
    onCameraClearFlags,
    onCameraClearColor,
    onSetSkyMaterial,
    onSkyMaterialCopyToProject,
  };
}
