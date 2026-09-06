// ---------------------------------------------------------------------------
// 动画系统（引擎模块）：驱动模型网格的 AnimationMixer。
//
// 设计要点：
// - 绑定按节点 id 索引：同步器把“实例化模型根 + 剪辑列表”交给 syncNode，
//   系统据此建/重建 mixer；同一实例只应用设置差异（改速度/循环不重启播放），
//   实例被重建（模型重载/属性重建）时才整个重绑并回到初始状态；
// - 两级能力（见 types.ts）：单剪辑模式（MeshNode.anim 直控）与
//   动画图模式（MeshNode.animGraph 状态机：exitTime + 参数条件 → 交叉淡化过渡）；
// - 骨骼可视化：含骨骼的模型在节点被选中时显示 SkeletonHelper（编辑器辅助物）；
// - 运行时控制（播放/暂停/参数）不落盘，只影响本会话；节点数据
//   （autoplay/clip/speed/loop/graph）才随场景序列化。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import {
  cloneAnimGraph,
  evalCondition,
  parseAnimGraph,
  type AnimClipSettings,
  type AnimGraph,
  type AnimGraphParamValue,
  type AnimLoopMode,
} from "./types";

/** syncNode 需要的节点形状（避免依赖具体节点类；MeshNode 结构满足） */
export interface AnimatableNode {
  id: string;
  anim: AnimClipSettings;
  animGraph: AnimGraph | null;
}

/** 运行时状态快照（UI 展示用） */
export interface AnimRuntimeState {
  mode: "off" | "clip" | "graph";
  playing: boolean;
  /** 单剪辑模式当前剪辑名 */
  clip: string | null;
  /** 图模式当前状态名 */
  graphState: string | null;
  params: Record<string, AnimGraphParamValue>;
}

type AnimChangeListener = (nodeId: string) => void;

interface Binding {
  nodeId: string;
  root: THREE.Object3D;
  rootUuid: string;
  mixer: THREE.AnimationMixer;
  /** 剪辑名 → action（重名剪辑取首个） */
  actions: Map<string, THREE.AnimationAction>;
  clips: THREE.AnimationClip[];
  hasSkeleton: boolean;
  /** 单剪辑模式：当前播放剪辑 */
  currentClip: string | null;
  /** 最近一次应用的剪辑设置（手动 播放/停止 后恢复时沿用速度/循环） */
  clipSettings: AnimClipSettings;
  playing: boolean;
  paused: boolean;
  /** 图模式：运行时图副本（参数可写）+ 当前状态 */
  graph: AnimGraph | null;
  /** 上次应用的图数据签名（JSON；一致时保留运行时参数/状态不被属性补丁重置） */
  graphSig: string;
  graphState: string | null;
  skeletonHelper: THREE.SkeletonHelper | null;
  helperSelected: boolean;
}

/** LoopMode → three 循环常量（once 需 clampWhenFinished 定格在末帧） */
function threeLoopOf(mode: AnimLoopMode): {
  loop: THREE.AnimationActionLoopStyles;
  clamp: boolean;
} {
  switch (mode) {
    case "once":
      return { loop: THREE.LoopOnce, clamp: true };
    case "pingpong":
      return { loop: THREE.LoopPingPong, clamp: false };
    default:
      return { loop: THREE.LoopRepeat, clamp: false };
  }
}

export class AnimationSystem {
  private bindings = new Map<string, Binding>();
  private listeners = new Set<AnimChangeListener>();
  /** 编辑器辅助物总开关（预览渲染时隐藏骨骼辅助线） */
  private overlayVisible = true;
  private selectedId: string | null = null;
  /**
   * 场景根：SkeletonHelper 的 matrix 直接引用模型根的 matrixWorld（顶点按模型根
   * 局部空间计算），必须挂在无变换的场景根下其最终 matrixWorld 才等于模型根的
   * matrixWorld；挂在带变换的节点容器上会把节点变换叠加两次，骨架与模型分离。
   */
  private sceneRoot: THREE.Scene | null = null;

