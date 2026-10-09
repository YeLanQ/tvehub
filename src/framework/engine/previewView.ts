// ---------------------------------------------------------------------------
// 预览渲染视图（视图模式切换 / 预览相机 / 清除状态 / 编辑器辅助物显隐）。
// "scene"（编辑视口）= 独立自由轨道相机 + 编辑器辅助物；"preview" = 场景中的
// CameraNode（真实渲染相机）取景、隐藏辅助物。相机节点参数 → three 相机的
// 应用函数由画中画（pipView.ts）共用。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { logger } from "../../platform_abstraction/logger";
import type { EditorEngine } from "./EditorEngine";
import { CameraNode } from "../prototype/derived/Primitives";
import { degToRad } from "../prototype/types";
import { parseCullingMask } from "../layers";
import type { CameraClearState } from "./modules/RendererManager";
import { EDITOR_BACKGROUND_COLOR } from "./modules/RendererManager";

/**
 * 把相机节点的取景参数（near/far/Culling Mask/fov 或正交范围）与世界变换
 * 应用到指定 three 相机（预览渲染与画中画共用；正交宽高比由调用方决定）。
 */
export function applyCameraNodeToThree(
  engine: EditorEngine,
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  node: CameraNode,
  aspect: number,
): void {
  // 模型层保证 near ≥ 0.01、far ≥ 1；真实相机还需要 far > near，这里兜底
  const near = Math.max(0.01, node.near);
  const far = Math.max(node.far, near + 1e-4);
  cam.near = near;
  cam.far = far;
  // 相机节点的 Culling Mask：预览即真实渲染，只画掩码内层的对象；
  // RendererManager 在掩码内占用多层时按层拆 pass，使灯光 Culling Mask 一并生效
  cam.layers.mask = parseCullingMask(node.cullingMask);
  if (node.cameraType === "orthographic") {
    const oc = cam as THREE.OrthographicCamera;
    const halfH = Math.max(0.01, node.orthoSize);
    oc.left = -halfH * aspect;
    oc.right = halfH * aspect;
    oc.top = halfH;
    oc.bottom = -halfH;
    oc.updateProjectionMatrix();
  } else {
    // 透视同样要跟随目标面比例：画中画 RT/预览全屏的面比例就是入参 aspect，
    // 不同步会导致画面被拉伸（pip 相机构造后 aspect 恒为 1 的历史缺陷）
    const pc = cam as THREE.PerspectiveCamera;
    pc.fov = node.fov;
    pc.aspect = Math.max(0.01, aspect);
    pc.updateProjectionMatrix();
  }
  const obj = engine.synchronizer.getObjectMap().get(node.id);
  if (obj) {
    obj.getWorldPosition(cam.position);
    obj.getWorldQuaternion(cam.quaternion);
  } else {
    cam.position.set(node.transform.position.x, node.transform.position.y, node.transform.position.z);
    const rot = degToRad(node.transform.rotation);
    cam.quaternion.setFromEuler(new THREE.Euler(rot.x, rot.y, rot.z, "XYZ"));
  }
}

/** 相机取景宽高比：优先项目设计分辨率，未配置回退视口宽高比（与视锥辅助线一致） */
export function cameraViewAspect(engine: EditorEngine): number {
  const d = engine.designResolution;
  if (d && d.width > 0 && d.height > 0) return d.width / d.height;
  return engine.renderer.aspect;
}

/**
 * 预览相机的清除状态（每帧渲染前调用；返回 null = 默认全清 + 全局背景）。
 * 编辑器相机与"无相机节点回退"都保持既有行为（全局天空/底色背景）；
 * 有相机节点时按节点清除标志决定清屏方式与背景内容。
 */
export function resolveClearState(engine: EditorEngine, cam?: THREE.Camera): CameraClearState | null {
  // 布局视图与场景视图同一背景规则：存在天空盒节点（启用且可见）时绘制天空，
  // 手动隐藏/停用后回退编辑器底色（全局背景由 applySkyFromGraph 维护，
  // 布局视图的独占渲染只隐藏场景内容，不影响背景）
  const isPiPCam =
    !engine.previewMode && (cam === engine.pipPerspCamera || cam === engine.pipOrthoCamera);
  const node = engine.previewMode ? engine.previewNode : isPiPCam ? engine.pipNode : null;
  if (!node) return null;
  switch (node.clearFlags) {
    case "solidColor":
      engine.clearScratchColor.setHex(node.clearColor & 0xffffff);
      return { background: engine.clearScratchColor, clearColor: true, clearDepth: true };
    case "depthOnly":
      // 不清颜色：保留上一帧画面（背景不绘制，颜色缓冲原样保留）
      return { background: null, clearColor: false, clearDepth: true };
    case "colorOnly":
      // 不清深度：保留上一帧深度（背景照常清除重画）
      return { background: null, clearColor: true, clearDepth: false };
    case "skybox":
    default:
      // 正交相机：three.js 的纹理背景只支持透视相机（立方体路径按贴相机盒子
      // 绘制，正交取景远大于盒子），天空改由全屏背景面渲染（updateOrthoSkyQuad），
      // 这里只清屏、不绘制背景
      if (engine.skyApplied && (cam as THREE.OrthographicCamera).isOrthographicCamera === true) {
        return { background: null, clearColor: true, clearDepth: true };
      }
      // 天空盒：全局天空纹理；无天空盒节点回退编辑器底色（与场景背景规则一致）
      if (engine.skyApplied) {
        return { background: engine.skyApplied.texture, clearColor: true, clearDepth: true };
      }
      engine.clearScratchColor.setHex(EDITOR_BACKGROUND_COLOR);
      return { background: engine.clearScratchColor, clearColor: true, clearDepth: true };
  }
}

