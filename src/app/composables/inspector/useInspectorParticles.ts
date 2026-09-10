// ---------------------------------------------------------------------------
// 粒子系统域：粒子节点卡（ParticleSection）的字段编辑。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），域之间互不引用。
// 编辑走 commit → mutateNode（整节点快照进撤销历史），标签文案即历史文案。
// 写入统一经 parseParticleSystemSettings 收敛（取值域单一事实源在 framework
// 的 PARTICLE_LIMITS；界面钳制只是预防，越界最终由 parse 兜底）。
// 运行时控制（播放/暂停/停止/重启）由卡片直连 engine.particles，不经这里。
// ---------------------------------------------------------------------------
import { ParticleSystemNode } from "../../../framework/prototype/derived/Primitives";
import {
  parseParticleSystemSettings,
  type ParticleSystemSettings,
} from "../../../framework/particles";
import type { InspectorNodeApi } from "./useInspectorNode";

/** 卡片事件标签 → 设置字段（标签即撤销历史文案） */
const LABEL_FIELD: Record<string, keyof ParticleSystemSettings> = {
  "Set Duration": "duration",
  "Toggle Looping": "looping",
  "Toggle Prewarm": "prewarm",
  "Set Start Delay": "startDelay",
  "Set Start Lifetime": "startLifetime",
  "Set Start Speed": "startSpeed",
  "Set Start Size": "startSize",
  "Set Start Color": "startColor",
  "Set End Color": "endColor",
  "Set Gravity Modifier": "gravityModifier",
  "Set Emission Rate": "emissionRate",
  "Set Max Particles": "maxParticles",
  "Set Shape": "shape",
  "Set Shape Radius": "shapeRadius",
  "Set Shape Angle": "shapeAngle",
  "Set Simulation Space": "simulationSpace",
  "Toggle Color Over Lifetime": "colorOverLifetime",
  "Toggle Size Over Lifetime": "sizeOverLifetime",
  "Set Blending": "blending",
};

export interface InspectorParticlesApi {
  onParticleUpdate: (label: string, value: unknown) => void;
}

export function useInspectorParticles(ctx: InspectorNodeApi): InspectorParticlesApi {
  const { node, commit } = ctx;

  function onParticleUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof ParticleSystemNode)) return;
    const field = LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const ps = m as ParticleSystemNode;
      // 整体重新收敛：非法/越界值回到取值域内（与 parse 同一边界）
      ps.particles = parseParticleSystemSettings({ ...ps.particles, [field]: value });
    }, label);
  }

  return { onParticleUpdate };
}
