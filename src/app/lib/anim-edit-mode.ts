// 动画「聚焦编辑模式」：从动画剪辑组件的「在动画编辑器中打开」进入后，
// 锁定场景选中范围到该组件所在节点及其子树（其它节点不可选中、视口内压暗）；
// 动画面板出现「退出编辑」按钮。
// - active/rootId 由 anim-editor.ts 的 openInAnimEditor 设置、exitAnimEditMode 清除；
// - 该模块独立于 docks / anim-editor（它们各自 import 本模块，无环依赖）；
// - 引擎侧只暴露 setSelectionFilter 谓词，子树判定由本模块（app 层）闭包提供。
// 视口压暗为材质层实现：非目标子树对象的材质替换为变暗克隆（原图保存、退出
// 还原），目标子树对象完全不动、保持原色——不做 2D 蒙版层。
import { reactive } from "vue";
import * as THREE from "three";
import type { Node } from "../../framework/prototype/Node";
import { getEditorStore } from "../stores/editor";

/** 非目标对象的压暗系数（材质 color 乘子；配合纹理同样生效） */
const DIM_FACTOR = 0.35;

export const animEditMode = reactive({
  /** 聚焦编辑模式是否生效 */
  active: false,
  /** 目标根节点 id（组件所在节点；其全部子孙同属可编辑范围） */
  rootId: "",
});

/** 收集 rootId 子树全部节点 id（含根；层级面板高亮同用） */
export function collectSubtreeIds(
  graph: { childrenOf(id: string): Node[] },
  rootId: string,
): string[] {
  const acc: string[] = [];
  const walk = (id: string): void => {
    acc.push(id);
    for (const c of graph.childrenOf(id)) walk(c.id);
  };
  walk(rootId);
  return acc;
}

/** 被压暗对象的原始材质（退出编辑时还原） */
const dimmed = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
let unsubGraph: (() => void) | null = null;
let unsubMaterial: (() => void) | null = null;
let unsubModel: (() => void) | null = null;

/** 材质变暗（克隆后改 color；color 与贴图相乘，贴图对象同样变暗） */
function dimMaterial(m: THREE.Material): THREE.Material {
  const clone = m.clone();
  const c = (clone as THREE.MeshStandardMaterial).color;
  if (c) c.multiplyScalar(DIM_FACTOR);
  const e = (clone as THREE.MeshStandardMaterial).emissive;
  if (e) e.multiplyScalar(DIM_FACTOR);
  return clone;
}

/** 把「目标子树之外」的场景对象材质替换为变暗克隆（幂等：已压暗的跳过） */
function applyViewportDim(): void {
  const { engine } = getEditorStore();
  const keep = new Set(collectSubtreeIds(engine.graph, animEditMode.rootId));
  for (const [id, obj] of engine.synchronizer.getObjectMap()) {
    if (keep.has(id) || dimmed.has(obj as THREE.Mesh)) continue;
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) continue;
    dimmed.set(mesh, mat);
    mesh.material = Array.isArray(mat) ? mat.map(dimMaterial) : dimMaterial(mat);
  }
}

/** 还原全部被压暗对象的原始材质 */
function restoreViewportDim(): void {
  for (const [mesh, mat] of dimmed) mesh.material = mat;
  dimmed.clear();
}

/** 编辑期间场景/材质变化后重新压暗（先还原再套用，拾取新增对象与材质更新） */
function refreshViewportDim(): void {
  if (!animEditMode.active) return;
  restoreViewportDim();
  applyViewportDim();
}

/** 进入聚焦编辑：限定选中范围到 rootId 子树，选中根节点并压暗其余对象 */
export function enterAnimEditMode(rootId: string): void {
  const { engine } = getEditorStore();
  animEditMode.rootId = rootId;
  animEditMode.active = true;
  // 选中范围谓词：仅允许 rootId 与其子孙（null 也被拒绝 → 空点不清除选中，
  // 保证再编辑时 gizmo/属性面板始终聚焦目标）
  engine.setSelectionFilter(
    (id) => id != null && (id === rootId || engine.graph.isDescendant(rootId, id)),
  );
  engine.select(rootId);
  applyViewportDim();
  // 编辑期间图/材质变化 → 重算压暗（新入图对象变暗、材质编辑实时反映）
  unsubGraph = engine.events.on("graph:changed", refreshViewportDim);
  unsubMaterial = engine.events.on("material:changed", refreshViewportDim);
  unsubModel = engine.events.on("model:changed", refreshViewportDim);
}

/** 退出聚焦编辑：还原材质、恢复全场景可选中 */
export function exitAnimEditMode(): void {
  if (!animEditMode.active) return;
  animEditMode.active = false;
  animEditMode.rootId = "";
  unsubGraph?.();
  unsubMaterial?.();
  unsubModel?.();
  unsubGraph = unsubMaterial = unsubModel = null;
  restoreViewportDim();
  getEditorStore().engine.setSelectionFilter(null);
}
