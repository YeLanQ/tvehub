import { Node, type NodeInit } from "../Node";
import { cloneRecord, vec3, type Euler, type JsonRecord, type Vec3 } from "../types";

export type GeometryKind = "box" | "sphere" | "plane" | "cylinder";

export interface MeshNodeInit extends NodeInit {
  geometry?: GeometryKind;
  size?: Vec3;
  color?: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  wireframe?: boolean;
}

/**
 * 派生原型：网格节点。
 * 从基元 Node 派生，扩展渲染相关的自有字段。
 */
export class MeshNode extends Node {
  static override readonly kType: string = "meshNode";
  override readonly typeKey: string = MeshNode.kType;
  geometry: GeometryKind = "box";
  size: Vec3 = vec3(1, 1, 1);
  color = 0x9aa4b2;
  metalness = 0.1;
  roughness = 0.75;
  emissive = 0x000000;
  wireframe = false;

  constructor(init: MeshNodeInit = {}) {
    super(init);
    this.geometry = init.geometry ?? this.geometry;
    this.size = init.size ? { ...init.size } : this.size;
    this.color = init.color ?? this.color;
    this.metalness = init.metalness ?? this.metalness;
    this.roughness = init.roughness ?? this.roughness;
    this.emissive = init.emissive ?? this.emissive;
    this.wireframe = init.wireframe ?? this.wireframe;
  }

  override clone(): MeshNode {
    return new MeshNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      geometry: this.geometry,
      size: this.size,
      color: this.color,
      metalness: this.metalness,
      roughness: this.roughness,
      emissive: this.emissive,
      wireframe: this.wireframe,
    });
  }

  protected override writeOwnData(target: JsonRecord): void {
    target.geometry = this.geometry;
    target.size = { ...this.size };
    target.color = this.color;
    target.metalness = this.metalness;
    target.roughness = this.roughness;
    target.emissive = this.emissive;
    target.wireframe = this.wireframe;
  }

  protected override readOwnData(source: JsonRecord): void {
    this.geometry = (source.geometry as unknown as GeometryKind) ?? this.geometry;
    this.size = (source.size as unknown as Vec3) ?? this.size;
    this.color = (source.color as number) ?? this.color;
    this.metalness = (source.metalness as number) ?? this.metalness;
    this.roughness = (source.roughness as number) ?? this.roughness;
    this.emissive = (source.emissive as number) ?? this.emissive;
    this.wireframe = (source.wireframe as boolean) ?? this.wireframe;
  }

  static fromJSON(json: JsonRecord): MeshNode {
    const node = new MeshNode();
    node.applyJSON(json);
    return node;
  }
}

export interface LightNodeInit extends NodeInit {
  lightKind?: "point" | "directional" | "ambient";
  intensity?: number;
  lightColor?: number;
  positionHint?: Vec3;
  castShadow?: boolean;
}

/**
 * 派生原型：光源节点。
 */
export class LightNode extends Node {
  static override readonly kType: string = "lightNode";
  override readonly typeKey: string = LightNode.kType;
  lightKind: "point" | "directional" | "ambient" = "point";
  intensity = 1;
  lightColor = 0xffffff;
  positionHint: Vec3 = vec3(5, 5, 5);
  castShadow = false;

  constructor(init: LightNodeInit = {}) {
    super(init);
    this.lightKind = init.lightKind ?? this.lightKind;
    this.intensity = init.intensity ?? this.intensity;
    this.lightColor = init.lightColor ?? this.lightColor;
    if (init.positionHint) this.positionHint = { ...init.positionHint };
    this.castShadow = init.castShadow ?? this.castShadow;
  }

  override clone(): LightNode {
    return new LightNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      lightKind: this.lightKind,
      intensity: this.intensity,
      lightColor: this.lightColor,
      positionHint: this.positionHint,
      castShadow: this.castShadow,
    });
  }

  protected override writeOwnData(target: JsonRecord): void {
    target.lightKind = this.lightKind;
    target.intensity = this.intensity;
    target.lightColor = this.lightColor;
    target.positionHint = { ...this.positionHint };
    target.castShadow = this.castShadow;
  }

  protected override readOwnData(source: JsonRecord): void {
    this.lightKind = (source.lightKind as LightNode["lightKind"]) ?? this.lightKind;
    this.intensity = (source.intensity as number) ?? this.intensity;
    this.lightColor = (source.lightColor as number) ?? this.lightColor;
    this.positionHint = (source.positionHint as unknown as Vec3) ?? this.positionHint;
    this.castShadow = (source.castShadow as boolean) ?? this.castShadow;
  }

  static fromJSON(json: JsonRecord): LightNode {
    const node = new LightNode();
    node.applyJSON(json);
    return node;
  }
}

export interface CameraNodeInit extends NodeInit {
  fov?: number;
  near?: number;
  far?: number;
  isEditorCamera?: boolean;
}

/**
 * 派生原型：相机节点。
 * 其位置 / 旋转语义仍由内聚的 Transform 基元承担（派生复用）。
 */
export class CameraNode extends Node {
  static override readonly kType: string = "cameraNode";
  override readonly typeKey = CameraNode.kType;
  fov = 50;
  near = 0.1;
  far = 2000;
  isEditorCamera = false;

  constructor(init: CameraNodeInit = {}) {
    super(init);
    this.fov = init.fov ?? this.fov;
    this.near = init.near ?? this.near;
    this.far = init.far ?? this.far;
    this.isEditorCamera = init.isEditorCamera ?? this.isEditorCamera;
  }

  override clone(): CameraNode {
    return new CameraNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      fov: this.fov,
      near: this.near,
      far: this.far,
      isEditorCamera: this.isEditorCamera,
    });
  }

  protected override writeOwnData(target: JsonRecord): void {
    target.fov = this.fov;
    target.near = this.near;
    target.far = this.far;
    target.isEditorCamera = this.isEditorCamera;
  }

  protected override readOwnData(source: JsonRecord): void {
    this.fov = (source.fov as number) ?? this.fov;
    this.near = (source.near as number) ?? this.near;
    this.far = (source.far as number) ?? this.far;
    this.isEditorCamera = (source.isEditorCamera as boolean) ?? this.isEditorCamera;
  }

  static fromJSON(json: JsonRecord): CameraNode {
    const node = new CameraNode();
    node.applyJSON(json);
    return node;
  }
}

export type { Euler };

