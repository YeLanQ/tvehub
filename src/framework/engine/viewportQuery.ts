// ---------------------------------------------------------------------------
// 视口查询与可选性判定（engine/ 内部接线面：挂载/事件/节点操作共用）。
// - 屏幕坐标 → 场景落点（资产拖放落位）；
// - 相机快速聚焦（层级双击/快捷键 F）；
// - NDC 换算与活动相机宽高比（布局导航缩放锚点用）；
// - 视口点选可用性与 UI 画布子树判定（点选/换父补偿/Gizmo 托管共用）。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import type { Node } from "../prototype/Node";
import type { Vec3 } from "../prototype/types";

/** DOM 事件坐标 → NDC（-1..1；画布尺寸无效返回 null） */
export function ndcFromEvent(engine: EditorEngine, e: { clientX: number; clientY: number }): { x: number; y: number } | null {
  const rect = engine.renderer.domElement.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
  };
}

/** 活动相机宽高比（缩放锚点换算用；正交按取景框，透视按 projection.aspect） */
export function activeCameraAspect(engine: EditorEngine): number {
  const cam = engine.renderer.getActiveCamera();
  if (!cam) return 1;
  const oc = cam as THREE.OrthographicCamera;
  if (oc.isOrthographicCamera === true) {
    return Math.abs(oc.top - oc.bottom) > 1e-6 ? Math.abs(oc.right - oc.left) / Math.abs(oc.top - oc.bottom) : 1;
  }
  const pc = cam as THREE.PerspectiveCamera;
  return pc.aspect > 0 ? pc.aspect : 1;
}

/**
 * 视口屏幕坐标（client 像素）→ 场景落点：优先取光标下场景几何的最近命中点
 * （沿父链不可见的对象跳过，与点选同规则），未命中任何几何时回退视线与
 * 地面（y=0 平面，与编辑器网格同高）的交点。资产拖放落位等使用。
 * 引擎已销毁或无交点（视线平行朝上）返回 null。
 */
export function screenToWorldPoint(engine: EditorEngine, clientX: number, clientY: number): Vec3 | null {
  if (engine.isDisposed()) return null;
  const rect = engine.renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  engine.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  engine.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  engine.raycaster.setFromCamera(engine.mouse, engine.renderer.camera);
  const objectMap = engine.synchronizer.getObjectMap();
  const intersects = engine.raycaster.intersectObjects(Array.from(objectMap.values()), true);
  // 可见性链过滤：three 的 Raycaster 不看 visible，隐藏对象不该吸附落点
  const hit = intersects.find((i) => {
    let o: THREE.Object3D | null = i.object;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  });
  if (hit) return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
  const out = new THREE.Vector3();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  return engine.raycaster.ray.intersectPlane(ground, out) ? { x: out.x, y: out.y, z: out.z } : null;
}

/**
 * 视口相机快速聚焦到节点（层级双击 / 快捷键 F）：
 * 取节点世界包围球，相机沿当前视线方向退到完整取景距离，轨道目标对准包围球
 * 中心。无几何子级的空节点退化为以节点世界位置为心、1 单位半径取景。
 * 预览渲染（用场景相机节点取景）与未知节点不介入。返回是否成功。
 */
export function focusOnNode(engine: EditorEngine, id: string): boolean {
  const obj = engine.synchronizer.getObjectMap().get(id);
  if (!obj || engine.previewMode || engine.isDisposed()) return false;
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.isEmpty()
    ? new THREE.Sphere(obj.getWorldPosition(new THREE.Vector3()), 1)
    : box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);
  const controls = engine.renderer.orbitControls;
  const camera = engine.renderer.camera;
  // 沿当前视线方向后退（目标与相机重合等退化情形取默认斜视方向）
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-8) dir.set(0.6, 0.7, 1);
  dir.normalize();
  // 完整取景距离：包围球对垂直视场角的投影（留 10% 余量；并保底不小于半径×1.5）
  const dist = Math.max((radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.1, radius * 1.5);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  controls.update();
  return true;
}

/**
 * 视口点选可用性：节点自身与所有祖先都必须「可见且激活」——与渲染的可见性同规则
 * （见 Node.isEffectivelyVisibleIn 与 picking.ts 的说明）。
 */
export function isSelectableInViewport(engine: EditorEngine, nodeId: string): boolean {
  const node = engine.graph.get(nodeId);
  if (!node) return false;
  const inCanvas = isInUICanvasSubtree(engine, node);
  // 布局视图只显示 Canvas 子树：非 UI 子树的节点不可点选（渲染隐藏，点选同规则）
  if (engine.uiViewVisible) {
    if (!inCanvas) return false;
  } else if (inCanvas) {
    // 场景视图 UI 整体隐藏（对象级 visible 由 UISystem 接管，节点数据仍 visible，
    // 射线也不检查可见性）：UI 节点不可点选，且不拦截其身后 3D 对象的点击
    return false;
  }
  return node.isEffectivelyVisibleIn((id) => engine.graph.get(id));
}

/** 节点（含自身）是否在某个 UI 画布子树内 */
export function isInUICanvasSubtree(engine: EditorEngine, node: Node): boolean {
  let cur: Node | undefined = node;
  while (cur) {
    if (cur.typeKey === "uiCanvasNode") return true;
    cur = cur.parentId ? engine.graph.get(cur.parentId) : undefined;
  }
  return false;
}

/**
 * 节点位置是否由 UI 锚点/布局解析托管（画布子树内的 Widget/布局容器；
 * 画布外的 Widget 仍是普通 3D 变换）。按 three 对象父链判断。
 */
export function isUIPositionManaged(engine: EditorEngine, id: string): boolean {
  const obj = engine.synchronizer.getObjectMap().get(id);
  if (!obj) return false;
  return isInCanvasSubtree(obj.parent);
}

/** obj 是否处于画布子树内（自身或父链上有 uiCanvasNode） */
export function isInCanvasSubtree(obj: THREE.Object3D | null): boolean {
  let cur = obj;
  while (cur) {
    if (cur.userData?.nodeKind === "uiCanvasNode") return true;
    cur = cur.parent;
  }
  return false;
}
