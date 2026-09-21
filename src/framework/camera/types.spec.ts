import { describe, expect, it } from "vitest";
import {
  clampCameraParam,
  DEFAULT_CAMERA_CLEAR_FLAGS,
  DEFAULT_CAMERA_PARAMS,
  parseCameraClearFlags,
  parseCameraKind,
} from "./types";

// 相机类型收敛：类型/清除标志回退与参数钳制。

describe("parseCameraKind / parseCameraClearFlags", () => {
  it("已知值保留，未知/非法回退默认（旧场景可读）", () => {
    expect(parseCameraKind("orthographic")).toBe("orthographic");
    expect(parseCameraKind("perspective")).toBe("perspective");
    expect(parseCameraKind("bogus")).toBe("perspective");
    expect(parseCameraKind(42)).toBe("perspective");
    expect(parseCameraClearFlags("solidColor")).toBe("solidColor");
    expect(parseCameraClearFlags("depthOnly")).toBe("depthOnly");
    expect(parseCameraClearFlags("colorOnly")).toBe("colorOnly");
    expect(parseCameraClearFlags("x")).toBe(DEFAULT_CAMERA_CLEAR_FLAGS);
  });
});

describe("clampCameraParam", () => {
  it("fov 钳 [1,170]；near/orthoSize 下限 0.01；far 下限 1", () => {
    expect(clampCameraParam("fov", 0)).toBe(1);
    expect(clampCameraParam("fov", 200)).toBe(170);
    expect(clampCameraParam("fov", 60)).toBe(60);
    expect(clampCameraParam("near", 0)).toBe(0.01);
    expect(clampCameraParam("far", -5)).toBe(1);
    expect(clampCameraParam("orthoSize", 0)).toBe(0.01);
    expect(clampCameraParam("orthoSize", 8)).toBe(8);
  });

  it("默认参数自身在取值域内", () => {
    for (const key of ["fov", "near", "far", "orthoSize"] as const) {
      expect(clampCameraParam(key, DEFAULT_CAMERA_PARAMS[key])).toBe(DEFAULT_CAMERA_PARAMS[key]);
    }
  });
});
