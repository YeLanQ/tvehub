import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import {
  clampCameraParam,
  parseCameraKind,
  parseCameraClearFlags,
  DEFAULT_CAMERA_CLEAR_FLAGS,
  type CameraClearFlags,
  type CameraKind,
} from "../../camera";
import { ALL_LAYERS_MASK, parseCullingMask } from "../../layers";

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
  /** 渲染层级掩码（Culling Mask 语义：只渲染掩码内层的对象；-1 = 全部） */
  cullingMask?: number;
  isEditorCamera?: boolean;
}

/** 相机节点能力接口：投影类型与取景/裁剪/清屏参数 */
export interface ICameraNode extends INode {
  /** 相机类型：透视（fov 取景）/ 正交（orthoSize 取景） */
  cameraType: CameraKind;
  fov: number;
  /** 近裁剪面（最小值 0.01） */
  near: number;
  /** 远裁剪面（默认 20，最小值 1） */
  far: number;
  /** 正交半高（取景高度的一半，世界单位；仅正交相机生效） */
  orthoSize: number;
  /** 清除标志：skybox（默认）/ solidColor / depthOnly / colorOnly */
  clearFlags: CameraClearFlags;
  /** 纯色清屏色（clearFlags=solidColor 时的背景；0xRRGGBB） */
  clearColor: number;
  /** 渲染层级掩码（Culling Mask：只渲染掩码内层的对象；-1 = 全部层） */
  cullingMask: number;
  isEditorCamera: boolean;
}

export class CameraNode extends Node implements ICameraNode {
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
  /** 渲染层级掩码（默认全部层；编辑器自由视角不受此值影响，恒全层可见） */
  cullingMask: number = ALL_LAYERS_MASK;
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
    this.cullingMask = parseCullingMask(init.cullingMask ?? this.cullingMask);
    this.isEditorCamera = init.isEditorCamera ?? this.isEditorCamera;
  }

  override clone(): CameraNode {
    return new CameraNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      cameraType: this.cameraType,
      fov: this.fov,
      near: this.near,
      far: this.far,
      orthoSize: this.orthoSize,
      clearFlags: this.clearFlags,
      clearColor: this.clearColor,
      cullingMask: this.cullingMask,
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
    target.cullingMask = this.cullingMask;
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
    this.cullingMask = parseCullingMask(source.cullingMask);
    this.isEditorCamera = (source.isEditorCamera as boolean) ?? this.isEditorCamera;
  }
}
