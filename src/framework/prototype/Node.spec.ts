import { describe, expect, it } from "vitest";
import { Node } from "./Node";
import { Transform } from "./Transform";
import { vec3 } from "./types";

// 节点基元：默认值、层级链、属性槽、有效可见性与序列化字节兼容约定。

describe("Node 构造与默认值", () => {
  it("缺省构造：自动 id、名称 Node、根节点、可见且激活", () => {
    const n = new Node();
    expect(n.id).toMatch(/^node_/);
    expect(n.name).toBe("Node");
    expect(n.parentId).toBeNull();
    expect(n.isRoot).toBe(true);
    expect(n.active).toBe(true);
    expect(n.visible).toBe(true);
    expect(n.tag).toBe("");
    expect(n.layer).toBe(0);
    expect(n.prefab).toBe("");
    expect(n.childIds).toEqual([]);
  });

  it("init 覆盖：名称/父级/标签/层级/属性/变换均被克隆（防外部串扰）", () => {
    const transform = new Transform({ position: vec3(1, 2, 3) });
    const n = new Node({
      name: "Box",
      parentId: "p1",
      tag: "player",
      layer: 5,
      properties: { hp: 10 },
      transform,
    });
    transform.position.x = 100;
    expect(n.name).toBe("Box");
    expect(n.parentId).toBe("p1");
    expect(n.tag).toBe("player");
    expect(n.layer).toBe(5);
    expect(n.transform.position.x).toBe(1);
    expect(n.properties).toEqual({ hp: 10 });
  });

  it("层级索引收敛：超界（负数/大于 31）落回 0", () => {
    expect(new Node({ layer: -3 }).layer).toBe(0);
    expect(new Node({ layer: 99 }).layer).toBe(0);
  });
});

describe("层级链", () => {
  it("addChildId 去重，removeChildId 精确移除", () => {
    const n = new Node();
    n.addChildId("c1");
    n.addChildId("c1");
    n.addChildId("c2");
    expect(n.childIds).toEqual(["c1", "c2"]);
    n.removeChildId("c1");
    expect(n.childIds).toEqual(["c2"]);
    n.removeChildId("不存在"); // 移除不存在的 id 无副作用
    expect(n.childIds).toEqual(["c2"]);
  });

  it("isEffectivelyVisibleIn：自身/任一祖先隐藏或停用即不可见", () => {
    const child = new Node();
    const parent = new Node({ id: "parent" });
    const grand = new Node({ id: "grand" });
    child.parentId = parent.id;
    parent.parentId = grand.id;
    const lookup = new Map([
      [parent.id, parent],
      [grand.id, grand],
    ]);
    const get = (id: string): Node | undefined => lookup.get(id);
    expect(child.isEffectivelyVisibleIn(get)).toBe(true);
    parent.visible = false;
    expect(child.isEffectivelyVisibleIn(get)).toBe(false);
    parent.visible = true;
    grand.active = false;
    expect(child.isEffectivelyVisibleIn(get)).toBe(false);
    grand.active = true;
    child.visible = false; // 自身隐藏同样不可见（点选不到）
    expect(child.isEffectivelyVisibleIn(get)).toBe(false);
  });

  it("父 id 指向不存在节点（断链）按已知链路判定", () => {
    const orphan = new Node({ parentId: "gone" });
    expect(orphan.isEffectivelyVisibleIn(() => undefined)).toBe(true);
  });
});

describe("属性槽", () => {
  it("setProperty/getProperty 读写与类型还原", () => {
    const n = new Node();
    n.setProperty("count", 3);
    n.setProperty("name", "x");
    expect(n.getProperty<number>("count")).toBe(3);
    expect(n.getProperty<string>("name")).toBe("x");
    expect(n.getProperty("missing")).toBeUndefined();
  });
});

describe("clone", () => {
  it("克隆换新 id、脱离父级，标签/层级/预制体引用/属性/组件随行", () => {
    const n = new Node({ name: "原", tag: "t", layer: 3, prefab: "a.prefab", properties: { v: 1 } });
    const c = n.clone();
    expect(c.id).not.toBe(n.id);
    expect(c.parentId).toBeNull();
    expect(c.name).toBe("原");
    expect(c.tag).toBe("t");
    expect(c.layer).toBe(3);
    expect(c.prefab).toBe("a.prefab");
    expect(c.properties).toEqual({ v: 1 });
    c.setProperty("v", 2);
    expect(n.getProperty("v")).toBe(1);
  });
});

describe("序列化（字节兼容约定）", () => {
  it("缺省字段不写出：tag/layer/prefab/components 为空时键不存在", () => {
    const json = new Node().toJSON() as Record<string, unknown>;
    expect(json).not.toHaveProperty("tag");
    expect(json).not.toHaveProperty("layer");
    expect(json).not.toHaveProperty("prefab");
    expect(json).not.toHaveProperty("components");
  });

  it("非缺省字段写出：tag/layer=7/prefab 均落盘", () => {
    const json = new Node({ tag: "enemy", layer: 7, prefab: "x.prefab" }).toJSON() as Record<string, unknown>;
    expect(json.tag).toBe("enemy");
    expect(json.layer).toBe(7);
    expect(json.prefab).toBe("x.prefab");
  });

  it("applyJSON 往返；旧版缺字段（无 tag/layer/transform）回默认", () => {
    const src = new Node({ name: "N", tag: "t", layer: 4 });
    src.addChildId("kid");
    const back = Node.fromJSON(src.toJSON() as Record<string, never>);
    expect(back.name).toBe("N");
    expect(back.tag).toBe("t");
    expect(back.layer).toBe(4);
    expect(back.childIds).toEqual(["kid"]);

    const legacy = Node.fromJSON({ type: "node", id: "node_x", name: "旧" });
    expect(legacy.tag).toBe("");
    expect(legacy.layer).toBe(0);
    expect(legacy.transform.scale).toEqual(vec3(1, 1, 1));
    expect(legacy.components).toEqual([]);
  });

  it("applyJSON 对非法字段类型回退（tag 非字符串 → 空、layer 超界 → 0）", () => {
    const n = new Node();
    n.applyJSON({ tag: 123, layer: 77 });
    expect(n.tag).toBe("");
    expect(n.layer).toBe(0);
  });
});
