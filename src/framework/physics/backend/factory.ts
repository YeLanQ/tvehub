// ---------------------------------------------------------------------------
// 物理后端工厂（注册表模式，风格对齐 material/factory 的 MaterialTypeRegistry）：
// - 每个后端一个 PhysicsBackendDef：key/label + create（惰性动态 import 引擎）；
// - 新后端：写一个 createXxxWorld 适配器 + 在 createDefaultPhysicsBackendRegistry
//   里 register 一行即可；
// - 模块级单例 physicsBackendRegistry 供引擎（世界创建）与 UI（后端下拉）共用。
// ---------------------------------------------------------------------------

import type { PhysicsBackendId } from "../types";
import type { IPhysicsWorld, PhysicsWorldSettings } from "./types";

/** 单个物理后端的完整定义（工厂产物 = IPhysicsWorld 异步构造） */
export interface PhysicsBackendDef {
  /** 后端 key（写入场景 settings.physics.backend） */
  key: PhysicsBackendId;
  /** UI 显示名（后端下拉） */
  label: string;
  /** 创建物理世界（内部动态 import 对应引擎，首次调用才有加载开销） */
  create(settings: PhysicsWorldSettings): Promise<IPhysicsWorld>;
}

/** 物理后端注册表：key → 定义 */
export class PhysicsBackendRegistry {
  private defs = new Map<string, PhysicsBackendDef>();

  register(def: PhysicsBackendDef): void {
    this.defs.set(def.key, def);
  }

  /** 按后端 key 取定义；未注册返回 null */
  get(key: string): PhysicsBackendDef | null {
    return this.defs.get(key) ?? null;
  }

  /** 已注册后端列表（注册顺序 = UI 展示顺序） */
  list(): PhysicsBackendDef[] {
    return [...this.defs.values()];
  }
}

/** 默认物理后端注册表（rapier + jolt + ammo；新后端在此追加一行 register） */
export function createDefaultPhysicsBackendRegistry(): PhysicsBackendRegistry {
  const registry = new PhysicsBackendRegistry();
  registry.register({
    key: "rapier",
    label: "Rapier",
    create: (settings) =>
      import("./rapierBackend").then((m) => m.createRapierWorld(settings)),
  });
  registry.register({
    key: "jolt",
    label: "Jolt",
    create: (settings) =>
      import("./joltBackend").then((m) => m.createJoltWorld(settings)),
  });
  registry.register({
    key: "ammo",
    label: "Ammo.js (Bullet)",
    create: (settings) =>
      import("./ammoBackend").then((m) => m.createAmmoWorld(settings)),
  });
  return registry;
}

/** 模块级单例：后端定义无状态，引擎与 UI 共用 */
export const physicsBackendRegistry = createDefaultPhysicsBackendRegistry();
