// ---------------------------------------------------------------------------
// Component 基类 + 装饰器（@property / @nodeType 声明式写法）
// - property：字段装饰器，登记字段为组件可编辑属性（host 据此读取字段初值作
//   默认并注入节点配置覆盖）；类型契约见 tve.d.ts。
// - nodeType：类装饰器，登记脚本类为可创建节点类型（编辑器创建入口用）。
// 元数据挂在类上（__tvePropKeys / __tveNodeType），editor 经 AST 静态解析，
// 运行期仅 host 需要属性键集合（见 scripts.mjs）。
// ---------------------------------------------------------------------------
import { BUILTIN_TYPE_KEYS } from "./component-registry";
import { isNodeRefType } from "./node-types";
import type { Entity } from "./entity";

/** 脚本类构造器视图（装饰器元数据宿主；元数据字段由本模块与注册表写入） */
type TveMetaCtor = Function & {
  /** @property 字段名集（装饰器模式） */
  __tvePropKeys?: string[];
  /** 节点引用字段键名集（@property({type: 节点类})） */
  __tveEntityKeys?: string[];
  /** 组件引用字段（[字段名, 组件类型键]） */
  __tveComponentKeys?: [string, string][];
  /** @nodeType 登记的节点类型（kind/label） */
  __tveNodeType?: { kind: string; label: string };
};

/** 组件门面类构造器视图（__tveComponentType 由 component-registry 挂载） */
type ComponentFacadeCtor = Function & {
  __tveComponentType?: unknown;
};

/** @property 装饰器工厂选项（type 选项为节点类/组件门面类/属性类型字符串） */
interface PropertyOptions {
  type?: unknown;
  [key: string]: unknown;
}

class ComponentImpl {
  /** 宿主实体句柄（构造注入；declare 纯类型声明，不产生运行时字段定义） */
  declare entity: Entity;
  constructor(entity: Entity) {
    this.entity = entity;
  }
}

/** 把字段名登记到类的 __tvePropKeys（host 合并默认值与节点配置用） */
function recordPropKey(ctor: TveMetaCtor, key: string): void {
  const list = ctor.__tvePropKeys;
  if (Array.isArray(list)) {
    if (!list.includes(key)) list.push(key);
  } else {
    Object.defineProperty(ctor, "__tvePropKeys", {
      value: [key],
      configurable: true,
      writable: true,
    });
  }
}

/** 把实体引用键名记入类 __tveEntityKeys（host 将节点配置 id 解析为 Entity） */
function recordEntityKey(ctor: TveMetaCtor, key: string): void {
  const list = ctor.__tveEntityKeys;
  if (Array.isArray(list)) {
    if (!list.includes(key)) list.push(key);
  } else {
    Object.defineProperty(ctor, "__tveEntityKeys", {
      value: [key],
      configurable: true,
      writable: true,
    });
  }
}

/** 把组件引用键名记入类 __tveComponentKeys */
function recordComponentKey(ctor: TveMetaCtor, key: string, typeKey: string): void {
  const list = ctor.__tveComponentKeys;
  if (Array.isArray(list)) {
    if (!list.some((e) => e[0] === key)) list.push([key, typeKey]);
  } else {
    Object.defineProperty(ctor, "__tveComponentKeys", {
      value: [[key, typeKey]],
      configurable: true,
      writable: true,
    });
  }
}

/** 值是否为组件门面类（返回组件类型键；否则 null） */
function componentTypeKeyOfOption(v: unknown): string | null {
  if (typeof v === "function" && typeof (v as ComponentFacadeCtor).__tveComponentType === "string") {
    // typeof 守卫已确认值为 string；此处仅消除元数据字段的 unknown 视图
    const key = (v as ComponentFacadeCtor).__tveComponentType as string;
    return BUILTIN_TYPE_KEYS.includes(key) ? key : null;
  }
  return null;
}

/**
 * @property 装饰器（双形态：裸调用 / 工厂调用）。
 * maybeKey 可选由双形态决定：裸调用（@property field）带 key，工厂调用（@property(opts)）
 * 只带 options —— 与 TS 装饰器协议一致，非运行时形状变更。
 */
export function property(
  targetOrOptions: unknown,
  maybeKey?: string,
): ((target: object, key: string) => void) | undefined {
  if (arguments.length >= 2) {
    // 裸调用：targetOrOptions 为类原型/构造器（元数据宿主视图），maybeKey 为字段名
    const t = targetOrOptions as TveMetaCtor | null | undefined;
    const ctor = (typeof t === "function" ? t : t && (t as object).constructor) as TveMetaCtor | undefined;
    if (typeof ctor === "function" && typeof maybeKey === "string") {
      recordPropKey(ctor, maybeKey);
    }
    return undefined;
  }
  const options = targetOrOptions as PropertyOptions | null | undefined;
  const optType = options && typeof options === "object" ? options.type : undefined;
  const nodeRef = isNodeRefType(optType);
  const compType =
    componentTypeKeyOfOption(optType) ?? componentTypeKeyOfOption(targetOrOptions);
  return function decorate(target: object, key: string): void {
    // target = 类原型（实例字段）或构造器（静态字段）；统一按元数据宿主视图读取
    const ctor = (typeof target === "function" ? target : target.constructor) as TveMetaCtor;
    if (compType) {
      recordComponentKey(ctor, key, compType);
      return;
    }
    recordPropKey(ctor, key);
    if (nodeRef) recordEntityKey(ctor, key);
  };
}

/** @nodeType(options) 类装饰器：登记脚本类为可创建节点类型（kind/label） */
export function nodeType(options: { kind?: unknown; label?: unknown } | null | undefined) {
  const kind =
    options && typeof options.kind === "string" && options.kind ? options.kind : "node";
  const label =
    options && typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "";
  return function decorate(ctor: TveMetaCtor): TveMetaCtor {
    ctor.__tveNodeType = { kind, label };
    return ctor;
  };
}

export { ComponentImpl as Component };
