import { describe, expect, it } from "vitest";
import { MeshNode, PointLightNode } from "./derived/Primitives";
import { Node } from "./Node";
import { createDefaultRegistry, PrototypeRegistry } from "./PrototypeRegistry";

// 原型注册中心：登记/派生/反序列化派发与缺省注册表完整性。

describe("PrototypeRegistry 基础", () => {
  it("register/has/listTypes", () => {
    const r = new PrototypeRegistry();
    expect(r.has("node")).toBe(false);
    r.register("node", () => new Node());
    expect(r.has("node")).toBe(true);
    expect(r.listTypes()).toEqual(["node"]);
  });

  it("getTemplate 未登记类型抛错（信息含类型名）", () => {
    const r = new PrototypeRegistry();
    expect(() => r.getTemplate("nope")).toThrowError(/unregistered prototype type: nope/);
  });

  it("create 每次派生全新实例（模板与实例互不影响）", () => {
    const r = new PrototypeRegistry();
    r.register("node", () => new Node({ name: "模板" }));
    const a = r.create("node");
    const b = r.create("node");
    expect(a).not.toBe(b);
    expect(a.id).not.toBe(b.id);
    a.name = "改";
    expect(r.create("node").name).toBe("模板");
  });

  it("createFromJSON 按类型派发到派生类并回填扩展字段", () => {
    const r = createDefaultRegistry();
    const node = r.createFromJSON({ type: "meshNode", id: "m1", name: "M" });
    expect(node).toBeInstanceOf(MeshNode);
    expect(node.id).toBe("m1");
    expect(node.name).toBe("M");
  });

  it("旧场景兼容：type=lightNode 回退解析为点光源", () => {
    const r = createDefaultRegistry();
    const node = r.createFromJSON({ type: "lightNode", id: "l1" });
    expect(node).toBeInstanceOf(PointLightNode);
  });
});

describe("缺省注册表", () => {
  const registry = createDefaultRegistry();
  const expected = [
    "node", "meshNode",
    "pointLightNode", "directionalLightNode", "ambientLightNode", "spotLightNode", "lightNode",
    "cameraNode", "skyboxNode", "audioNode", "particleSystemNode", "terrainNode",
    "navAreaNode", "navAgentNode", "fsmRunnerNode", "btRunnerNode", "fogNode",
    "uiCanvasNode", "uiImageNode", "uiTextNode", "uiButtonNode", "uiLayoutNode",
  ];

  it("全部内置类型均已登记", () => {
    for (const t of expected) expect(registry.has(t), `缺少类型 ${t}`).toBe(true);
  });

  it("每个登记类型的模板可实例化且序列化往返保持类型", () => {
    for (const t of registry.listTypes()) {
      const node = registry.create(t);
      expect(node.typeKey, `${t} 实例的 typeKey 应一致`).toBe(t === "lightNode" ? "pointLightNode" : t);
      const back = registry.createFromJSON(node.toJSON() as Record<string, never>);
      expect(back.constructor).toBe(node.constructor);
    }
  });
});
