// ---------------------------------------------------------------------------
// Prefab（预制体）序列化/实例化（framework 层纯函数）：
// - .prefab 资产 = 单个根节点的嵌套 JSON 文档（与 .scene 的 root 同形状：
//   节点字段 + children 嵌套）；层级事实源是嵌套 children（childIds 忽略），
//   与后端 Graph::from_root_doc 的解析规则一致；
// - 保存（serializePrefabTree）：内存节点子树 → 嵌套文档；剥掉组件实例 id
//   （实例化时重生成，避免克隆共享 id）与 prefab 引用（资产不含自引用）；
// - 实例化（instantiatePrefabTree）：嵌套文档 → 新节点树；节点 id 与组件 id
//   全部重生成，父子链按嵌套 children 重建。prefab 源引用由调用方写在
//   实例根节点上（Node.prefab），本模块不处理。
// ---------------------------------------------------------------------------

import { nextId } from "../../platform_abstraction/id";
import type { Node } from "./Node";
import type { JsonRecord } from "./types";

export interface SerializePrefabOptions {
  /**
   * 资产形态（默认 true）：剥掉 prefab 自引用与组件实例 id（资产不携带实例数据，
   * 实例化时全部重生成）。提交实例文档到场景（scene_add_tree）时传 false——
   * 保留 prefab 来源引用（applyJSON 回灌不清空）与已重生成的组件 id（保持稳定）。
   */
  forAsset?: boolean;
}
/** 节点子树 → 嵌套 prefab 文档（childrenOf 提供子节点解析，如 graph.childrenOf） */
export function serializePrefabTree(
  root: Node,
  childrenOf: (id: string) => Node[],
  opts: SerializePrefabOptions = {},
): JsonRecord {
  const forAsset = opts.forAsset !== false;
  const build = (node: Node): JsonRecord => {
    const json = { ...(node.toJSON() as JsonRecord) };
    if (forAsset) {
      // 资产不含实例引用与组件实例 id（实例化时重生成，避免共享 id）
      delete json.prefab;
      const components = json.components;
      if (Array.isArray(components)) {
        json.components = components.map((c) => {
          const rec = { ...(c as JsonRecord) };
          delete rec.id;
          return rec;
        });
      }
    }
    const children = childrenOf(node.id).map(build);
    if (children.length) json.children = children;
    return json;
  };
  return build(root);
}

export interface PrefabFactory {
  /** 原型注册表构建（类型派发：node/meshNode/pointLightNode… → 具体节点类） */
  fromJSON(json: JsonRecord | Record<string, unknown>): Node;
}

/**
 * 嵌套 prefab 文档 → 新节点树（节点 id / 组件 id 全部重生成；
 * 返回文档序（先父后子）的全量节点列表 + 子树根。层级以嵌套 children 重建。
 */
export function instantiatePrefabTree(
  doc: JsonRecord,
  factory: PrefabFactory,
): { root: Node; nodes: Node[] } {
  const nodes: Node[] = [];
  const build = (json: JsonRecord, parentId: string | null): Node => {
    const node = factory.fromJSON(json);
    // 全新实例：节点 id / 组件 id 重生成（fromJSON 保留了文档里的组件 id）
    node.id = nextId(node.typeKey);
    node.parentId = parentId;
    node.childIds = [];
    if (node.components.length) {
      node.components = node.components.map((c) => ({ ...c, id: nextId("comp") }));
    }
    nodes.push(node);
    const children = Array.isArray(json.children) ? (json.children as JsonRecord[]) : [];
    for (const childJson of children) {
      const child = build(childJson, node.id);
      node.childIds.push(child.id);
    }
    return node;
  };
  const root = build(doc, null);
  return { root, nodes };
}
