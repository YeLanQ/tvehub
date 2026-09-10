// ---------------------------------------------------------------------------
// 原型层接口契约：每个基类各自的接口设计。
//
// Prototype（原型根基类）/ Transform（变换基元）/ Node（节点基类）的公开
// 形状在此收敛为接口；类声明 implements 各自接口，消费方（场景容器、同步器、
// 播放器重建等）按接口依赖而非具体类。派生节点（相机/网格/灯光/天空盒/音源）
// 的能力接口与各自类同文件声明（见 nodes/*.ts）。
// ---------------------------------------------------------------------------

import type { JsonRecord, JsonValue, Vec3 } from "./types";
import type { NodeComponentRef } from "./components/types";
import type { Transform } from "./Transform";

/**
 * 原型根基类接口：类型标识 + 克隆 + 序列化。
 * 原型保存节点信息，可被 clone 派生出新的模板实例。
 */
export interface IPrototype {
  /** 原型唯一类型标识，工厂据此注册与派生 */
  readonly typeKey: string;
  /** 原型模式核心：以自身为模板克隆出一份等价的独立实例 */
  clone(): IPrototype;
  /** 序列化为可持久化的纯数据 */
  toJSON(): JsonValue;
}

/**
 * 变换基元接口：节点的空间变换信息（位置 / 旋转 / 缩放）。
 * 旋转型 Vec3 使用"度"为单位（模型存度，渲染端转弧度）。
 */
export interface ITransform extends IPrototype {
  position: Vec3;
  /** Euler rotation in degrees (stored in the model; radians are used at the renderer). */
  rotation: Vec3;
  scale: Vec3;
  setPosition(x: number, y: number, z: number): void;
  /** Sets rotation from Euler angles in degrees. */
  setRotation(x: number, y: number, z: number): void;
  setScale(x: number, y: number, z: number): void;
  copyFrom(other: Transform): void;
  equals(other: Transform): boolean;
}

/**
 * 节点基类接口：标识、层级、可见性与自定义属性 + 内聚的变换基元与组件列表。
 * 每个节点内聚一个 Transform 基元实例，用于组合式扩展；后续所有原型均从
 * Node 派生（见 nodes/）。
 */
export interface INode extends IPrototype {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  active: boolean;
  visible: boolean;
  /** 节点标签（播放器 SDK 经 entity.tag / findByTag 查询） */
  tag: string;
  /** 实例来源的预制体资产引用（.prefab 相对路径；空串 = 非预制体实例） */
  prefab: string;
  /** 组合的变换基元原型 */
  transform: Transform;
  /** 编辑器扩展的任意属性槽 */
  properties: JsonRecord;
  /** 组件引用列表（组件模式；编辑态纯数据，运行期由播放器执行） */
  components: NodeComponentRef[];
  readonly isRoot: boolean;
  addChildId(id: string): void;
  removeChildId(id: string): void;
  setProperty(key: string, value: JsonValue): void;
  getProperty<T extends JsonValue = JsonValue>(key: string): T | undefined;
}
