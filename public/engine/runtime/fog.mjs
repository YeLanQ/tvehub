// 场景环境雾：与编辑器 applyFogFromGraph 同一语义 ——
// 场景中第一个 启用且可见 的 fogNode 决定 scene.fog（线性 Fog / 指数 FogExp2，
// 与 three.js 官网 fog 示例同一用法），设置收敛规则与编辑器 framework/fog/types.ts
// 的 parseFogSettings 一致（缺失/非法/越界回退默认或钳进取值域）。
import * as THREE from "../core/three.module.min.js";
import { num, matColor } from "../core/utils.mjs";

/** 雾默认参数（与编辑器 DEFAULT_FOG_SETTINGS 一致） */
export const FOG_DEFAULTS = { color: 0xa0a0a0, near: 1, far: 100, density: 0.02 };

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

/** 按雾节点 JSON 构建 scene.fog（linear → THREE.Fog / exp2 → THREE.FogExp2） */
export function applyFogFromNode(scene, json) {
  const raw = json && typeof json.fog === "object" && json.fog ? json.fog : {};
  const color = matColor(raw.color, FOG_DEFAULTS.color);
  const density = Math.min(1, Math.max(0, num(raw.density, FOG_DEFAULTS.density)));
  if (json.fogKind === "exp2") {
    scene.fog = new THREE.FogExp2(color, density);
  } else {
    const near = Math.max(0, num(raw.near, FOG_DEFAULTS.near));
    const far = Math.max(0, num(raw.far, FOG_DEFAULTS.far));
    scene.fog = new THREE.Fog(color, near, far);
  }
}
