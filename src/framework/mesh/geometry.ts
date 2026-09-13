// ---------------------------------------------------------------------------
// 基元几何工厂（注册表模式，风格对齐 material/factory 的材质类型注册表）：
// - 每种基元对应一个 GeometryProvider：key（GeometryKind）+ 显示名 + 构建函数；
// - 需要新基元时：写一个 provider 并在 createDefaultGeometryRegistry 里 register 一行；
// - 同步器/NodeFactory/UI（几何下拉、默认命名）共用同一注册表，单一来源。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { Vec3 } from "../prototype/types";

/** 基元几何类型 key（写入 MeshNode.geometry 字段） */
export type GeometryKind = "box" | "sphere" | "plane" | "cylinder" | "cone" | "torus" | "capsule";

/** 单个基元几何的类型定义（工厂产物 = three BufferGeometry） */
export interface GeometryProvider {
  /** 类型 key（MeshNode.geometry） */
  key: GeometryKind;
  /** UI 显示名（几何下拉 / 新建默认命名） */
  label: string;
  /** 工厂：按尺寸参数构建几何 */
  build(size: Vec3): THREE.BufferGeometry;
}

/** 基元几何注册表：key → 类型定义 */
export class GeometryRegistry {
  private defs = new Map<GeometryKind, GeometryProvider>();

  register(def: GeometryProvider): void {
    this.defs.set(def.key, def);
  }

  /** 按类型 key 取定义；未注册回退 box（保证渲染不中断） */
  getOrDefault(key: string): GeometryProvider {
    return this.defs.get(key as GeometryKind) ?? this.defs.get("box")!;
  }

  /** 已注册基元列表（注册顺序 = UI 展示顺序） */
  list(): GeometryProvider[] {
    return [...this.defs.values()];
  }
}

/** 尺寸分量下限（与旧版 buildGeometry 行为一致：过小几何在部分后端渲染异常） */
function dim(v: number): number {
  return Math.max(0.01, v);
}

/** 默认基元注册表（新基元在此追加一行 register） */
export function createDefaultGeometryRegistry(): GeometryRegistry {
  const registry = new GeometryRegistry();
  registry.register({
    key: "box",
    label: "Box",
    build: (s) => new THREE.BoxGeometry(dim(s.x), dim(s.y), dim(s.z)),
  });
  registry.register({
    key: "sphere",
    label: "Sphere",
    build: (s) => new THREE.SphereGeometry(dim(s.x) / 2, 32, 24),
  });
  registry.register({
    key: "plane",
    label: "Plane",
    build: (s) => new THREE.PlaneGeometry(dim(s.x), dim(s.z)),
  });
  registry.register({
    key: "cylinder",
    label: "Cylinder",
    build: (s) => new THREE.CylinderGeometry(dim(s.x) / 2, dim(s.x) / 2, dim(s.y), 24),
  });
  registry.register({
    key: "cone",
    label: "Cone",
    build: (s) => new THREE.ConeGeometry(dim(s.x) / 2, dim(s.y), 24),
  });
  registry.register({
    key: "torus",
    label: "Torus",
    build: (s) => new THREE.TorusGeometry(dim(s.x) / 2, dim(s.y) / 2, 16, 48),
  });
  registry.register({
    key: "capsule",
    label: "Capsule",
    build: (s) => new THREE.CapsuleGeometry(dim(s.x) / 2, dim(s.y), 8, 24),
  });
  return registry;
}

/** 模块级单例：provider 无状态，引擎同步与 UI（几何下拉/默认命名）共用 */
export const geometryRegistry = createDefaultGeometryRegistry();

/** 按类型 key + 尺寸构建基元几何（未注册类型回退 box） */
export function buildGeometry(kind: string, size: Vec3): THREE.BufferGeometry {
  return geometryRegistry.getOrDefault(kind).build(size);
}
