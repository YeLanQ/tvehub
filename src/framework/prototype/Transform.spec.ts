import { describe, expect, it } from "vitest";
import { AnchoredTransform, Transform } from "./Transform";
import { vec3 } from "./types";

// 变换基元：默认值、setter、克隆/拷贝独立性、等值比较与序列化往返。

describe("Transform 构造与默认值", () => {
  it("缺省：原点、零旋转、单位缩放", () => {
    const t = new Transform();
    expect(t.position).toEqual(vec3());
    expect(t.rotation).toEqual(vec3());
    expect(t.scale).toEqual(vec3(1, 1, 1));
    expect(t.typeKey).toBe(Transform.kType);
  });

  it("init 入参生效且被克隆（外部改入参对象不串扰）", () => {
    const pos = vec3(1, 2, 3);
    const t = new Transform({ position: pos });
    pos.x = 100;
    expect(t.position.x).toBe(1);
  });
});

describe("setter 与 copyFrom", () => {
  it("setPosition/setRotation/setScale 直接替换分量", () => {
    const t = new Transform();
    t.setPosition(1, 2, 3);
    t.setRotation(90, 180, 0);
    t.setScale(2, 2, 2);
    expect(t.position).toEqual(vec3(1, 2, 3));
    expect(t.rotation).toEqual(vec3(90, 180, 0));
    expect(t.scale).toEqual(vec3(2, 2, 2));
  });

  it("copyFrom 深拷贝源变换（之后改源互不影响）", () => {
    const a = new Transform({ position: vec3(5, 6, 7) });
    const b = new Transform();
    b.copyFrom(a);
    a.position.x = -1;
    expect(b.position.x).toBe(5);
  });
});

describe("clone / equals", () => {
  it("clone 完全相等但为独立对象", () => {
    const t = new Transform({ position: vec3(1, 2, 3), rotation: vec3(10, 20, 30) });
    const c = t.clone();
    expect(c.equals(t)).toBe(true);
    c.position.x = 999;
    expect(t.position.x).toBe(1);
  });

  it("equals 在超过 1e-6 容差时判不等，容差内判相等", () => {
    const a = new Transform({ position: vec3(0, 0, 0) });
    const b = new Transform({ position: vec3(1e-7, 0, 0) });
    const c = new Transform({ position: vec3(1e-3, 0, 0) });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("序列化往返", () => {
  it("toJSON → fromJSON 往返保持全部字段", () => {
    const t = new Transform({ position: vec3(1.5, -2, 3), rotation: vec3(45, 0, 90), scale: vec3(2, 1, 0.5) });
    const back = Transform.fromJSON(t.toJSON() as Record<string, never>);
    expect(back.equals(t)).toBe(true);
  });

  it("fromJSON 缺字段回退默认（position/rotation → 0，scale → 1）", () => {
    const t = Transform.fromJSON({});
    expect(t.position).toEqual(vec3());
    expect(t.scale).toEqual(vec3(1, 1, 1));
  });
});

describe("AnchoredTransform（派生示例）", () => {
  it("anchor 独立于基类字段，clone/toJSON 携带", () => {
    const t = new AnchoredTransform({ position: vec3(1, 0, 0), anchor: vec3(0.5, 0.5, 0) });
    expect(t.typeKey).toBe(AnchoredTransform.kType);
    const c = t.clone();
    expect(c.anchor).toEqual(vec3(0.5, 0.5, 0));
    expect((t.toJSON() as Record<string, unknown>).anchor).toEqual({ x: 0.5, y: 0.5, z: 0 });
  });
});
