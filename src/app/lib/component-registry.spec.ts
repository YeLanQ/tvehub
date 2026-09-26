import { describe, expect, it } from "vitest";
import { canonicalComponentType, createComponentRef } from "./component-registry";

// 组件类型归一：命令层小写化入参 → 驼峰登记键（rigidBody 等经 node.component.add 曾查不到描述符）。

describe("canonicalComponentType", () => {
  it("正常：小写入参归一回驼峰登记键", () => {
    expect(canonicalComponentType("rigidbody")).toBe("rigidBody");
    expect(canonicalComponentType("collider")).toBe("collider");
    expect(canonicalComponentType("audiosource")).toBe("audioSource");
    expect(canonicalComponentType("animationclip")).toBe("animationClip");
    expect(canonicalComponentType("script")).toBe("script");
  });

  it("边界：大小写混写/首尾空白容忍", () => {
    expect(canonicalComponentType("RigidBody")).toBe("rigidBody");
    expect(canonicalComponentType("  Collider ")).toBe("collider");
  });

  it("异常：未登记类型返回 null", () => {
    expect(canonicalComponentType("warpdrive")).toBeNull();
  });

  it("空值：非字符串输入返回 null", () => {
    expect(canonicalComponentType(undefined)).toBeNull();
    expect(canonicalComponentType(123)).toBeNull();
    expect(canonicalComponentType("")).toBeNull();
  });
});

describe("createComponentRef（经归一键）", () => {
  it("小写 'rigidbody' 能建出 rigidBody 组件（回归：此前 descriptorOf 查不到直接抛错）", () => {
    const comp = createComponentRef(canonicalComponentType("rigidbody")!, {});
    expect(comp.type).toBe("rigidBody");
    expect(comp.enabled).toBe(true);
  });
});
