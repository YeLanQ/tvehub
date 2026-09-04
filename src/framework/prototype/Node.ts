import { nextId } from "../../platform_abstraction/id";
import { Prototype } from "./Prototype";
import { Transform } from "./Transform";
import { cloneRecord, type JsonRecord, type JsonValue } from "./types";

export interface NodeInit {
  id?: string;
  name?: string;
  parentId?: string | null;
  transform?: Transform;
  properties?: JsonRecord;
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
  }

  /** 原型模式：克隆节点信息 + 内聚的变换模板 */
  clone(): Node {
    return new Node({
      id: nextId(this.typeKey),
      name: this.name,
      parentId: null,
      transform: this.transform.clone(),
      properties: cloneRecord(this.properties),
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
  protected writeOwnData(target: JsonRecord): void {
    void target;
  }

  protected readOwnData(source: JsonRecord): void {
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
    this.writeOwnData(record);
    return record;
  }

  applyJSON(json: JsonRecord): void {
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

