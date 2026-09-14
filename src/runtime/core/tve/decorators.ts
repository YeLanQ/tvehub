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

class ComponentImpl {
  constructor(entity) {
    this.entity = entity;
  }
}

/** 把字段名登记到类的 __tvePropKeys（host 合并默认值与节点配置用） */
function recordPropKey(ctor, key) {
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
function recordEntityKey(ctor, key) {
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
function recordComponentKey(ctor, key, typeKey) {
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
function componentTypeKeyOfOption(v) {
  if (typeof v === "function" && typeof v.__tveComponentType === "string") {
    return BUILTIN_TYPE_KEYS.includes(v.__tveComponentType) ? v.__tveComponentType : null;
  }
  return null;
}

/** @property 装饰器（双形态：裸调用 / 工厂调用） */
export function property(targetOrOptions, maybeKey) {
  if (arguments.length >= 2) {
    const t = targetOrOptions;
    const ctor = typeof t === "function" ? t : t && t.constructor;
    if (typeof ctor === "function" && typeof maybeKey === "string") {
      recordPropKey(ctor, maybeKey);
    }
    return undefined;
  }
  const optType =
    targetOrOptions && typeof targetOrOptions === "object" ? targetOrOptions.type : undefined;
  const nodeRef = isNodeRefType(optType);
  const compType =
    componentTypeKeyOfOption(optType) ?? componentTypeKeyOfOption(targetOrOptions);
  return function decorate(target, key) {
    const ctor = typeof target === "function" ? target : target.constructor;
    if (compType) {
      recordComponentKey(ctor, key, compType);
      return;
    }
    recordPropKey(ctor, key);
    if (nodeRef) recordEntityKey(ctor, key);
  };
}

/** @nodeType(options) 类装饰器：登记脚本类为可创建节点类型（kind/label） */
export function nodeType(options) {
  const kind =
    options && typeof options.kind === "string" && options.kind ? options.kind : "node";
  const label =
    options && typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "";
  return function decorate(ctor) {
    ctor.__tveNodeType = { kind, label };
    return ctor;
  };
}

export { ComponentImpl as Component };