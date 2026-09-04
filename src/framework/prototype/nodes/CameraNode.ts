import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";

export interface CameraNodeInit extends NodeInit {
  fov?: number;
  near?: number;
  far?: number;
  isEditorCamera?: boolean;
}

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

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.fov = this.fov;
    target.near = this.near;
    target.far = this.far;
    target.isEditorCamera = this.isEditorCamera;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.fov = (source.fov as number) ?? this.fov;
    this.near = (source.near as number) ?? this.near;
    this.far = (source.far as number) ?? this.far;
    this.isEditorCamera = (source.isEditorCamera as boolean) ?? this.isEditorCamera;
  }

  static fromJSON(json: Record<string, unknown>): CameraNode {
    const node = new CameraNode();
    node.applyJSON(json);
    return node;
  }
}