  onChange(l: AnimChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** 注入场景根（引擎构造时调用；骨骼辅助线挂在它下面） */
  setSceneRoot(scene: THREE.Scene | null): void {
    // 已存在的辅助线跟随迁移（正常只在任何绑定建立前调用一次）
    for (const b of this.bindings.values()) {
      if (b.skeletonHelper) {
        b.skeletonHelper.parent?.remove(b.skeletonHelper);
        scene?.add(b.skeletonHelper);
      }
    }
    this.sceneRoot = scene;
  }

  private notify(nodeId: string): void {
    for (const l of this.listeners) l(nodeId);
  }

  /**
   * 同步节点动画（同步器在网格刷新时调用）：
   * 同一模型实例仅应用设置差异；实例重建时重绑（mixer 绑定新层级）。
   */
  syncNode(node: AnimatableNode, root: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    const existing = this.bindings.get(node.id);
    if (existing && existing.rootUuid === root.uuid) {
      this.applySettings(existing, node);
      return;
    }
    if (existing) this.disposeBinding(existing);

    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of clips) {
      const name = clip.name || "clip";
      if (!actions.has(name)) actions.set(name, mixer.clipAction(clip));
    }
    let hasSkeleton = false;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkeleton = true;
    });

    const binding: Binding = {
      nodeId: node.id,
      root,
      rootUuid: root.uuid,
      mixer,
      actions,
      clips,
      hasSkeleton,
      currentClip: null,
      clipSettings: { ...node.anim },
      playing: false,
      paused: false,
      graph: null,
      graphSig: "",
      graphState: null,
      skeletonHelper: null,
      helperSelected: false,
    };
    // 骨骼辅助线挂在场景根上（其 matrix 引用模型根 matrixWorld，随节点变换；
    // 仅选中且辅助物可见时显示）
    if (hasSkeleton) {
      const helper = new THREE.SkeletonHelper(root);
      helper.name = "__skelHelper";
      helper.visible = false;
      const host = this.sceneRoot ?? root.parent;
      if (host) host.add(helper);
      binding.skeletonHelper = helper;
    }
    this.bindings.set(node.id, binding);
    this.applySettings(binding, node);
  }

  /** 应用节点动画设置（数据 → 运行时）：图优先，其次单剪辑，均无则停用 */
  private applySettings(b: Binding, node: AnimatableNode): void {
    if (node.animGraph) {
      const sig = JSON.stringify(node.animGraph);
      if (sig !== b.graphSig) {
        // 图数据被编辑（或首次应用）：以节点数据为准重建，回到入口状态
        b.graph = cloneAnimGraph(node.animGraph);
        b.graphSig = sig;
        this.enterGraphState(b, b.graph.entry, 0);
      }
      if (node.anim.autoplay && !b.playing) {
        this.playGraphState(b, b.graphState ?? b.graph!.entry);
      }
      return;
    }
    b.graph = null;
    b.graphSig = "";
    b.graphState = null;
    b.clipSettings = { ...node.anim };
    // 单剪辑模式
    const wantClip = this.resolveClipName(b, node.anim.clip);
    if (node.anim.autoplay && wantClip) {
      if (b.currentClip !== wantClip) {
        this.playClipAction(b, wantClip, node.anim, 0.25);
      } else {
        this.applyClipParams(this.currentClipAction(b), node.anim);
      }
      return;
    }
    // 未启用自动播放：停在初始姿势（运行时手动播放仍可用）
    if (!b.playing) {
      b.mixer.stopAllAction();
      b.currentClip = null;
    }
  }

  /** 剪辑名收敛：空/不存在 → 第一个剪辑（无剪辑返回 null） */
  private resolveClipName(b: Binding, clip: string): string | null {
    if (!b.actions.size) return null;
    if (clip && b.actions.has(clip)) return clip;
    return [...b.actions.keys()][0] ?? null;
  }

  private currentClipAction(b: Binding): THREE.AnimationAction | null {
    return b.currentClip ? (b.actions.get(b.currentClip) ?? null) : null;
  }

  private applyClipParams(
    action: THREE.AnimationAction | null,
    settings: { speed: number; loop: AnimLoopMode },
  ): void {
    if (!action) return;
    action.timeScale = settings.speed;
    const { loop, clamp } = threeLoopOf(settings.loop);
    // repetitions：循环/往复取无限；LoopOnce 用 1（配合 clampWhenFinished 定格末帧）
    action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    action.clampWhenFinished = clamp;
  }

  /** 单剪辑切换：目标动作重置后播放，与当前动作交叉淡化 */
  private playClipAction(
    b: Binding,
    clip: string,
    settings: { speed: number; loop: AnimLoopMode },
    fade: number,
  ): void {
    const target = b.actions.get(clip);
    if (!target) return;
    const prev = this.currentClipAction(b);
    this.applyClipParams(target, settings);
    target.reset().play();
    if (prev && prev !== target && fade > 0) prev.crossFadeTo(target, fade, false);
    else if (prev && prev !== target) prev.stop();
    b.currentClip = clip;
    b.playing = true;
    b.paused = false;
  }

  // —— 图模式运行时 ——

  /** 图状态入场：切换 graphState 并播放对应剪辑（无剪辑则保持姿势） */
  private enterGraphState(b: Binding, stateName: string, fade: number): void {
    if (!b.graph) return;
    const state = b.graph.states.find((s) => s.name === stateName);
    b.graphState = stateName;
    if (!state || state.clip === "") {
      // 保持姿势：淡出当前动作
      const cur = this.currentClipAction(b);
      if (cur) cur.fadeOut(fade);
      b.currentClip = null;
      b.playing = false;
      return;
    }
    const clip = this.resolveClipName(b, state.clip);
    if (!clip) return;
    this.playClipAction(b, clip, { speed: state.speed, loop: state.loop }, fade);
  }

  private playGraphState(b: Binding, stateName: string): void {
    if (!b.graph) return;
    const state = b.graph.states.find((s) => s.name === stateName);
    if (!state || state.clip === "") return;
    const clip = this.resolveClipName(b, state.clip);
    if (!clip) return;
    this.playClipAction(b, clip, { speed: state.speed, loop: state.loop }, 0);
  }

  /** 每帧推进：mixer 步进 + 图状态机评估过渡（exitTime + 参数条件） */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const b of this.bindings.values()) {
      if (b.playing && !b.paused) b.mixer.update(dt);
      this.evalGraph(b);
    }
  }

  private evalGraph(b: Binding): void {
    if (!b.graph || !b.graphState) return;
    const state = b.graph.states.find((s) => s.name === b.graphState);
    if (!state) return;
    // 退出时间：当前动作的归一化进度（无动作视为已满足）
    const action = this.currentClipAction(b);
    let normalized = 1;
    if (action && b.currentClip) {
      const clip = b.clips.find((c) => (c.name || "clip") === b.currentClip);
      const dur = clip?.duration ?? 0;
      normalized = dur > 0 ? Math.min(1, action.time / dur) : 1;
    }
    for (const tr of b.graph.transitions) {
      if (tr.from !== b.graphState) continue;
      if (tr.exitTime > 0 && normalized < tr.exitTime) continue;
      const ok = tr.conditions.every((c) => evalCondition(b.graph!.params[c.param], c));
      if (ok) {
        this.enterGraphState(b, tr.to, tr.duration);
        this.notify(b.nodeId);
        return; // 一帧只走一次过渡
      }
    }
  }

  // —— 运行时控制（不落盘）——

  /** 播放（单剪辑：当前/设定剪辑；图：当前/入口状态） */
  play(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    if (b.graph) {
      this.playGraphState(b, b.graphState ?? b.graph.entry);
    } else {
      const clip = b.currentClip ?? this.resolveClipName(b, "");
      if (clip) {
        const action = b.actions.get(clip)!;
        if (b.paused) {
          action.paused = false;
        } else if (!b.playing) {
          // 从停止态恢复：应用最近设置的速度/循环后重播
          this.applyClipParams(action, b.clipSettings);
          action.reset().play();
        }
        b.currentClip = clip;
        b.playing = true;
        b.paused = false;
      }
    }
    this.notify(nodeId);
  }

  /** 暂停（保持姿势，可继续） */
  pause(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    if (b.graph) {
      b.paused = true;
    } else {
      const action = this.currentClipAction(b);
      if (action) action.paused = true;
      b.paused = true;
    }
    this.notify(nodeId);
  }

  /** 停止（回到初始姿势） */
  stop(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    b.mixer.stopAllAction();
    b.currentClip = null;
    b.playing = false;
    b.paused = false;
    if (b.graph) b.graphState = b.graph.entry;
    this.notify(nodeId);
  }

  /** 单剪辑模式：手动指定播放剪辑（交叉淡化切换） */
  playClip(nodeId: string, clip: string, fade = 0.25): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    const settings: AnimClipSettings = { autoplay: true, clip, speed: 1, loop: "loop" };
    this.playClipAction(b, clip, settings, fade);
    this.notify(nodeId);
  }

  /** 图模式：手动切换到目标状态（交叉淡化，用于编辑器面板调试） */
  forceState(nodeId: string, stateName: string, fade = 0.2): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.graph) return;
    if (!b.graph.states.some((s) => s.name === stateName)) return;
    this.enterGraphState(b, stateName, fade);
    this.notify(nodeId);
  }

  /** 图模式：写运行时参数（条件过渡据此触发；不落盘） */
  setParam(nodeId: string, key: string, value: AnimGraphParamValue): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.graph) return;
    b.graph.params[key] = value;
    this.notify(nodeId);
  }

  /** 运行时状态快照（UI 展示当前剪辑/图状态/参数值） */
  stateFor(nodeId: string): AnimRuntimeState | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return {
      mode: b.graph ? "graph" : b.actions.size ? "clip" : "off",
      playing: b.playing && !b.paused,
      clip: b.currentClip,
      graphState: b.graphState,
      params: b.graph ? { ...b.graph.params } : {},
    };
  }

  /** 节点是否已建立动画绑定（模型就绪后才有） */
  isBound(nodeId: string): boolean {
    return this.bindings.has(nodeId);
  }

  // —— 骨骼辅助线（编辑器可视化）——

  /** 选中变化：仅被选中节点的骨骼辅助线显示 */
  setSelected(nodeId: string | null): void {
    this.selectedId = nodeId;
    this.refreshHelperVisibility();
  }

  /** 编辑器辅助物总开关（预览渲染时隐藏） */
  setOverlayVisible(visible: boolean): void {
    this.overlayVisible = visible;
    this.refreshHelperVisibility();
  }

  private refreshHelperVisibility(): void {
    for (const b of this.bindings.values()) {
      b.helperSelected = b.nodeId === this.selectedId;
      if (b.skeletonHelper) {
        b.skeletonHelper.visible = b.helperSelected && this.overlayVisible;
      }
    }
  }

  // —— 生命周期 ——

  /** 解除节点绑定（节点删除/场景替换时调用） */
  unbind(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    this.disposeBinding(b);
    this.bindings.delete(nodeId);
  }

  unbindAll(): void {
    for (const b of this.bindings.values()) this.disposeBinding(b);
    this.bindings.clear();
  }

  private disposeBinding(b: Binding): void {
    b.mixer.stopAllAction();
    b.mixer.uncacheRoot(b.root);
    if (b.skeletonHelper) {
      b.skeletonHelper.parent?.remove(b.skeletonHelper);
      b.skeletonHelper.dispose();
      b.skeletonHelper = null;
    }
  }

  dispose(): void {
    this.unbindAll();
    this.listeners.clear();
  }
}

/** 从任意 JSON 解析动画图（节点读取用；null = 无图） */
export { parseAnimGraph };
