// parseMeshSizePayload：Set Mesh Size 载荷解析（正常/边界/异常/空值四类）。
// 契约：axis 限定 x/y/z，value 须有限正数；不合法一律返回 null（调用方丢弃不提交）。
import { describe, expect, it } from "vitest";
import { parseMeshSizePayload } from "./useInspectorNode";

describe("parseMeshSizePayload", () => {
  it("正常：xyz 三轴合法正数原样通过", () => {
    expect(parseMeshSizePayload({ axis: "x", value: 2 })).toEqual({ axis: "x", value: 2 });
    expect(parseMeshSizePayload({ axis: "y", value: 0.4 })).toEqual({ axis: "y", value: 0.4 });
    expect(parseMeshSizePayload({ axis: "z", value: 128 })).toEqual({ axis: "z", value: 128 });
  });

  it("边界：极小正数与科学计数字符串数字通过", () => {
    expect(parseMeshSizePayload({ axis: "x", value: 0.01 })).toEqual({ axis: "x", value: 0.01 });
    expect(parseMeshSizePayload({ axis: "y", value: "1.5" })).toEqual({ axis: "y", value: 1.5 });
  });

  it("异常：非正数/非有限值/未知轴返回 null", () => {
    expect(parseMeshSizePayload({ axis: "x", value: 0 })).toBeNull();
    expect(parseMeshSizePayload({ axis: "y", value: -1 })).toBeNull();
    expect(parseMeshSizePayload({ axis: "z", value: Number.NaN })).toBeNull();
    expect(parseMeshSizePayload({ axis: "z", value: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseMeshSizePayload({ axis: "w", value: 1 })).toBeNull();
    expect(parseMeshSizePayload({ axis: null, value: 1 })).toBeNull();
  });

  it("空值：null/undefined/非对象/数组返回 null", () => {
    expect(parseMeshSizePayload(null)).toBeNull();
    expect(parseMeshSizePayload(undefined)).toBeNull();
    expect(parseMeshSizePayload("x")).toBeNull();
    expect(parseMeshSizePayload(42)).toBeNull();
    expect(parseMeshSizePayload(["x", 1])).toBeNull();
    expect(parseMeshSizePayload({})).toBeNull();
  });
});
