// ---------------------------------------------------------------------------
// 渲染雾应用（场景环境级）：场景图中第一个「启用且可见」的雾节点决定
// scene.fog。签名脏检查避免重复重建；three 的渲染器按「材质记录的雾引用 vs
// scene.fog」自动重编译着色器，雾对象热替换/清空无需手动标记 needsUpdate。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import { FogNode } from "../prototype/derived/Primitives";
import {
  applyHeightFogWebGPU,
  clearHeightFogWebGPU,
  fogSettingsSig,
  setHeightFogParams,
  setHeightFogStrength,
} from "../fog";

/**
 * 依据场景图应用/移除渲染雾：
 * 场景中第一个 启用且可见 的雾节点决定 scene.fog（线性 Fog / 指数 FogExp2 /
 * 高度雾，高度雾着色器实现见 framework/fog/heightFog.ts），节点增删、属性
 * 修改、启停切换都会触发重算；无雾节点时清掉场景雾。签名未变化的重复调用
 * 是空操作（脏检查）。
 * 高度雾 = FogExp2 距离衰减 + 海拔衰减：WebGL 端海拔参数走共享 uniform
 * （heightFog.ts 的 chunk patch），WebGPU 端改设 scene.fogNode（TSL）。
 */
export function applyFogFromGraph(engine: EditorEngine): void {
  const scene = engine.renderer.scene;
  const fog = findFogNode(engine);
  if (!fog) {
    if (engine.fogAppliedSig !== null) {
      engine.fogAppliedSig = null;
      scene.fog = null;
    }
    setHeightFogStrength(0);
    clearHeightFogWebGPU(scene);
    return;
  }
  const sig = [fog.id, fog.fogKind, fogSettingsSig(fog.fog)].join("|");
  if (engine.fogAppliedSig === sig) return;
  engine.fogAppliedSig = sig;
  const color = fog.fog.color & 0xffffff;
  if (fog.fogKind === "height") {
    // 高度雾：普通 FogExp2 撑起 three 的雾管线（颜色/密度同步 + FOG_EXP2
    // define），海拔衰减由 heightFog.ts 注入；WebGPU 端整体走 TSL 雾节点
    scene.fog = new THREE.FogExp2(color, fog.fog.density);
    setHeightFogParams(fog.fog.heightY, fog.fog.heightFalloff, 1);
    // TSL 仅 WebGPU 后端加载（WebGL 下 three/tsl 不参与渲染，避免无谓加载）
    if (engine.renderer.activeBackend === "webgpu") applyHeightFogWebGPU(scene, fog.fog);
    return;
  }
  scene.fog =
    fog.fogKind === "exp2"
      ? new THREE.FogExp2(color, fog.fog.density)
      : new THREE.Fog(color, fog.fog.near, fog.fog.far);
  // 高度衰减显式归零：防止上一个高度雾节点的参数残留影响普通雾
  setHeightFogStrength(0);
  clearHeightFogWebGPU(scene);
}

/** 深度优先查找第一个 启用且可见 的雾节点（场景树的文档序，与 findSkyboxNode 同规则） */
export function findFogNode(engine: EditorEngine): FogNode | null {
  const root = engine.graph.root;
  if (!root) return null;
  const stack: (typeof root)[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof FogNode && n.active && n.visible) return n;
    const ids = n.childIds;
    for (let i = ids.length - 1; i >= 0; i--) {
      const c = engine.graph.get(ids[i]);
      if (c) stack.push(c);
    }
  }
  return null;
}
