// 粒子系统回放（播放器侧）：为场景里的 particleSystemNode 建立绑定并每帧推进。
// 发射器语义在 ../core/particles.mjs（与编辑器 ParticleEmitter 镜像）；本模块只做
// 节点绑定与按节点 id 寻址的运行时控制（供脚本宿主 engine.particles / SDK
// ParticleSystemNode 转发）。
import { createParticleEmitter } from "../core/particles.mjs";

/**
 * particles 为 buildSceneTree 收集的粒子节点列表（{ json, obj, emitter }）。
 * 返回 { update(dt), play/pause/stop/restart/clear(nodeId), infoOf(nodeId),
 * settingsOf(nodeId), updateSettings(nodeId, patch), add(json, obj) }。
 */
export function createParticles(particles) {
  const byId = new Map();
  for (const entry of particles) {
    const id = typeof entry.json?.id === "string" ? entry.json.id : "";
    if (!id || !entry.emitter) continue;
    byId.set(id, { emitter: entry.emitter, host: entry.obj });
  }

  /** 节点对象可见性链（含自身）：不可见时不推进（与渲染一致，省 CPU） */
  function hostVisible(obj) {
    let cur = obj;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  return {
    /** 每帧推进全部发射器（渲染前调用） */
    update(dt) {
      byId.forEach((b) => {
        if (hostVisible(b.host)) b.emitter.update(dt, b.host);
      });
    },
    play(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.emitter.play();
      return true;
    },
    pause(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.emitter.pause();
      return true;
    },
    stop(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.emitter.stop();
      return true;
    },
    restart(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.emitter.restart();
      return true;
    },
    clear(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.emitter.clear();
      return true;
    },
    /** 运行态（playing/paused/finished/alive/time；未命中 null） */
    infoOf(nodeId) {
      const b = byId.get(nodeId);
      return b ? b.emitter.state : null;
    },
    /** 当前设置（收敛后；未命中 null） */
    settingsOf(nodeId) {
      const b = byId.get(nodeId);
      return b ? b.emitter.settings : null;
    },
    /**
     * 运行时合并设置（patch 子集）：结构参数（maxParticles/blending）变化时重建
     * 发射器（粒子从头开始），其余原地更新。
     */
    updateSettings(nodeId, patch) {
      const b = byId.get(nodeId);
      if (!b) return false;
      const merged = { ...b.emitter.settings, ...(patch && typeof patch === "object" ? patch : {}) };
      if (!b.emitter.needsRebuild(merged)) {
        b.emitter.setSettings(merged);
        return true;
      }
      const host = b.host;
      const layerMask = b.emitter.object.layers.mask;
      b.emitter.dispose();
      const next = createParticleEmitter(merged);
      next.object.layers.mask = layerMask;
      host.add(next.object);
      b.emitter = next;
      return true;
    },
    /** 运行时新增绑定（SDK 动态创建粒子节点用；json = 节点 JSON，obj = 宿主对象） */
    add(json, obj) {
      const id = typeof json?.id === "string" ? json.id : "";
      if (!id || !obj) return null;
      const emitter = createParticleEmitter(json.particles);
      emitter.object.layers.mask = obj.layers.mask;
      obj.add(emitter.object);
      byId.set(id, { emitter, host: obj });
      return emitter;
    },
  };
}
