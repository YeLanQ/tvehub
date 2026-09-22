import { describe, expect, it } from "vitest";
import { type TransformSnapshot } from "../../framework/scene/SceneClient";
import { currentTransform, mergeTransformSnapshot, parseNodeSetArgs, type NodeSetPatch } from "./nodeSet";

/** 断言解析成功并返回补丁（失败即测试失败） */
function parsed(args: unknown): NodeSetPatch {
  const out = parseNodeSetArgs(args);
  if ("error" in out) throw new Error(`应解析成功: ${out.error}`);
  return out.patch;
}

/** 断言解析失败并返回错误文案 */
function parseError(args: unknown): string {
  const out = parseNodeSetArgs(args);
  if (!("error" in out)) throw new Error("应解析失败");
  return out.error;
}

/** 断言合并成功并返回快照 */
function merged(current: TransformSnapshot, patch: Record<string, unknown>): TransformSnapshot {
  const out = mergeTransformSnapshot(current, patch);
  if ("error" in out) throw new Error(`应合并成功: ${out.error}`);
  return out.snapshot;
}

/** 断言合并失败并返回错误文案 */
function mergeError(current: TransformSnapshot, patch: Record<string, unknown>): string {
  const out = mergeTransformSnapshot(current, patch);
  if (!("error" in out)) throw new Error("应合并失败");
  return out.error;
}

describe("parseNodeSetArgs", () => {
  it("正常：prop/value 单属性形式（历史契约）", () => {
    expect(parsed({ id: "a", prop: "visible", value: false }).props).toEqual({ visible: false });
    expect(parsed({ id: "a", prop: "visible", value: false }).name).toBeUndefined();
  });

  it("正常：字段包形式 name+transform+visible 混写分类正确", () => {
    const patch = parsed({
      id: "a",
      name: "Ground",
      visible: true,
      transform: { position: { x: 1, y: 2, z: 3 } },
    });
    expect(patch.name).toBe("Ground");
    expect(patch.transform).toEqual({ position: { x: 1, y: 2, z: 3 } });
    expect(patch.props).toEqual({ visible: true });
  });

  it("正常：顶层 position/scale 归入变换补丁，其余进属性补丁", () => {
    const patch = parsed({
      id: "a",
      position: { x: 5 },
      scale: { x: 2, y: 2, z: 2 },
      tag: "floor",
    });
    expect(patch.transform).toEqual({ position: { x: 5 }, scale: { x: 2, y: 2, z: 2 } });
    expect(patch.props).toEqual({ tag: "floor" });
  });

  it("正常：prop=transform 的 value 对象同样进入变换通道", () => {
    expect(
      parsed({ id: "a", prop: "transform", value: { rotation: { x: 90, y: 0, z: 0 } } }).transform,
    ).toEqual({ rotation: { x: 90, y: 0, z: 0 } });
  });

  it("边界：transform 空对象不产生变换补丁；仅 name 时无属性补丁", () => {
    const patch = parsed({ id: "a", name: "X", transform: {} });
    expect(patch.transform).toBeUndefined();
    expect(patch.props).toBeUndefined();
    expect(patch.name).toBe("X");
  });

  it("异常：禁改字段 id/childIds/parentId/children/type 逐一拒绝", () => {
    for (const prop of ["id", "childIds", "parentId", "children", "type"]) {
      expect(parseError({ id: "a", [prop]: "x" })).toContain("不支持设置的属性");
    }
  });

  it("异常：空 name / 非对象 transform 报错可读", () => {
    expect(parseError({ id: "a", name: "  " })).toBeTruthy();
    expect(parseError({ id: "a", transform: 3 })).toContain("对象");
  });

  it("空值：无属性 / 非对象参数 / 数组参数报错", () => {
    expect(parseError({ id: "a" })).toContain("(空)");
    expect(parseError({ id: "a", prop: "", value: 1 })).toContain("(空)");
    expect(parseError(null)).toBeTruthy();
    expect(parseError(["x"])).toBeTruthy();
  });
});

describe("mergeTransformSnapshot", () => {
  const base = currentTransform({ x: 1, y: 2, z: 3 }, { x: 0, y: 90, z: 0 }, { x: 1, y: 1, z: 1 });

  it("正常：部分分量合并，未给分量保持原值", () => {
    const snapshot = merged(base, { position: { x: 9 } });
    expect(snapshot.position).toEqual({ x: 9, y: 2, z: 3 });
    expect(snapshot.rotation).toEqual({ x: 0, y: 90, z: 0 });
    expect(snapshot.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("正常：全分量整体覆盖（节点 add 后落位形态）", () => {
    const snapshot = merged(base, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 45, y: 45, z: 45 },
      scale: { x: 2, y: 2, z: 2 },
    });
    expect(snapshot.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(snapshot.rotation).toEqual({ x: 45, y: 45, z: 45 });
    expect(snapshot.scale).toEqual({ x: 2, y: 2, z: 2 });
  });

  it("边界：空补丁原样返回；数值字符串分量可解析", () => {
    expect(merged(base, {})).toEqual(base);
    expect(merged(base, { position: { y: "4" } }).position).toEqual({ x: 1, y: 4, z: 3 });
  });

  it("异常：分量非对象 / 非数值 / 未知键报错指明字段", () => {
    expect(mergeError(base, { position: 5 })).toContain("position");
    expect(mergeError(base, { scale: { x: "big" } })).toContain("scale.x");
    expect(mergeError(base, { foo: { x: 1 } })).toContain("foo");
    expect(mergeError(base, { position: { w: 1 } })).toContain("position");
  });
});
