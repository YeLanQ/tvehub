import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";
import {
  clampCameraParam,
  parseCameraKind,
  parseCameraClearFlags,
  DEFAULT_CAMERA_CLEAR_FLAGS,
  type CameraClearFlags,
  type CameraKind,
} from "../../camera";

export interface CameraNodeInit extends NodeInit {
  cameraType?: CameraKind;
  fov?: number;
  near?: number;
  far?: number;
  /** 正交半高（取景高度的一半，世界单位；仅 cameraType=orthographic 生效） */
  orthoSize?: number;
  /** 清除标志（渲染每帧开始时如何清屏；缺省天空盒） */
  clearFlags?: CameraClearFlags;
  /** 纯色清屏色（clearFlags=solidColor 生效；0xRRGGBB） */
  clearColor?: number;
  isEditorCamera?: boolean;
}

export class CameraNode extends Node {
  static override readonly kType: string = "cameraNode";
  override readonly typeKey = CameraNode.kType;
  /** 相机类型：透视（默认，fov 取景）/ 正交（orthoSize 取景）；类型定义见 framework/camera */
  cameraType: CameraKind = "perspective";
  fov = 50;
  /** 近裁剪面（最小值 0.01） */
  near = 0.1;
  /** 远裁剪面（默认 20，最小值 1） */
  far = 20;
  /** 正交半高（取景高度的一半，世界单位；最小值 0.01；仅正交相机生效） */
  orthoSize = 5;
  /** 清除标志：skybox（默认）/ solidColor / depthOnly / colorOnly */
  clearFlags: CameraClearFlags = DEFAULT_CAMERA_CLEAR_FLAGS;
  /** 纯色清屏色（clearFlags=solidColor 时的背景；0xRRGGBB） */
  clearColor = 0x000000;
  isEditorCamera = false;

  constructor(init: CameraNodeInit = {}) {
    super(init);
    this.cameraType = init.cameraType ?? this.cameraType;
    this.fov = init.fov ?? this.fov;
    this.near = Math.max(0.01, init.near ?? this.near);
    this.far = Math.max(1, init.far ?? this.far);
    this.orthoSize = clampCameraParam("orthoSize", init.orthoSize ?? this.orthoSize);
    this.clearFlags = parseCameraClearFlags(init.clearFlags ?? this.clearFlags);
    this.clearColor = (init.clearColor ?? this.clearColor) & 0xffffff;
    this.isEditorCamera = init.isEditorCamera ?? this.isEditorCamera;
  }

  override clone(): CameraNode {
    return new CameraNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      prefab: this.prefab,
      components: this.components,
      cameraType: this.cameraType,
      fov: this.fov,
      near: this.near,
      far: this.far,
      orthoSize: this.orthoSize,
      clearFlags: this.clearFlags,
      clearColor: this.clearColor,
      isEditorCamera: this.isEditorCamera,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.cameraType = this.cameraType;
    target.fov = this.fov;
    target.near = this.near;
    target.far = this.far;
    target.orthoSize = this.orthoSize;
    target.clearFlags = this.clearFlags;
    target.clearColor = this.clearColor;
    target.isEditorCamera = this.isEditorCamera;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.cameraType = parseCameraKind(source.cameraType);
    this.fov = clampCameraParam("fov", (source.fov as number) ?? this.fov);
    this.near = Math.max(0.01, (source.near as number) ?? this.near);
    this.far = Math.max(1, (source.far as number) ?? this.far);
    this.orthoSize = clampCameraParam(
      "orthoSize",
      (source.orthoSize as number) ?? this.orthoSize,
    );
    this.clearFlags = parseCameraClearFlags(source.clearFlags);
    this.clearColor = ((source.clearColor as number) ?? this.clearColor) & 0xffffff;
    this.isEditorCamera = (source.isEditorCamera as boolean) ?? this.isEditorCamera;
  }

  static fromJSON(json: Record<string, unknown>): CameraNode {
    const node = new CameraNode();
    node.applyJSON(json);
    return node;
  }
}
