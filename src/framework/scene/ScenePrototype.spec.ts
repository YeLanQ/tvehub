import { describe, expect, it } from "vitest";
import { MeshNode } from "../prototype/derived/Primitives";
import { Node } from "../prototype/Node";
import { vec3 } from "../prototype/types";
import {
  createDefaultMetadata,
  createDefaultSettings,
  ScenePrototype,
} from "./ScenePrototype";

// 场景原型：元数据/设置默认值、节点树增删查、遍历、克隆与序列化往返。

function buildScene(): { scene: ScenePrototype; root: Node; child: Node; grand: Node } {
  const scene = new ScenePrototype();
  const root = new Node({ name: "根" });
  const child = new MeshNode({ name: "网格" });
  const grand = new Node({ name: "孙" });
  scene.addNode(root);
  scene.addNode(child, root.id);
  scene.addNode(grand, child.id);
  return { scene, root, child, grand };
}

describe("默认元数据与设置", () => {
  it("缺省元数据：名称/版本 1.0.0/时间戳/空标签", () => {
    const m = createDefaultMetadata();
    expect(m.name).toBe("Untitled Scene");
    expect(m.version).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(m.createdAt).toBe(m.modifiedAt);
    expect(m.tags).toEqual([]);
    expect(createDefaultMetadata("MyScene").name).toBe("MyScene");
  });

  it("缺省渲染设置：黑背景、0.3 环境光强度、白环境光颜色", () => {
    const s = createDefaultSettings();
    expect(s.rendering).toEqual({ backgroundColor: 0, ambientIntensity: 0.3, ambientColor: 0xffffff });
  });
});

describe("节点树增删查", () => {
  it("addNode 维护双向链（parentId / childIds / childrenIndex）；null 父 = 根", () => {
    const { scene, root, child } = buildScene();
    expect(scene.rootId).toBe(root.id);
    expect(child.parentId).toBe(root.id);
    expect(root.childIds).toEqual([child.id]);
    expect(scene.getChildren(root.id)).toEqual([child]);
    expect(scene.getNodeCount()).toBe(3);
    expect(scene.isEmpty()).toBe(false);
  });

  it("addNode 重复添加同一节点不产生重复兄弟项", () => {
    const scene = new ScenePrototype();
    const root = new Node();
    scene.addNode(root);
    scene.addNode(root, null); // 再以根身份添加
    expect(root.childIds).toEqual([]);
  });

  it("removeNode 递归移除子树并清理父级引用；移除根清空场景", () => {
    const { scene, root, child } = buildScene();
    expect(scene.removeNode("不存在")).toBe(false);
    expect(scene.removeNode(child.id)).toBe(true);
    expect(scene.findNode(child.id)).toBeUndefined();
    expect(root.childIds).toEqual([]);
    expect(scene.getNodeCount()).toBe(1);
    scene.removeNode(root.id);
    expect(scene.isEmpty()).toBe(true);
  });

  it("findNode / getChildren 对未知 id 返回空值", () => {
    const scene = new ScenePrototype();
    expect(scene.findNode("x")).toBeUndefined();
    expect(scene.getChildren("x")).toEqual([]);
  });
});

describe("traverse 深度优先遍历", () => {
  it("先父后子，覆盖全部节点", () => {
    const { scene } = buildScene();
    const order: string[] = [];
    scene.traverse((n) => order.push(n.name));
    expect(order).toEqual(["根", "网格", "孙"]);
  });

  it("空场景遍历无回调", () => {
    const seen: string[] = [];
    new ScenePrototype().traverse((n) => seen.push(n.id));
    expect(seen).toEqual([]);
  });
});

