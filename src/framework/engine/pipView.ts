// ---------------------------------------------------------------------------
// 画中画（场景编辑态选中相机节点 → 视口右下角取景渲染）：
// 请求解析（逐帧，经 RendererManager 的 PiP provider）、渲染前隐藏编辑器
// 辅助物/渲染后复原、DOM 浮层状态上报（pip:state 事件）。
// 相机参数应用与取景宽高比复用 previewView.ts。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import { CameraNode } from "../prototype/derived/Primitives";
import { computePiPRect, type PiPRequest } from "./modules/CameraPiP";
import { applyCameraNodeToThree, cameraViewAspect } from "./previewView";
import { syncOrthoSkyQuadUniforms } from "./skyEnv";

/**
 * 画中画请求解析（渲染器主渲染完成后逐帧调用）：
 * 场景编辑状态下选中 CameraNode → 返回其取景渲染请求（相机 + 右下角矩形 +
 * 辅助物隐藏钩子）；否则返回 null 并确保浮层状态上报为关闭。
 */
export function resolvePiPRequest(engine: EditorEngine, viewW: number, viewH: number): PiPRequest | null {
  const sel = engine.selectedId ? engine.graph.get(engine.selectedId) : undefined;
  const node = sel instanceof CameraNode ? sel : null;
  const rect =
    node && !engine.previewMode ? computePiPRect(viewW, viewH, cameraViewAspect(engine)) : null;
  if (!node || !rect) {
    engine.pipNode = null;
    emitPiPState(engine, null);
    return null;
  }
  engine.pipNode = node;
  const cam = node.cameraType === "orthographic" ? engine.pipOrthoCamera : engine.pipPerspCamera;
  // 逐帧从节点同步取景/变换（物体世界变换实时读取，gizmo 拖拽中画中画跟随）
  applyCameraNodeToThree(engine, cam, node, rect.width / rect.height);
  cam.updateMatrixWorld();
  emitPiPState(engine, { w: rect.width, h: rect.height, label: node.name });
  return {
    camera: cam,
    rect,
    begin: () => beginPiPPass(engine, node, cam),
    end: () => endPiPPass(engine),
  };
}

/** 画中画状态上报（变化才发事件；DOM 浮层按此显隐与定位） */
export function emitPiPState(engine: EditorEngine, state: { w: number; h: number; label: string } | null): void {
  const prev = engine.pipEmitted;
  if (state) {
    if (prev && prev.w === state.w && prev.h === state.h && prev.label === state.label) return;
    engine.pipEmitted = state;
    engine.events.emit("pip:state", {
      active: true,
      width: state.w,
      height: state.h,
      label: state.label,
    });
    return;
  }
  if (!prev) return;
  engine.pipEmitted = null;
  engine.events.emit("pip:state", { active: false, width: 0, height: 0, label: null });
}

/** 画中画渲染前隐藏编辑器辅助物（主渲染已结束，渲染完由 endPiPPass 复原） */
export function beginPiPPass(
  engine: EditorEngine,
  node: CameraNode,
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
): void {
  engine.pipHidden.length = 0;
  // 与 applyOverlayVisibility 同一套装饰集合：网格/相机体/图标/灯光装饰
  engine.renderer.scene.traverse((o) => {
    if (
      o.name === "__grid" ||
      o.name === "__camBody" ||
      o.name === "__camIcon" ||
      o.name === "__audioIcon" ||
      o.name === "__particleIcon"
    ) {
      if (o.visible) {
        engine.pipHidden.push(o);
        o.visible = false;
      }
      return;
    }
    const ud = o.userData as { lamp?: boolean };
    if (ud.lamp) {
      // 保留真实灯光对象，仅隐藏装饰 mesh
      o.children.forEach((c) => {
        if (!(c as THREE.Light).isLight && c.visible) {
          engine.pipHidden.push(c);
          c.visible = false;
        }
      });
    }
  });
  engine.gizmo.setEditorEnabled(false);
  engine.helperSystem.setVisible(false);
  engine.animation.setOverlayVisible(false);
  // UI 画布贴合画中画相机（主渲染贴合的是编辑器相机）：画中画即真实游戏取景；
  // 下一帧渲染回调会重新贴合活动相机，无需在此复原
  engine.uiSystem.update(cam, engine.synchronizer.getObjectMap(), null);
  // 正交相机 + 天空盒清除标志：天空由全屏背景面渲染（预览同款），贴合画中画相机
  engine.pipOrthoSkyActive = false;
  if (node.cameraType === "orthographic" && node.clearFlags === "skybox" && engine.skyApplied) {
    syncOrthoSkyQuadUniforms(engine, cam as THREE.OrthographicCamera);
    if (engine.orthoSkyQuad) engine.orthoSkyQuad.visible = true;
    engine.pipOrthoSkyActive = true;
  }
}

/** 画中画渲染结束：复原辅助物显隐（下一帧主渲染仍按场景编辑态显示） */
export function endPiPPass(engine: EditorEngine): void {
  for (const o of engine.pipHidden) o.visible = true;
  engine.pipHidden.length = 0;
  engine.gizmo.setEditorEnabled(true);
  engine.helperSystem.setVisible(true);
  engine.animation.setOverlayVisible(true);
  if (engine.pipOrthoSkyActive && engine.orthoSkyQuad) {
    engine.orthoSkyQuad.visible = false;
    engine.pipOrthoSkyActive = false;
  }
}
