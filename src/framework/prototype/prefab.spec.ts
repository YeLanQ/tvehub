import { describe, expect, it } from "vitest";
import { MeshNode } from "./derived/Primitives";
import { Node } from "./Node";
import { createDefaultRegistry } from "./PrototypeRegistry";
import { instantiatePrefabTree, serializePrefabTree } from "./prefab";
import type { JsonRecord } from "./types";

// 预制体序列化/实例化：资产形态剥离实例数据、实例化全量重生成 id、层级重建。

const registry = createDefaultRegistry();
/** PrefabFactory 适配器：注册表 createFromJSON → factory.fromJSON */
const prefabFactory = { fromJSON: (json: JsonRecord) => registry.createFromJSON(json) };

function buildTree(): { root: Node; mid: Node; leaf: Node; byId: Map<string, Node> } {
  const root = new Node({ name: "根" });
  const mid = new MeshNode({ name: "中" });
  const leaf = new Node({ name: "叶" });
  mid.parentId = root.id;
  leaf.parentId = mid.id;
  root.addChildId(mid.id);
  mid.addChildId(leaf.id);
  return { root, mid, leaf, byId: new Map([[root.id, root], [mid.id, mid], [leaf.id, leaf]]) };
}

describe("serializePrefabTree", () => {
  it("按 childrenOf 嵌套展开子树；叶子层无 children 键", () => {
    const { root, byId } = buildTree();
    const doc = serializePrefabTree(root, (id) => byId.get(id)?.childIds.map((c) => byId.get(c)!) ?? []);
    expect(doc.name).toBe("根");
    const children = doc.children as JsonRecord[];
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe("中");
    expect(((children[0].children as JsonRecord[])[0]).name).toBe("叶");
    expect(((children[0].children as JsonRecord[])[0])).not.toHaveProperty("children");
  });

  it("资产形态（默认）：剥掉根的 prefab 自引用与全部组件实例 id", () => {
    const { root, byId } = buildTree();
    root.prefab = "self.prefab";
    root.components = [
      { id: "comp_old", type: "script", script: "a.ts", enabled: true, executionOrder: 2, props: {} },
    ];
    const doc = serializePrefabTree(root, (id) => byId.get(id)?.childIds.map((c) => byId.get(c)!) ?? []);
    expect(doc).not.toHaveProperty("prefab");
    expect((doc.components as JsonRecord[])[0]).not.toHaveProperty("id");
  });

  it("提交实例形态（forAsset: false）：prefab 引用与组件 id 保留", () => {
    const { root } = buildTree();
    root.prefab = "p.prefab";
    root.components = [
      { id: "comp_keep", type: "script", script: "a.ts", enabled: true, executionOrder: 2, props: {} },
    ];
    const doc = serializePrefabTree(root, () => [], { forAsset: false });
    expect(doc.prefab).toBe("p.prefab");
    expect((doc.components as JsonRecord[])[0].id).toBe("comp_keep");
  });
});

describe("instantiatePrefabTree", () => {
  const { root, byId } = buildTree();
  const childrenOf = (id: string): Node[] => byId.get(id)?.childIds.map((c) => byId.get(c)!) ?? [];
  const doc = serializePrefabTree(root, childrenOf);
  const { root: inst, nodes } = instantiatePrefabTree(doc, prefabFactory);

  it("节点 id 全部重生成且文档序（先父后子）返回全量列表", () => {
    expect(inst.id).not.toBe(root.id);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toBe(inst);
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("父子链按嵌套 children 重建（parentId/childIds 一致）", () => {
    const mid = nodes[1];
    const leaf = nodes[2];
    expect(mid.parentId).toBe(inst.id);
    expect(inst.childIds).toEqual([mid.id]);
    expect(leaf.parentId).toBe(mid.id);
    expect(mid.childIds).toEqual([leaf.id]);
  });

  it("组件 id 重生成、数据随行", () => {
    const src = new Node();
    src.components = [
      { id: "comp_orig", type: "script", script: "src/x.ts", enabled: true, executionOrder: 0, props: { a: 1 } },
    ];
    const d = serializePrefabTree(src, () => []);
    const { root: n } = instantiatePrefabTree(d, prefabFactory);
    expect(n.components).toHaveLength(1);
    expect(n.components[0].id).not.toBe("comp_orig");
    expect(n.components[0].type).toBe("script");
  });

  it("往返稳定性：实例化结果再序列化 → 再实例化，结构等价", () => {
    const doc2 = serializePrefabTree(inst, childrenOf2(inst, nodes)); // eslint-disable-line
    const { nodes: nodes2 } = instantiatePrefabTree(doc2, prefabFactory);
    expect(nodes2.map((n) => n.name)).toEqual(nodes.map((n) => n.name));
  });
});

/** 由实例节点列表构造 childrenOf（按 parentId 分组） */
function childrenOf2(_root: Node, all: Node[]): (id: string) => Node[] {
  return (id: string): Node[] => all.filter((n) => n.parentId === id);
}