describe("序列化往返", () => {
  it("toJSON → fromJSON 保持元数据/设置/树结构", () => {
    const { scene } = buildScene();
    scene.settings.rendering.backgroundColor = 0x112233;
    scene.metadata.name = "往返";
    const back = ScenePrototype.fromJSON(scene.toJSON());
    expect(back.metadata.name).toBe("往返");
    expect(back.settings.rendering.backgroundColor).toBe(0x112233);
    expect(back.getNodeCount()).toBe(3);
    const order: string[] = [];
    back.traverse((n) => order.push(n.name));
    expect(order).toEqual(["根", "网格", "孙"]);
  });

  it("fromJSON 缺字段回默认（无 metadata/settings/root → 空场景）", () => {
    const s = ScenePrototype.fromJSON({});
    expect(s.isEmpty()).toBe(true);
    expect(s.metadata.name).toBe("Untitled Scene");
    expect(s.settings.rendering.ambientIntensity).toBe(0.3);
  });

  it("fromJSON 元数据逐字段回退（缺 version/时间戳/tags/custom/description）", () => {
    const s = ScenePrototype.fromJSON({ metadata: { name: "部分" } });
    expect(s.metadata.name).toBe("部分");
    expect(s.metadata.version).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(typeof s.metadata.createdAt).toBe("string");
    expect(s.metadata.tags).toEqual([]);
    expect(s.metadata.description).toBeUndefined();
    expect(s.metadata.custom).toEqual({});
  });

  it("fromJSON 设置缺 rendering 键不影响默认；嵌套 children 里的坏条目被跳过", () => {
    const s = ScenePrototype.fromJSON({
      settings: {},
      root: { type: "node", id: "r1", name: "R", children: [
        null,
        42,
        "junk",
        { type: "node", id: "c1", name: "C", children: "不是数组" },
      ] },
    });
    expect(s.settings.rendering.backgroundColor).toBe(0);
    expect(s.getNodeCount()).toBe(2); // 根 + 唯一合法子节点
    expect(s.getChildren("r1").map((n) => n.name)).toEqual(["C"]);
  });

  it("序列化时缺失的子节点（悬空 childId）不产出 children 条目", () => {
    const scene = new ScenePrototype();
    const root = new Node({ name: "根" });
    scene.addNode(root);
    root.childIds.push("ghost"); // 悬空引用
    const json = scene.toJSON();
    expect(json.root).not.toHaveProperty("children");
  });

  it("addNode 指向不存在父节点：登记节点但父链悬空不崩溃", () => {
    const scene = new ScenePrototype();
    const orphan = new Node({ name: "孤儿" });
    scene.addNode(orphan, "ghost-parent");
    expect(scene.findNode(orphan.id)).toBe(orphan);
    expect(scene.rootId).toBeNull(); // 有 parentId 的不成为根
    expect(scene.getChildren("ghost-parent").map((n) => n.name)).toEqual(["孤儿"]);
  });

  it("removeNode / traverse / clone 对悬空引用的健壮性", () => {
    const scene = new ScenePrototype();
    const root = new Node({ name: "根" });
    scene.addNode(root);
    root.childIds.push("ghost"); // 悬空子引用
    const seen: string[] = [];
    scene.traverse((n) => seen.push(n.name)); // ghost 被跳过
    expect(seen).toEqual(["根"]);
    expect(scene.removeNode("ghost")).toBe(false); // 悬空 id 删除无副作用
    const copy = scene.clone();
    expect(copy.getNodeCount()).toBe(1);
    const empty = new ScenePrototype();
    empty.rootId = "ghost"; // rootId 悬空
    expect(empty.clone().getNodeCount()).toBe(0);
    expect(empty.toJSON().root).toBeUndefined();
    const seenNone: string[] = [];
    empty.traverse((n) => seenNone.push(n.name));
    expect(seenNone).toEqual([]);
  });
});

describe("clone 与 clear", () => {
  it("clone 深拷贝节点树（新 id 集合，原场景不受修改影响）", () => {
    const { scene } = buildScene();
    const copy = scene.clone();
    expect(copy.getNodeCount()).toBe(3);
    const names: string[] = [];
    copy.traverse((n) => names.push(n.name));
    expect(names).toEqual(["根", "网格", "孙"]);
    const origIds = new Set([...scene.nodes.keys()]);
    copy.traverse((n) => expect(origIds.has(n.id)).toBe(false));
    const copyChild = copy.getChildren(copy.rootId!)[0];
    copyChild.transform.position = vec3(9, 9, 9);
    const sceneChild = scene.getChildren(scene.rootId!)[0];
    expect(sceneChild.transform.position.x).toBe(0);
  });

  it("clear 清空节点并重置元数据", () => {
    const { scene } = buildScene();
    scene.clear();
    expect(scene.isEmpty()).toBe(true);
    expect(scene.getNodeCount()).toBe(0);
    expect(scene.metadata.name).toBe("Untitled Scene");
  });
});
