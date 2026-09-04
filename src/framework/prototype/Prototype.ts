import type { JsonValue } from "./types";

/**
 * 所有原型的根基类。
 * 原型保存节点信息，可被 clone 派生出新的模板实例。
 */
export abstract class Prototype {
  /** 原型唯一类型标识，工厂据此注册与派生 */
  abstract readonly typeKey: string;

  /** 原型模式核心：以自身为模板克隆出一份等价的独立实例 */
  abstract clone(): Prototype;

  /** 序列化为可持久化的纯数据 */
  abstract toJSON(): JsonValue;
}