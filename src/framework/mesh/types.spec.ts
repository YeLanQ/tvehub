import { describe, expect, it } from "vitest";
import {
  cloneModelMaterialOverrides,
  collectModelMaterialOverrideRels,
  isGltfAssetRel,
  isModelAssetRel,
  modelDirOf,
  modelExtOf,
  modelFileName,
  modelFileStem,
  parseModelMaterialOverrides,
} from "./types";

// 模型资产路径工具与材质覆盖表：解析、克隆与嵌套收集。

describe("模型路径工具", () => {
  it("modelExtOf / isModelAssetRel / isGltfAssetRel 按扩展名", () => {
    expect(modelExtOf("a/b/Cube.GLB")).toBe("glb"); // 大小写不敏感
    for (const ext of ["glb", "gltf", "fbx", "obj"]) {
      expect(isModelAssetRel(`m/x.${ext}`)).toBe(true);
    }
    expect(isModelAssetRel("m/x.stl")).toBe(false);
    expect(isModelAssetRel("m/x")).toBe(false);
    expect(isGltfAssetRel("m/x.glb")).toBe(true);
    expect(isGltfAssetRel("m/x.gltf")).toBe(true);
    expect(isGltfAssetRel("m/x.fbx")).toBe(false);
  });

  it("modelFileName / modelFileStem / modelDirOf", () => {
    expect(modelFileName("assets/models/Robot.max/Robot.fbx")).toBe("Robot.fbx");
    expect(modelFileStem("assets/models/Robot.fbx")).toBe("Robot");
    expect(modelFileStem("Robot")).toBe("Robot"); // 无扩展名
    expect(modelFileStem(".gitignore")).toBe(".gitignore"); // 前置点不算扩展名
    expect(modelDirOf("assets/models/a.glb")).toBe("assets/models");
    expect(modelDirOf("a.glb")).toBe(""); // 根目录
  });
});

describe("材质覆盖表", () => {
  it("parse：仅保留非空键值的字符串项", () => {
    expect(parseModelMaterialOverrides(null)).toEqual({});
    expect(parseModelMaterialOverrides("x")).toEqual({});
    expect(parseModelMaterialOverrides({ "": "a.mat", a: "b.mat", b: "", c: 3 })).toEqual({ a: "b.mat" });
  });

  it("clone 独立副本", () => {
    const src = { a: "m1.mat" };
    const c = cloneModelMaterialOverrides(src);
    c.a = "m2.mat";
    expect(src.a).toBe("m1.mat");
  });

  it("collect：嵌套场景 JSON 收集 meshNode 的覆盖引用（去重、忽略非法）", () => {
    const scene = {
      root: {
        type: "node",
        children: [
          { type: "meshNode", modelMaterialOverrides: { Body: "mat/body.mat", Wheel: "mat/body.mat", Bad: 5 } },
          { type: "meshNode", modelMaterialOverrides: { Glass: "mat/glass.mat" } },
          { type: "cameraNode" },
        ],
      },
    };
    expect(collectModelMaterialOverrideRels(scene).sort()).toEqual(["mat/body.mat", "mat/glass.mat"]);
    expect(collectModelMaterialOverrideRels(null)).toEqual([]);
    expect(collectModelMaterialOverrideRels([42, "s", { type: "meshNode" }])).toEqual([]);
  });
});
