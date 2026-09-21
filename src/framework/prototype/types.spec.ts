import { describe, expect, it } from "vitest";
import { cloneRecord, cloneVec3, degToRad, radToDeg, vec3 } from "./types";

// 基础类型工具：向量构造/克隆、记录深拷贝、角度换算。
// 约定：这些函数是全部序列化与变换数学的地基，行为必须完全纯（无副作用）。

describe("vec3 / cloneVec3", () => {
  it("缺省构造为零向量，指定分量逐一保留", () => {
    const zero = vec3();
    expect(zero).toEqual({ x: 0, y: 0, z: 0 });
    expect(vec3(1, -2, 3.5)).toEqual({ x: 1, y: -2, z: 3.5 });
  });

  it("cloneVec3 产出独立副本（改原向量不影响克隆）", () => {
    const v = vec3(1, 2, 3);
    const c = cloneVec3(v);
    v.x = 99;
    expect(c).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe("cloneRecord", () => {
  it("深拷贝嵌套对象与数组", () => {
    const src = { a: 1, b: { c: [1, 2, { d: "x" }] }, e: null, f: true };
    const copy = cloneRecord(src);
    expect(copy).toEqual(src);
    (copy.b.c[2] as { d: string }).d = "changed";
    expect((src.b.c[2] as { d: string }).d).toBe("x");
  });

  it("空对象与仅标量字段", () => {
    expect(cloneRecord({})).toEqual({});
    expect(cloneRecord({ n: 0, s: "", z: null })).toEqual({ n: 0, s: "", z: null });
  });
});

describe("degToRad / radToDeg", () => {
  it("往返恒等（度 → 弧度 → 度）", () => {
    const degs = vec3(0, 90, -45.5);
    const back = radToDeg(degToRad(degs));
    expect(back.x).toBeCloseTo(0, 12);
    expect(back.y).toBeCloseTo(90, 12);
    expect(back.z).toBeCloseTo(-45.5, 12);
  });

  it("已知值：90° = π/2、180° = π、负角度保持符号", () => {
    expect(degToRad(vec3(90, 180, -90)).y).toBeCloseTo(Math.PI, 12);
    expect(degToRad(vec3(90, 180, -90)).x).toBeCloseTo(Math.PI / 2, 12);
    expect(degToRad(vec3(90, 180, -90)).z).toBeLessThan(0);
  });
});
