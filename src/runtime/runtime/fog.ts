// 场景环境雾：与编辑器 applyFogFromGraph 同一语义 ——
// 场景中第一个 启用且可见 的 fogNode 决定 scene.fog，设置收敛规则与编辑器
// framework/fog/types.ts 的 parseFogSettings 一致（缺失/非法/越界回退默认或
// 钳进取值域）。fogKind = height（高度雾）时 scene.fog 仍是 FogExp2（撑起
// three 的雾管线），海拔衰减由 runtime/heightFog.mjs 注入（WebGL 走 fog
// chunk patch，WebGPU 由调用方传入 TSL 命名空间走 scene.fogNode）。
import * as THREE from "../core/three.module.min.js";
import { num, matColor } from "../core/utils";
import {
  applyHeightFogNodeWebGPU,
  clearHeightFogWebGPU,
  setHeightFogParams,
} from "./heightFog";

/** 雾默认参数（与编辑器 DEFAULT_FOG_SETTINGS 一致） */
export const FOG_DEFAULTS = {
  color: 0xa0a0a0,
  near: 1,
  far: 100,
  density: 0.02,
  heightY: 0,
  heightFalloff: 20,
};

/** 雾设置收敛（与编辑器 parseFogSettings 同规则） */
export function parseFogSettings(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const d = FOG_DEFAULTS;
  const clamp = (v, lo, hi, fb) => Math.min(hi, Math.max(lo, num(v, fb)));
  return {
    color: matColor(o.color, d.color),
    near: clamp(o.near, 0, 100000, d.near),
    far: clamp(o.far, 0, 100000, d.far),
    density: clamp(o.density, 0, 1, d.density),
    heightY: clamp(o.heightY, -5000, 5000, d.heightY),
    heightFalloff: clamp(o.heightFalloff, 0.1, 2000, d.heightFalloff),
  };
}

/** 深度优先查找首个 type=fogNode 且 启用且可见 的节点（与编辑器 findFogNode 一致） */
export function findFogNode(json) {
  if (!json || typeof json !== "object") return null;
  if (json.type === "fogNode" && json.active !== false && json.visible !== false) return json;
  if (Array.isArray(json.children)) {
    for (const c of json.children) {
      const r = findFogNode(c);
      if (r) return r;
    }
  }
  return null;
}

/**
 * 按雾节点 JSON 构建 scene.fog。
 * @param opts.webgpuTsl WebGPU 后端下传入 THREE.TSL 命名空间（高度雾走
 *        scene.fogNode；WebGL 后端不传，海拔衰减走 chunk patch 共享 uniform）
 */
export function applyFogFromNode(scene, json, opts) {
  const kind = json.fogKind === "exp2" || json.fogKind === "height" ? json.fogKind : "linear";
  const s = parseFogSettings(json.fog);
  if (kind === "height") {
    // 高度雾：普通 FogExp2 撑起 three 的雾管线（颜色/密度同步 + FOG_EXP2 define），
    // 海拔衰减由 heightFog.mjs 注入；WebGPU 端整体走 TSL 雾节点
    scene.fog = new THREE.FogExp2(s.color, s.density);
    setHeightFogParams(s.heightY, s.heightFalloff, 1);
    if (opts && opts.webgpuTsl) applyHeightFogNodeWebGPU(scene, s, opts.webgpuTsl);
    return;
  }
  if (kind === "exp2") {
    scene.fog = new THREE.FogExp2(s.color, s.density);
  } else {
    scene.fog = new THREE.Fog(s.color, s.near, s.far);
  }
  // 高度衰减显式归零：防止残留（幂等防御；播放器单次加载理论不会残留）
  setHeightFogParams(s.heightY, s.heightFalloff, 0);
  clearHeightFogWebGPU(scene);
}
