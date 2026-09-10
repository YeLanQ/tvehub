// ---------------------------------------------------------------------------
// 粒子系统运行时（编辑器侧）：按节点 id 持有 ParticleEmitter，节点入图/属性变更
// 时由 EditorEngine 调 syncNode，渲染循环每帧 update(dt) 推进模拟。
//
// 同步策略：结构参数（缓冲容量/混合模式）变化 → 重建发射器（粒子从头开始）；
// 其余参数原地更新（存活粒子不重置，检查器拖滑块画面连续）。运行时控制
// （播放/暂停/停止/重启）为瞬态操作，不落盘。
// 播放器侧镜像：public/engine/runtime/particles.mjs（createParticles）。
// ---------------------------------------------------------------------------
import type * as THREE from "three";
import { clampLayerIndex } from "../layers";
import { ParticleEmitter, PARTICLES_CHILD_NAME } from "./ParticleEmitter";
import type { ParticleRuntimeState, ParticleSystemSettings } from "./types";

/** syncNode 需要的节点形状（避免依赖具体节点类；ParticleSystemNode 结构满足） */
export interface ParticleEmitterNode {
  id: string;
  particles: ParticleSystemSettings;
  /** 节点渲染层（粒子 Points 跟随节点层，相机 Culling Mask 排除时一同排除） */
  layer?: number;
}

type ParticleChangeListener = (nodeId: string) => void;

interface Binding {
  emitter: ParticleEmitter;
  host: THREE.Object3D;
}

export class ParticleSystem {
  private bindings = new Map<string, Binding>();
  private listeners = new Set<ParticleChangeListener>();

  /** 订阅运行时变化（播放控制后广播，供面板刷新状态文案） */
  onChange(l: ParticleChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(nodeId: string): void {
    this.listeners.forEach((l) => l(nodeId));
  }

  /**
   * 按节点数据同步发射器：首次绑定建出并挂到节点对象下；结构参数变化整体重建；
   * 其余参数原地更新。节点对象变化（场景重建）时按新对象重挂。
   */
  syncNode(node: ParticleEmitterNode, obj: THREE.Object3D): void {
    const s = node.particles;
    const layer = clampLayerIndex(node.layer);
    let b = this.bindings.get(node.id);
    if (b && (b.host !== obj || b.emitter.needsRebuild(s))) {
      b.emitter.dispose();
      this.bindings.delete(node.id);
      b = undefined;
    }
    if (!b) {
      // 同一对象上可能残留旧 Points（对象复用场景）：先清掉
      const stale = obj.children.filter((c) => c.name === PARTICLES_CHILD_NAME);
      for (const c of stale) obj.remove(c);
      const emitter = new ParticleEmitter(s);
      obj.add(emitter.object);
      b = { emitter, host: obj };
      this.bindings.set(node.id, b);
    } else {
      b.emitter.setSettings(s);
    }
    b.emitter.object.layers.set(layer);
  }

  /** 每帧推进全部发射器（渲染循环调用） */
  update(dt: number): void {
    this.bindings.forEach((b) => b.emitter.update(dt, b.host));
  }

  // —— 运行时控制（瞬态，不落盘）——

  play(nodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    b.emitter.play();
    this.emit(nodeId);
    return true;
  }

  pause(nodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    b.emitter.pause();
    this.emit(nodeId);
    return true;
  }

  stop(nodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    b.emitter.stop();
    this.emit(nodeId);
    return true;
  }

  restart(nodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    b.emitter.restart();
    this.emit(nodeId);
    return true;
  }

  clear(nodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    b.emitter.clear();
    this.emit(nodeId);
    return true;
  }

  /** 运行时状态快照（未绑定返回 null） */
  stateFor(nodeId: string): ParticleRuntimeState | null {
    const b = this.bindings.get(nodeId);
    return b ? b.emitter.state : null;
  }

  /** 发射器句柄（冒烟测试/调试用；未绑定返回 null） */
  emitterOf(nodeId: string): ParticleEmitter | null {
    return this.bindings.get(nodeId)?.emitter ?? null;
  }

  unbind(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    b.emitter.dispose();
    this.bindings.delete(nodeId);
  }

  unbindAll(): void {
    this.bindings.forEach((b) => b.emitter.dispose());
    this.bindings.clear();
  }

  dispose(): void {
    this.unbindAll();
    this.listeners.clear();
  }
}
