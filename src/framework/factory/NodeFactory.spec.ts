import { describe, expect, it } from "vitest";
import {
  AmbientLightNode,
  CameraNode,
  FogNode,
  MeshNode,
  PointLightNode,
  SkyboxNode,
  SpotLightNode,
} from "../prototype/derived/Primitives";
import { Node } from "../prototype/Node";
import { createDefaultRegistry } from "../prototype/PrototypeRegistry";
import { createNodeFactory, NodeFactory } from "./NodeFactory";
import { vec3 } from "../prototype/types";

// 工厂层：统一注入编辑器默认值（命名/变换/父级）与各类型便捷构造。

const factory: NodeFactory = createNodeFactory(createDefaultRegistry());

describe("create 通用路径", () => {
  it("按类型派发 + 注入父级/名称/位置；缺省不动模板默认", () => {
    const n = factory.create("node", { parentId: "p", name: "自定义", position: vec3(1, 2, 3) });
    expect(n).toBeInstanceOf(Node);
    expect(n.parentId).toBe("p");
    expect(n.name).toBe("自定义");
    expect(n.transform.position).toEqual(vec3(1, 2, 3));
    const bare = factory.create("node");
    expect(bare.parentId).toBeNull();
    expect(bare.name).toBe("Node");
  });

  it("两次 create 产出独立实例（id 不串）", () => {
    const a = factory.create("meshNode");
    const b = factory.create("meshNode");
    expect(a.id).not.toBe(b.id);
  });
});

describe("网格与模型", () => {
  it("createMesh：基元几何注入默认尺寸与名称，source=primitive", () => {
    const box = factory.createMesh("box");
    expect(box.source).toBe("primitive");
    expect(box.geometry).toBe("box");
    expect(box.name).toBe("Box");
    const plane = factory.createMesh("plane");
    expect(plane.size).toEqual({ x: 10, y: 1, z: 10 });
    expect(plane.name).toBe("Plane");
  });

  it("createMesh 未登记几何回退 box（渲染不中断约定）", () => {
    const n = factory.createMesh("不存在的几何");
    expect(n.geometry).toBe("box");
  });

  it("createModel：source=model、材质置空（内嵌）、名称取文件名 stem", () => {
    const m = factory.createModel("assets/models/Robot.fbx");
    expect(m.source).toBe("model");
    expect(m.model).toBe("assets/models/Robot.fbx");
    expect(m.material).toBe("");
    expect(m.name).toBe("Robot");
  });
});

describe("灯光 / 相机 / 天空盒 / 雾", () => {
  it("四种灯光类型各自派发且默认命名", () => {
    expect(factory.createLight("point")).toBeInstanceOf(PointLightNode);
    expect(factory.createLight("directional").name).toBe("Directional Light");
    expect(factory.createLight("ambient")).toBeInstanceOf(AmbientLightNode);
    expect(factory.createLight("spot")).toBeInstanceOf(SpotLightNode);
  });

  it("相机：编辑器相机与普通相机命名区分", () => {
    expect(factory.createCamera({ isEditorCamera: true }).name).toBe("EditorCamera");
    expect(factory.createCamera().name).toBe("Camera");
    expect(factory.createCamera()).toBeInstanceOf(CameraNode);
  });

  it("天空盒：kind 决定材质引用与命名", () => {
    const p = factory.createSkybox("procedural");
    const c = factory.createSkybox("cube");
    expect(p).toBeInstanceOf(SkyboxNode);
    expect(p.material).not.toBe(c.material);
    expect(p.name).toBe("Procedural Skybox");
    expect(c.name).toBe("Cube Skybox");
  });

  it("雾：三种类型命名（线性/指数/高度）", () => {
    expect(factory.createFog("linear").name).toBe("Linear Fog");
    expect(factory.createFog("exp2").name).toBe("Exponential Fog");
    expect(factory.createFog("height").name).toBe("Height Fog");
    expect(factory.createFog("linear")).toBeInstanceOf(FogNode);
  });
});

describe("fromJSON 反序列化派发", () => {
  it("与 registry.createFromJSON 同语义", () => {
    const src = factory.createMesh("sphere", { name: "S" });
    const back = factory.fromJSON(src.toJSON() as Record<string, never>);
    expect(back).toBeInstanceOf(MeshNode);
    expect(back.name).toBe("S");
    expect((back as MeshNode).geometry).toBe("sphere");
  });
});

describe("全部便捷构造的命名缺省", () => {
  it("各类型未传 name 时使用各自缺省名", () => {
    expect(factory.createParticleSystem().name).toBe("Particle System");
    expect(factory.createTerrain().name).toBe("Terrain");
    expect(factory.createNavArea().name).toBe("Nav Area");
    expect(factory.createNavAgent().name).toBe("Nav Agent");
    expect(factory.createFsmRunner().name).toBe("FSM Runner");
    expect(factory.createBtRunner().name).toBe("BT Runner");
    expect(factory.createAudio().name).toBe("Audio Source");
    expect(factory.createUIImage().name).toBe("Image");
    expect(factory.createUIText().name).toBe("Text");
    expect(factory.createUIButton().name).toBe("Button");
    expect(factory.createUILayout().name).toBe("Layout");
  });

  it("UI 画布：项目默认值注入（设计分辨率/缩放模式），缺省回退模板", () => {
    const withDefaults = factory.createUICanvas({}, { designWidth: 1920, designHeight: 1080, scaleMode: "fixedheight" });
    expect(withDefaults.designWidth).toBe(1920);
    expect(withDefaults.designHeight).toBe(1080);
    expect(withDefaults.scaleMode).toBe("fixedheight");
    const bare = factory.createUICanvas();
    expect(bare.designWidth).toBeGreaterThan(0); // 模板缺省（1280×720）
  });
});