/**
 * 依据当前 previewMode 应用一致的状态：
 * 有可用相机节点 → 用该节点渲染预览；
 * 无相机节点 → 用默认取景视角渲染（隐藏编辑器辅助物、禁用轨道）。
 */
export function syncPreviewView(engine: EditorEngine): void {
  if (!engine.previewMode) {
    engine.previewNode = null;
    engine.overlayVisible = true;
    engine.renderer.setActiveCamera(engine.renderer.camera);
    // 布局视图用 2D 设计视图导航（滚轮缩放/右中键平移），轨道相机保持禁用
    //（场景图任何变化都会走到这里，不能无条件重启轨道）
    engine.renderer.orbitControls.enabled = !engine.uiSystem.isVisible();
    applyOverlayVisibility(engine);
    return;
  }
  const node = resolvePreviewCameraNode(engine);
  if (!node) {
    if (!engine.previewFallbackLogged) {
      logger.info("场景中没有 CameraNode，预览使用默认相机视角");
      engine.previewFallbackLogged = true;
    }
    engine.previewNode = null;
    applyDefaultPreviewPose(engine);
    engine.overlayVisible = false;
    engine.renderer.setActiveCamera(engine.previewCamera);
    engine.renderer.orbitControls.enabled = false;
    applyOverlayVisibility(engine);
    return;
  }
  engine.previewNode = node;
  engine.overlayVisible = false;
  syncPreviewCameraTo(engine, node);
  engine.renderer.setActiveCamera(previewCameraFor(engine, node));
  engine.renderer.orbitControls.enabled = false;
  applyOverlayVisibility(engine);
}

/** 预览相机选择：优先当前选中的 CameraNode，其次第一个非编辑器相机 */
export function resolvePreviewCameraNode(engine: EditorEngine): CameraNode | null {
  const sel = engine.selectedId ? engine.graph.get(engine.selectedId) : undefined;
  if (sel instanceof CameraNode) return sel;
  const cams = engine.graph.all().filter((n): n is CameraNode => n instanceof CameraNode);
  if (!cams.length) return null;
  return cams.find((c) => !c.isEditorCamera) ?? cams[0];
}

/** 相机节点对应的三维预览相机实例（按 cameraType 选择透视/正交） */
export function previewCameraFor(engine: EditorEngine, node: CameraNode): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  return node.cameraType === "orthographic" ? engine.previewOrthoCamera : engine.previewCamera;
}

/** 正交预览相机取景范围：半高 = orthoSize，半宽 = orthoSize × 取景宽高比 */
export function syncOrthoPreviewFrustum(engine: EditorEngine): void {
  const cam = engine.previewOrthoCamera;
  const aspect = cameraViewAspect(engine);
  const halfH = Math.max(0.01, engine.previewOrthoSize);
  cam.left = -halfH * aspect;
  cam.right = halfH * aspect;
  cam.top = halfH;
  cam.bottom = -halfH;
  cam.updateProjectionMatrix();
}

/** 把预览相机对齐到相机节点的世界变换与取景参数（按类型应用 fov 或正交范围） */
export function syncPreviewCameraTo(engine: EditorEngine, node: CameraNode): void {
  engine.previewOrthoSize = node.orthoSize;
  applyCameraNodeToThree(engine, previewCameraFor(engine, node), node, cameraViewAspect(engine));
}

/** 无场景相机时的预览取景：从斜上方望向场景中心 */
export function applyDefaultPreviewPose(engine: EditorEngine): void {
  const cam = engine.previewCamera;
  cam.fov = 50;
  cam.near = 0.1;
  cam.far = 2000;
  cam.position.set(7, 5, 8);
  cam.lookAt(0, 0.6, 0);
  cam.updateProjectionMatrix();
  // 回退取景不是任何相机节点的渲染：恢复全层可见
  cam.layers.enableAll();
}

/**
 * 编辑器辅助物显隐（与真实渲染无关的装饰）：
 * 网格、相机体、灯光的辅助球/框、gizmo、选择框。
 */
export function applyOverlayVisibility(engine: EditorEngine): void {
  const vis = engine.overlayVisible;
  engine.renderer.scene.traverse((o) => {
    if (
      o.name === "__grid" ||
      o.name === "__camBody" ||
      o.name === "__camIcon" ||
      o.name === "__audioIcon" ||
      o.name === "__particleIcon"
    ) {
      o.visible = vis;
      return;
    }
    const ud = o.userData as { lamp?: boolean };
    if (ud.lamp) {
      // 保留真实灯光对象，仅隐藏装饰 mesh
      o.children.forEach((c) => {
        if (!(c as THREE.Light).isLight) c.visible = vis;
      });
    }
  });
  engine.gizmo.setEditorEnabled(vis);
  engine.helperSystem.setVisible(vis);
  engine.animation.setOverlayVisible(vis);
}
