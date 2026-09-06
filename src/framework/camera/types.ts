// ---------------------------------------------------------------------------
// 相机系统基础类型与约定（framework 层，风格对齐 material/types.ts）：
// 相机参数直接挂在 CameraNode 字段上（不单独资产化），
// 这里定义类型 key、参数字段与收敛规则，供工厂/节点/UI 共用。
// ---------------------------------------------------------------------------

/** 相机类型 key（CameraNode.cameraType 字段；缺省/未知回退透视） */
export type CameraKind = "perspective" | "orthographic";

/** 默认相机类型（节点缺省/JSON 未知值时的回退） */
export const DEFAULT_CAMERA_TYPE: CameraKind = "perspective";

/** 可编辑的相机参数字段名（公共 near/far + 透视 fov + 正交 orthoSize） */
export type CameraParamKey = "fov" | "near" | "far" | "orthoSize";

/** 相机参数默认值（与 CameraNode 字段初始值一致；类型切换后保留另一类型的值） */
export const DEFAULT_CAMERA_PARAMS: Record<CameraParamKey, number> = {
  fov: 50,
  near: 0.1,
  far: 20,
  orthoSize: 5,
};

/** 任意来源 → 相机类型（未知值回退透视，保证旧场景文件可读） */
export function parseCameraKind(v: unknown): CameraKind {
  return v === "orthographic" ? "orthographic" : "perspective";
}

/** 单参数收敛（属性面板编辑后统一入口；与 CameraNode 构造/读取的兜底一致） */
export function clampCameraParam(key: CameraParamKey, value: number): number {
  switch (key) {
    case "fov":
      return Math.max(1, Math.min(170, value));
    case "near":
      return Math.max(0.01, value);
    case "far":
      return Math.max(1, value);
    case "orthoSize":
      return Math.max(0.01, value);
  }
}
