import { nextId } from "../../platform_abstraction/id";
import { clampLayerIndex } from "../layers";
import { Prototype } from "./Prototype";
import { Transform } from "./Transform";
import type { INode } from "./interfaces";
import { cloneRecord, type JsonRecord, type JsonValue } from "./types";
import {
  cloneComponentForWrite,
  cloneNodeComponents,
  parseNodeComponents,
  type NodeComponentRef,
} from "./components";

// 组件契约与解析/克隆/写出（曾内联于本文件）已收敛到 components/ ——
// 每种组件一个描述符模块实现 ComponentDescriptor 接口，公共链路查表派发。
// 这里整体再导出，保持既有导入点（检查器、物理/音频系统、冒烟测试等）不变。
export type {
  AnimClipBinding,
  AnimationClipComponentRef,
  AudioSourceComponentRef,
  ColliderComponentRef,
  ComponentCreateOptions,
  ComponentDescriptor,
  ComponentType,
  INodeComponent,
  LightComponentRef,
  NodeComponentRef,
  RigidBodyComponentRef,
  ScriptComponentRef,
} from "./components";
export {
  isAnimationClipComponent,
  isAudioSourceComponent,
  isColliderComponent,
  isLightComponent,
  isRigidBodyComponent,
  isScriptComponent,
  parseAnimClipBinding,
  parseNodeComponents,
} from "./components";

export interface NodeInit {
  id?: string;
  name?: string;
  parentId?: string | null;
  /** 节点标签（脚本按标签查找实体；空串 = 无标签） */
  tag?: string;
  /** 渲染层级索引（0~31；0 = 内置 Default；相机/灯光按 cullingMask 筛选） */
  layer?: number;
  /** 实例来源的预制体资产引用（.prefab 相对路径；空串 = 非预制体实例） */
  prefab?: string;
  transform?: Transform;
  properties?: JsonRecord;
  components?: NodeComponentRef[];
}

/**
 * 基元原型 A：节点原型。
 * 保存一个原型的"节点信息"：标识、层级、可见性与自定义属性。
 * 每个节点内聚一个 Transform 基元实例，用于组合式扩展。
 * 后续所有原型均从本类派生（见 derived/）。
 */
export class Node extends Prototype implements INode {
  static readonly kType: string = "node";
  readonly typeKey: string = Node.kType;


  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  active: boolean;
  visible: boolean;
  /** 节点标签（播放器 SDK 经 entity.tag / findByTag 查询） */
  tag: string;
  /** 渲染层级索引（0~31，0 = 内置 Default；three 侧为 object.layers） */
  layer: number;
  /** 实例来源的预制体资产引用（.prefab 相对路径；空串 = 非预制体实例） */
  prefab: string;
  /** 组合的变换基元原型 */
  transform: Transform;
  /** 编辑器扩展的任意属性槽 */
  properties: JsonRecord;
  /** 组件引用列表（组件模式；编辑态纯数据，运行期由播放器执行） */
  components: NodeComponentRef[];

  constructor(init: NodeInit = {}) {
    super();
    this.id = init.id ?? nextId(this.typeKey);
    this.name = init.name ?? "Node";
    this.parentId = init.parentId ?? null;
    this.childIds = [];
    this.active = true;
    this.visible = true;
    this.tag = init.tag ?? "";
    this.layer = clampLayerIndex(init.layer);
    this.prefab = init.prefab ?? "";
    this.transform = init.transform ? init.transform.clone() : new Transform();
    this.properties = { ...(init.properties ?? {}) };
    this.components = init.components ? cloneNodeComponents(init.components) : [];
  }

  /** 原型模式：克隆节点信息 + 内聚的变换模板 */
  clone(): Node {
    return new Node({
      id: nextId(this.typeKey),
      name: this.name,
      parentId: null,
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      transform: this.transform.clone(),
      properties: cloneRecord(this.properties),
      components: this.components,
    });
  }

  get isRoot(): boolean {
    return this.parentId === null;
  }

  /**
   * 节点在层级中是否**实际渲染**（也即是否是可被视口点选的对象）：
   * 自身与全部祖先都必须「可见（visible）且激活（active）」。
   * 依据：渲染时 three 侧 obj.visible = node.visible && node.active，且父级隐藏会连子级
   * 一起隐藏 —— 所以"看不见的东西点不到"，隐藏父级下的子级同样不可选中。
   * lookup：节点 id → 节点（编辑器传图镜像 SceneClient.get）。
   */
  isEffectivelyVisibleIn(lookup: (id: string) => Node | undefined): boolean {
    let cur: Node | undefined = this;
    while (cur) {
      if (!cur.visible || !cur.active) return false;
      cur = cur.parentId ? lookup(cur.parentId) : undefined;
    }
    return true;
  }

  addChildId(id: string): void {
    if (!this.childIds.includes(id)) this.childIds.push(id);
  }

  removeChildId(id: string): void {
    this.childIds = this.childIds.filter((c) => c !== id);
  }

  setProperty(key: string, value: JsonValue): void {
    this.properties[key] = value;
  }

  getProperty<T extends JsonValue = JsonValue>(key: string): T | undefined {
    return this.properties[key] as T;
  }

  /** 派生类可覆写本钩子，补充自身特有字段 */
  protected writeOwnData(target: Record<string, unknown>): void {
    void target;
  }

  protected readOwnData(source: Record<string, unknown>): void {
    void source;
  }


  toJSON(): JsonValue {
    const record: JsonRecord = {
      type: this.typeKey,
      id: this.id,
      name: this.name,
      parentId: this.parentId,
      childIds: [...this.childIds],
      active: this.active,
      visible: this.visible,
      transform: this.transform.toJSON(),
      properties: cloneRecord(this.properties),
    };
    // 标签非空才写入（旧场景文件保持字节兼容）
    if (this.tag) record.tag = this.tag;
    // 层非 0 才写入（0 = 内置 Default，缺字段即默认；旧场景文件保持字节兼容）
    if (this.layer !== 0) record.layer = this.layer;
    // 预制体引用非空才写入（仅预制体实例携带）
    if (this.prefab) record.prefab = this.prefab;
    // 组件列表非空才写入（旧场景文件保持字节兼容；写出约定见各组件描述符）
    if (this.components.length) {
      record.components = this.components.map(
        (c) => cloneComponentForWrite(c) as unknown as JsonRecord,
      );
    }
    this.writeOwnData(record);
    return record;
  }

  applyJSON(json: Record<string, unknown>): void {
    this.id = (json.id as string) ?? this.id;
    this.name = (json.name as string) ?? this.name;
    this.parentId = (json.parentId as string | null) ?? null;
    this.childIds = Array.isArray(json.childIds) ? [...(json.childIds as string[])] : [];
    this.active = (json.active as boolean) ?? this.active;
    this.visible = (json.visible as boolean) ?? this.visible;
    this.tag = typeof json.tag === "string" ? json.tag : "";
    this.layer = clampLayerIndex(json.layer);
    this.prefab = typeof json.prefab === "string" ? json.prefab : "";
    if (json.transform) {
      this.transform = Transform.fromJSON(json.transform as JsonRecord);
    }
    this.properties = json.properties ? cloneRecord(json.properties as JsonRecord) : {};
    this.components = parseNodeComponents(json.components);
    this.readOwnData(json);
  }

  static fromJSON(json: JsonRecord): Node {
    const transform = json.transform
      ? Transform.fromJSON(json.transform as JsonRecord)
      : new Transform();
    const node = new Node({ transform });
    node.applyJSON(json);
    return node;
  }
}

export interface RegisteredNodeTypes {
  register(type: string, factory: () => Node): void;
}
