import { describe, expect, it } from "vitest";
import { acquireGeometry, buildGeometry, geometryRegistry, releaseGeometry } from "./geometry";

// 编辑器共享基元几何（引用计数）：同规格共享实例，引用归零才 dispose。

const size = { x: 1, y: 1, z: 1 };

describe("acquireGeometry / releaseGeometry", () => {
  it("正常：同规格两次 acquire 同一实例；不同规格不同实例", () => {
    const a = acquireGeometry("box", size);
    const b = acquireGeometry("box", size);
    expect(a).toBe(b);
    const c = acquireGeometry("sphere", { x: 2, y: 2, z: 2 });
    expect(c).not.toBe(a);
    releaseGeometry(a);
    releaseGeometry(b);
    releaseGeometry(c);
  });

  it("边界：引用未归零不真释放（再取仍同实例），归零后重建新实例", () => {
    const a = acquireGeometry("box", size);
    const b = acquireGeometry("box", size);
    releaseGeometry(a);
    const c = acquireGeometry("box", size);
    expect(c).toBe(b); // 还有 1 个引用活着，缓存未销毁
    releaseGeometry(b);
    releaseGeometry(c); // 归零 → 真 dispose + 缓存清除
    const d = acquireGeometry("box", size);
    expect(d).not.toBe(b);
    releaseGeometry(d);
  });

  it("异常：重复多释放不炸（引用负数即清）；release 未共享几何直接 dispose 等价", () => {
    const a = acquireGeometry("cone", size);
    releaseGeometry(a);
    expect(() => releaseGeometry(a)).not.toThrow(); // 缓存已删 → 走普通 dispose 路径
    const plain = buildGeometry("torus", size);
    expect(() => releaseGeometry(plain)).not.toThrow();
  });

  it("空值：null/undefined 几何安全跳过", () => {
    expect(() => releaseGeometry(null)).not.toThrow();
    expect(() => releaseGeometry(undefined)).not.toThrow();
  });

  it("注册表完整性：8 种基元都能 acquire（新基元自动享受共享）", () => {
    for (const def of geometryRegistry.list()) {
      const g = acquireGeometry(def.key, size);
      expect(g.getAttribute("position").count).toBeGreaterThan(0);
      releaseGeometry(g);
    }
  });
});
