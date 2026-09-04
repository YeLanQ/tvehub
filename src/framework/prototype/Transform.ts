import { nextId } from "../../platform_abstraction/id";
import { Prototype } from "./Prototype";
import { cloneVec3, vec3, type Euler, type JsonRecord, type Vec3, type JsonValue } from "./types";

export interface TransformInit {
  position?: Vec3;
  rotation?: Euler;
  scale?: Vec3;
}

/**
 * 基元原型 B：变换原型。
 * 保存一个节点的空间变换信息（位置 / 旋转 / 缩放）。
 * 所有派生原型若需要额外变换语义，均继承本类扩展。
 */
export class Transform extends Prototype {
  static readonly kType: string = "transform";
  readonly typeKey: string = Transform.kType;

  position: Vec3;
  rotation: Euler;
  scale: Vec3;

  constructor(init: TransformInit = {}) {
    super();
    this.position = cloneVec3(init.position ?? vec3());
    this.rotation = cloneVec3(init.rotation ?? vec3());
    this.scale = cloneVec3(init.scale ?? vec3(1, 1, 1));
  }

  /** 原型模式：深拷贝出一个独立的变换模板 */
  clone(): Transform {
    return new Transform({
      position: cloneVec3(this.position),
      rotation: cloneVec3(this.rotation),
      scale: cloneVec3(this.scale),
    });
  }

  setPosition(x: number, y: number, z: number): void {
    this.position = { x, y, z };
  }

  setRotation(x: number, y: number, z: number): void {
    this.rotation = { x, y, z };
  }

  setScale(x: number, y: number, z: number): void {
    this.scale = { x, y, z };
  }

  copyFrom(other: Transform): void {
    this.position = cloneVec3(other.position);
    this.rotation = cloneVec3(other.rotation);
    this.scale = cloneVec3(other.scale);
  }

  equals(other: Transform): boolean {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    return (
      near(this.position.x, other.position.x) &&
      near(this.position.y, other.position.y) &&
      near(this.position.z, other.position.z) &&
      near(this.rotation.x, other.rotation.x) &&
      near(this.rotation.y, other.rotation.y) &&
      near(this.rotation.z, other.rotation.z) &&
      near(this.scale.x, other.scale.x) &&
      near(this.scale.y, other.scale.y) &&
      near(this.scale.z, other.scale.z)
    );
  }

  toJSON(): JsonValue {
    const record: JsonRecord = {
      type: this.typeKey,
      position: { ...this.position },
      rotation: { ...this.rotation },
      scale: { ...this.scale },
    };
    return record;
  }

  static fromJSON(json: JsonRecord): Transform {
    const position = (json.position as unknown as Vec3) ?? vec3();
    const rotation = (json.rotation as unknown as Euler) ?? vec3();
    const scale = (json.scale as unknown as Vec3) ?? vec3(1, 1, 1);
    return new Transform({ position, rotation, scale });
  }
}

/**
 * 派生自变换基元的示例：带锚点的变换。
 * 说明"所有原型都可以从 Transform 基元派生扩展"。
 */
export class AnchoredTransform extends Transform {
  static override readonly kType: string = "anchoredTransform";
  override readonly typeKey: string = AnchoredTransform.kType;
  anchor: Vec3;

  constructor(init: TransformInit & { anchor?: Vec3 } = {}) {
    super(init);
    this.anchor = cloneVec3(init.anchor ?? vec3());
  }

  override clone(): AnchoredTransform {
    return new AnchoredTransform({
      position: cloneVec3(this.position),
      rotation: cloneVec3(this.rotation),
      scale: cloneVec3(this.scale),
      anchor: cloneVec3(this.anchor),
    });
  }

  override toJSON(): JsonValue {
    const base = super.toJSON() as JsonRecord;
    base.type = this.typeKey;
    base.anchor = { ...this.anchor };
    return base;
  }
}

export function createDefaultTransformId(): string {
  return nextId("transform");
}
