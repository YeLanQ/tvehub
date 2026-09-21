import { describe, expect, it } from "vitest";
import {
  cloneComponentForWrite,
  cloneNodeComponents,
  descriptorOf,
  parseNodeComponents,
} from "./components";
import type { NodeComponentRef, ScriptComponentRef } from "./components";

// 节点组件层：公共链路（解析收敛 / 实例克隆 / 写出克隆）与描述符约定。

const scriptRef = (over: Partial<ScriptComponentRef> = {}): ScriptComponentRef => ({
  id: "comp_a",
  type: "script",
  script: "src/spin.ts",
  enabled: true,
  executionOrder: 0,
  props: { speed: 5 },
  ...over,
});

describe("descriptorOf 查表", () => {
  it("六种内置类型均可取到描述符，未登记类型返回 null", () => {
    for (const t of ["script", "rigidBody", "collider", "light", "audioSource", "animationClip"]) {
      expect(descriptorOf(t), `${t} 应有描述符`).not.toBeNull();
    }
    expect(descriptorOf("nope")).toBeNull();
  });
});

describe("parseNodeComponents 收敛", () => {
  it("非数组输入（undefined/对象/null）回空列表", () => {
    expect(parseNodeComponents(undefined)).toEqual([]);
    expect(parseNodeComponents(null)).toEqual([]);
    expect(parseNodeComponents({})).toEqual([]);
  });

  it("剔除非法条目：非对象、未登记 type、脚本缺路径", () => {
    const out = parseNodeComponents([
      null,
      42,
      { type: "nope" },
      { type: "script" }, // 缺 script 路径 → 整条剔除
      scriptRef({ id: "keep" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("keep");
  });

  it("旧数据兼容：无 type 字段按 script 收敛；缺 id 自动生成", () => {
    const out = parseNodeComponents([{ script: "src/a.ts" }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("script");
    expect(out[0].id).toMatch(/^comp_/);
    expect(out[0].enabled).toBe(true); // enabled !== false 才为 false
  });

  it("enabled: false 保留；executionOrder 非数回 0；props 深拷贝", () => {
    const out = parseNodeComponents([{ script: "s.ts", enabled: false, executionOrder: "x", props: { a: { b: 1 } } }]);
    const c = out[0] as ScriptComponentRef;
    expect(c.enabled).toBe(false);
    expect(c.executionOrder).toBe(0);
    expect(c.props).toEqual({ a: { b: 1 } });
  });

  it("animationClip 绑定收敛：缺字段回默认、speed 负数收敛为 0", () => {
    const out = parseNodeComponents([{ type: "animationClip", clip: { speed: -2 } }]);
    expect(out[0].type).toBe("animationClip");
    const clip = (out[0] as { clip: { clip: string; autoplay: boolean; loop: boolean; speed: number } }).clip;
    expect(clip).toEqual({ clip: "", autoplay: true, loop: true, speed: 0 });
  });
});

describe("cloneNodeComponents（实例克隆）", () => {
  it("id 全部重新生成，payload 深拷贝", () => {
    const list: NodeComponentRef[] = [scriptRef()];
    const copy = cloneNodeComponents(list);
    expect(copy[0].id).not.toBe("comp_a");
    expect((copy[0] as ScriptComponentRef).props).toEqual({ speed: 5 });
    (copy[0] as ScriptComponentRef).props.speed = 99;
    expect((list[0] as ScriptComponentRef).props.speed).toBe(5);
  });
});

describe("cloneComponentForWrite（序列化写出）", () => {
  it("id 保留；脚本 executionOrder=0 缺省删键、非 0 保留", () => {
    const zero = cloneComponentForWrite(scriptRef()) as unknown as Record<string, unknown>;
    expect(zero.id).toBe("comp_a");
    expect(zero).not.toHaveProperty("executionOrder");
    const five = cloneComponentForWrite(scriptRef({ executionOrder: 5 })) as unknown as Record<string, unknown>;
    expect(five.executionOrder).toBe(5);
  });
});

describe("各描述符 createDefault / resetSettings", () => {
  it("script 的 createDefault 抛错（必须走专用入口指定路径）", () => {
    expect(() => descriptorOf("script")!.createDefault()).toThrowError();
  });

  it("其余五种类型 createDefault 产出启用组件；resetSettings 重置数据但保留 id/enabled", () => {
    for (const t of ["rigidBody", "collider", "light", "audioSource", "animationClip"] as const) {
      const d = descriptorOf(t)!;
      const c = d.createDefault();
      expect(c.type).toBe(t);
      expect(c.enabled).toBe(true);
      expect(c.id).toMatch(/^comp_/);
      c.enabled = false;
      d.resetSettings(c);
      expect(c.enabled).toBe(false); // id/enabled 不被重置
      expect(c.id).toMatch(/^comp_/);
    }
  });

  it("light 的 createDefault 按 lightKind 产出对应类型", () => {
    const spot = descriptorOf("light")!.createDefault({ lightKind: "spot" }) as unknown as { light: { kind: string } };
    expect(spot.light.kind).toBe("spot");
  });
});
