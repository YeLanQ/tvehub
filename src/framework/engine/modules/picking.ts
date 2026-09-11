// ---------------------------------------------------------------------------
// 视口点选解析（纯逻辑，不依赖 DOM/渲染器，便于 headless 测试）。
//
// three 的 Raycaster **只看 layers**，不看 `visible`，也不会因为父级隐藏而跳过子级
// （已核对 three 源码：intersectObject 只做 object.layers.test 后调 object.raycast），
// 所以"看不见的对象点不到"这条规则必须由这里实现：
// - 命中对象沿父链归因到**最近的映射节点**（网格的轮廓体/模型实例子对象都归其节点）；
// - 跳过场景根节点（只能从层级面板选中）；
// - 跳过不可选节点（自身或任一祖先「不可见 / 未激活」——与渲染的可见性同规则），
//   继续看它后面的下一个命中（隐藏对象"穿透"，能选中被它挡住的可见对象）。
// ---------------------------------------------------------------------------

import type * as THREE from "three";

/** 命中对象 → 最近的映射节点 id（沿父链向上找；未映射返回 null） */
export function resolveMappedNodeId(
  hit: THREE.Object3D,
  objectMap: Map<string, THREE.Object3D>,
): string | null {
  let obj: THREE.Object3D | null = hit;
  while (obj) {
    const nodeId = (obj.userData as { nodeId?: string }).nodeId ?? null;
    if (nodeId && objectMap.has(nodeId)) return nodeId;
    obj = obj.parent;
  }
  return null;
}

/** 点选过滤选项 */
export interface PickOptions {
  /** 节点 id → three 对象（同步器的对象表） */
  objectMap: Map<string, THREE.Object3D>;
  /** 场景根节点 id（不允许从视口选中；null = 无根） */
  rootId: string | null;
  /** 节点在视口中是否可选（自身与祖先都可见且激活；见 Node.isNodeEffectivelyVisible） */
  isSelectable: (nodeId: string) => boolean;
}

/**
 * 命中列表 → 第一个可选中节点 id（全部不可选返回 null）。
 * 调用方据此决定"选中该节点"或"视为点击空白（清空选择）"。
 */
export function pickSelectableNodeId(
  hits: readonly { object: THREE.Object3D }[],
  opts: PickOptions,
): string | null {
  for (const hit of hits) {
    const nodeId = resolveMappedNodeId(hit.object, opts.objectMap);
    if (!nodeId || nodeId === opts.rootId) continue;
    if (!opts.isSelectable(nodeId)) continue;
    return nodeId;
  }
  return null;
}
