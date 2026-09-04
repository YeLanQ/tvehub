import { Node, type NodeInit } from "../Node";
import { cloneRecord, vec3, type Vec3 } from "../types";

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

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.geometry = this.geometry;
    target.size = { ...this.size };
    target.color = this.color;
    target.metalness = this.metalness;
    target.roughness = this.roughness;
    target.emissive = this.emissive;
    target.wireframe = this.wireframe;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.geometry = (source.geometry as GeometryKind) ?? this.geometry;
    this.size = (source.size as Vec3) ?? this.size;
    this.color = (source.color as number) ?? this.color;
    this.metalness = (source.metalness as number) ?? this.metalness;
    this.roughness = (source.roughness as number) ?? this.roughness;
    this.emissive = (source.emissive as number) ?? this.emissive;
    this.wireframe = (source.wireframe as boolean) ?? this.wireframe;
  }

  static fromJSON(json: Record<string, unknown>): MeshNode {
    const node = new MeshNode();
    node.applyJSON(json);
    return node;
  }
}