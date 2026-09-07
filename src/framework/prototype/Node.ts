import { nextId } from "../../platform_abstraction/id";
import { Prototype } from "./Prototype";
import { Transform } from "./Transform";
import { cloneRecord, type JsonRecord, type JsonValue } from "./types";
import {
  cloneColliderSettings,
  cloneRigidBodySettings,
  parseColliderSettings,
  parseRigidBodySettings,
} from "../physics/types";

/**
 * 节点上的脚本组件引用（组件模式）。
 * 编辑器只持有数据（检查器增删改、随节点序列化）；实例化与生命周期由
 * 播放器脚本宿主（web-preview/libs/scripts.mjs）在预览/发布产物中执行。
 */
export interface ScriptComponentRef {
  /** 组件实例 id（同节点内唯一） */
  id: string;
  /** 组件类型 */
  type: "script";
  /** 脚本源路径（项目内相对路径，如 "src/spin.ts"） */
  script: string;
  /** 是否启用（禁用的组件不参与运行） */
  enabled: boolean;
  /** 属性值（检查器按脚本 static props 声明渲染编辑） */
  props: JsonRecord;
}

/**
 * 刚体组件引用：声明节点的运动学形态（static/kinematic/dynamic）。
 * 数据随节点序列化；模拟由物理系统在预览/播放时驱动（编辑态只同步数据）。
 */
export interface RigidBodyComponentRef {
  id: string;
  type: "rigidBody";
  enabled: boolean;
  rigidBody: import("../physics/types").RigidBodySettings;
}

/**
 * 碰撞体组件引用：声明节点的碰撞形状与表面材质。
 * 同节点可挂多个碰撞体（复合形状）；无刚体只有碰撞体 = 隐式静态碰撞体。
 */
export interface ColliderComponentRef {
  id: string;
  type: "collider";
  enabled: boolean;
  collider: import("../physics/types").ColliderSettings;
}

/** 节点组件引用（可辨识联合，按 type 收敛） */
export type NodeComponentRef = ScriptComponentRef | RigidBodyComponentRef | ColliderComponentRef;

export function isScriptComponent(c: NodeComponentRef): c is ScriptComponentRef {
  return c.type === "script";
}
export function isRigidBodyComponent(c: NodeComponentRef): c is RigidBodyComponentRef {
  return c.type === "rigidBody";
}
export function isColliderComponent(c: NodeComponentRef): c is ColliderComponentRef {
  return c.type === "collider";
}

/** 组件引用 JSON 收敛（非法项剔除；各类型字段缺失回退默认） */
export function parseNodeComponents(value: unknown): NodeComponentRef[] {
  if (!Array.isArray(value)) return [];
  const out: NodeComponentRef[] = [];
  for (const c of value) {
    if (!c || typeof c !== "object") continue;
    const rec = c as JsonRecord;
    const id = typeof rec.id === "string" && rec.id ? rec.id : nextId("comp");
    const enabled = rec.enabled !== false;
    // 未知 type（旧数据只有 script 无 type 字段）按 script 收敛
    const type = typeof rec.type === "string" ? rec.type : "script";
    if (type === "rigidBody") {
      out.push({ id, type: "rigidBody", enabled, rigidBody: parseRigidBodySettings(rec.rigidBody) });
    } else if (type === "collider") {
      out.push({ id, type: "collider", enabled, collider: parseColliderSettings(rec.collider) });
    } else {
      if (typeof rec.script !== "string" || !rec.script) continue;
      out.push({
        id,
        type: "script",
        script: rec.script,
        enabled,
        props: rec.props && typeof rec.props === "object" ? cloneRecord(rec.props as JsonRecord) : {},
      });
    }
  }
  return out;
}

/** 组件引用深拷贝（id 重新生成，避免克隆节点后实例 id 重复） */
function cloneNodeComponents(list: NodeComponentRef[]): NodeComponentRef[] {
  return list.map((c) => {
    const id = nextId("comp");
    if (c.type === "rigidBody") return { ...c, id, rigidBody: cloneRigidBodySettings(c.rigidBody) };
    if (c.type === "collider") return { ...c, id, collider: cloneColliderSettings(c.collider) };
    return { ...c, id, props: cloneRecord(c.props) };
  });
}

/** 组件引用深拷贝（保留 id；序列化用） */
function cloneComponentForWrite(c: NodeComponentRef): NodeComponentRef {
  if (c.type === "rigidBody") return { ...c, rigidBody: cloneRigidBodySettings(c.rigidBody) };
  if (c.type === "collider") return { ...c, collider: cloneColliderSettings(c.collider) };
  return { ...c, props: cloneRecord(c.props) };
}

export interface NodeInit {
  id?: string;
  name?: string;
  parentId?: string | null;
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
export class Node extends Prototype {
  static readonly kType: string = "node";
  readonly typeKey: string = Node.kType;


  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  active: boolean;
  visible: boolean;
  /** 组合的变换基元原型 */
  transform: Transform;
  /** 编辑器扩展的任意属性槽 */
  properties: JsonRecord;
  /** 脚本组件引用列表（组件模式；编辑态纯数据，运行期由播放器执行） */
  components: NodeComponentRef[];

  constructor(init: NodeInit = {}) {
    super();
    this.id = init.id ?? nextId(this.typeKey);
    this.name = init.name ?? "Node";
    this.parentId = init.parentId ?? null;
    this.childIds = [];
    this.active = true;
    this.visible = true;
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
      transform: this.transform.clone(),
      properties: cloneRecord(this.properties),
      components: this.components,
    });
  }

  get isRoot(): boolean {
    return this.parentId === null;
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
    // 组件列表非空才写入（旧场景文件保持字节兼容）
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

