// 渲染相机：从场景相机节点（或缺省位姿）构建，并按取景宽高比自适应投影。
// 相机类型：正交（orthoSize 半高取景，无近大远小）/ 透视（fov 取景，缺省）。
// 清除标志：skybox（缺省，全局天空/底色）/ solidColor（纯色 clearColor）/
// depthOnly（只清深度，保留上一帧颜色）/ colorOnly（只清颜色，保留上一帧深度）。
import * as THREE from "./three.module.min.js";
import { num } from "./utils.mjs";

/** 任意来源 → 清除标志（未知值回退 skybox，与编辑器框架规则一致） */
function parseClearFlags(v) {
  return v === "solidColor" || v === "depthOnly" || v === "colorOnly" ? v : "skybox";
}

/**
 * 构建渲染相机（优先取场景第一个非编辑器相机节点，无相机节点用缺省位姿）。
 * 返回 { cam, applyProjection(aspect), clear }：透视写 aspect；正交重算左右/上下范围；
 * clear = { flags, color } 供渲染循环每帧应用清除标志。
 */
export function createRenderCamera(canvasCameras) {
  const cams = canvasCameras.filter((c) => c.json.isEditorCamera !== true);
  const pick = cams.length ? cams[0] : canvasCameras[0];
  const isOrtho = !!pick && pick.json.cameraType === "orthographic";
  const orthoHalfH = isOrtho ? Math.max(0.01, num(pick.json.orthoSize, 5)) : 0;
  let cam;
  if (isOrtho) {
    cam = new THREE.OrthographicCamera(-orthoHalfH, orthoHalfH, orthoHalfH, -orthoHalfH, 0.1, 2000);
  } else {
    cam = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  }
  /** 按取景宽高比应用相机投影（透视写 aspect；正交重算左右/上下范围） */
  function applyProjection(aspect) {
    if (isOrtho) {
      cam.left = -orthoHalfH * aspect;
      cam.right = orthoHalfH * aspect;
      cam.top = orthoHalfH;
      cam.bottom = -orthoHalfH;
    } else {
      cam.aspect = aspect;
    }
    cam.updateProjectionMatrix();
  }
  if (pick) {
    const j = pick.json;
    if (!isOrtho) cam.fov = num(j.fov, 50);
    cam.near = Math.max(0.01, num(j.near, 0.1));
    cam.far = Math.max(num(j.far, 20), cam.near + 0.001);
    syncPose();
  } else {
    cam.position.set(7, 5, 8);
    cam.lookAt(0, 0.6, 0);
  }
  const clear = {
    flags: parseClearFlags(pick?.json?.clearFlags),
    color: num(pick?.json?.clearColor, 0) & 0xffffff,
  };
  /** 每帧同步：把相机节点（Group）的世界位姿回填渲染相机，
   *  脚本/动画/物理驱动的相机运动才能反映到渲染画面 */
  function syncPose() {
    if (!pick) return;
    pick.obj.getWorldPosition(cam.position);
    pick.obj.getWorldQuaternion(cam.quaternion);
  }
  return { cam, applyProjection, syncPose, clear };
}
