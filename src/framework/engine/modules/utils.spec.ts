import { describe, expect, it } from "vitest";
import { isImplicitContainer } from "./utils";

// 「添加节点」隐式父级判定：未显式指定 parentId 时仅容器型选中节点收子，
// 实体节点一律挂根。回归背景：添加后自动选中 + 选中即隐式父级，
// 连续添加曾链式嵌套成树（方块下挂灯、灯下挂方块）。
describe("isImplicitContainer（隐式添加父级判定）", () => {
  it("容器型：空组 / UI 画布 / UI 布局容器 → 可作隐式父级", () => {
    expect(isImplicitContainer({ typeKey: "node" })).toBe(true);
    expect(isImplicitContainer({ typeKey: "uiCanvasNode" })).toBe(true);
    expect(isImplicitContainer({ typeKey: "uiLayoutNode" })).toBe(true);
  });

  it("实体节点一律不作隐式父级（挂根）——链式嵌套事故的回归用例", () => {
    expect(isImplicitContainer({ typeKey: "meshNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "directionalLightNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "pointLightNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "cameraNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "skyboxNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "particleSystemNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "terrainNode" })).toBe(false);
    expect(isImplicitContainer({ typeKey: "audioNode" })).toBe(false);
  });

  it("空选中（null/undefined）→ 回落挂根的判定为否", () => {
    expect(isImplicitContainer(null)).toBe(false);
    expect(isImplicitContainer(undefined)).toBe(false);
  });
});
