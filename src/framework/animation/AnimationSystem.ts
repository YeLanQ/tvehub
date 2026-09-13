// ---------------------------------------------------------------------------
// 动画系统（引擎模块）：驱动模型网格的 AnimationMixer。
//
// 设计要点：
// - 绑定按节点 id 索引：同步器把“实例化模型根 + 剪辑列表”交给 syncNode，
//   系统据此建/重建 mixer；同一实例只应用设置差异（改速度/循环不重启播放），
//   实例被重建（模型重载/属性重建）时才整个重绑并回到初始状态；
// - 两级能力（见 types.ts）：单剪辑模式（MeshNode.anim 直控）与
//   动画图模式（MeshNode.animGraph 状态机：exitTime + 参数条件 → 交叉淡化过渡）；
// - 蒙皮完全控制（对应 three 官网 animation/skinning 系列示例，与运行时
//   public/engine/runtime/animation.mjs 镜像同语义）：动作级权重/淡入淡出/
//   一次性动作/事件、加法混合层、骨骼本地变换读写与复位、形态键权重、
//   CCD IK（目标 Bone 追加进骨架；mixer 之后求解并重算蒙皮包围球）；
// - 骨骼可视化：含骨骼的模型在节点被选中时显示 SkeletonHelper（可强制常显），
//   IK helper 随之显示；
// - 运行时控制（播放/暂停/参数/蒙皮调整）不落盘，只影响本会话；节点数据
//   （autoplay/clip/speed/loop/graph）才随场景序列化。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { CCDIKSolver, CCDIKHelper } from "three/examples/jsm/animation/CCDIKSolver.js";
import {
  cloneAnimGraph,
  evalCondition,
  parseAnimGraph,
  parseBoneBindings,
  type AnimClipSettings,
  type AnimGraph,
  type AnimGraphParamValue,
  type AnimLoopMode,
  type BoneBindingSpec,
} from "./types";

/** syncNode 需要的节点形状（避免依赖具体节点类；MeshNode 结构满足） */
export interface AnimatableNode {
  id: string;
  anim: AnimClipSettings;
  animGraph: AnimGraph | null;
  /** 骨骼/IK 目标绑定（随场景数据持久化；syncNode 时按此初始化/更新绑定） */
  boneBindings: BoneBindingSpec[];
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

/** 骨骼本地变换快照（rotation 为度制欧拉，与节点 transform 同度制） */
export interface BoneTransformSnapshot {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

/** 骨骼层级条目（parent 为骨骼名，根骨骼为 null） */
export interface BoneHierarchyEntry {
  name: string;
  parent: string | null;
  children: string[];
}

/** 形态键分组（某网格的全部形态键名） */
export interface MorphGroup {
  mesh: string;
  targets: string[];
}

/** 蒙皮能力摘要（面板条件渲染 + 脚本判断） */
export interface SkinInfo {
  boneCount: number;
  boneNames: string[];
  morphMeshes: number;
}

/** IK 链运行态条目 */
export interface IKEntry {
  id: string;
  name: string;
  effector: string;
  enabled: boolean;
}

/** addIK 定义（限位为度制欧拉数组；与 SDK IKDef 同形） */
export interface IKDefInput {
  name?: string;
  effector: string;
  links?: Array<{
    bone: string;
    rotationMin?: number[];
    rotationMax?: number[];
    enabled?: boolean;
  }>;
  iteration?: number;
}

/** 动画事件负载（finished/loop 回调参数） */
export interface AnimEventPayload {
  clip: string;
}

/** 骨骼绑定选项（attachObject 用） */
export interface BoneAttachOptions {
  /** 保持 attach 时刻的相对位姿（缺省 true；false = 对象原点对齐骨骼原点） */
  keepOffset?: boolean;
  /** 跟随骨骼旋转（缺省 true；false = 仅锚点位置跟随，姿态自主控制） */
  syncRotation?: boolean;
  /** 跟随骨骼缩放（缺省 false） */
  syncScale?: boolean;
}

/** 骨骼绑定运行态条目 */
export interface BoneAttachmentEntry {
  /** 目标节点 id（解析不到对象时为名称兜底） */
  node: string;
  bone: string;
  syncRotation: boolean;
  syncScale: boolean;
  keepOffset: boolean;
}

type AnimChangeListener = (nodeId: string) => void;
type AnimEventCallback = (e: AnimEventPayload) => void;

/** 骨骼绑定定义（node.boneBindings 的收敛形状；运行时叠加条目同形） */
type BoneAttachDef = BoneBindingSpec;

interface BoneAttachment extends BoneAttachDef {
  obj: THREE.Object3D;
  boneObj: THREE.Bone;
  offset: THREE.Matrix4;
}

interface IKRecord {
  id: string;
  name: string;
  solver: CCDIKSolver;
  /** 编辑器可视化（CCDIKHelper），挂场景根，随选中/辅助物开关显示 */
  helper: CCDIKHelper | null;
  targetBone: THREE.Bone;
  effector: string;
  enabled: boolean;
}

interface Binding {
  nodeId: string;
  root: THREE.Object3D;
  rootUuid: string;
  mixer: THREE.AnimationMixer;
  /** 剪辑名 → action（重名剪辑取首个） */
  actions: Map<string, THREE.AnimationAction>;
  clips: THREE.AnimationClip[];
  /** 加法层动作与 makeClipAdditive 转换缓存（clip 名 → …） */
  additiveActions: Map<string, THREE.AnimationAction>;
  additiveClips: Map<string, THREE.AnimationClip>;
  // —— 蒙皮通道（实例重绑时重建；快照即当时的加载姿势）——
  skinnedMeshes: THREE.SkinnedMesh[];
  skeleton: THREE.Skeleton | null;
  bones: THREE.Bone[];
  boneNames: string[];
  boneByName: Map<string, THREE.Bone>;
  boneNameOf: Map<THREE.Bone, string>;
  restPose: Map<THREE.Bone, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>;
  morphTable: Array<{ mesh: THREE.Mesh; name: string; dictionary: Record<string, number> }>;
  iks: IKRecord[];
  ikSeq: number;
  /** 骨骼/IK 目标绑定（attachObject 落 defs；attachments 为运行态，重绑按 defs 恢复） */
  attachDefs: BoneAttachDef[];
  attachments: BoneAttachment[];
  /** 进行中的一次性动作（finished 事件回落 base） */
  oneShot: { action: THREE.AnimationAction; base: THREE.AnimationAction | null; fade: number } | null;
  finishedCbs: Set<AnimEventCallback>;
  loopCbs: Set<AnimEventCallback>;
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
  /** 绑定数据签名（node.boneBindings 的 JSON；数据变更时重建绑定） */
  bindingsSig: string;
  skeletonHelper: THREE.SkeletonHelper | null;
  helperSelected: boolean;
  /** 调试面板强制显示骨骼辅助线（不选中也可看） */
  helperForced: boolean;
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** 有限数值收敛（非法回退 fallback） */
const fin = (v: number, fb: number): number => (Number.isFinite(v) ? v : fb);

/** mixer 事件分发（clip 名负载；回调异常不阻断动画推进） */
function dispatchAnimEvent(cbs: Set<AnimEventCallback>, action: THREE.AnimationAction): void {
  if (!cbs.size) return;
  const payload: AnimEventPayload = { clip: action.getClip()?.name ?? "" };
  for (const cb of [...cbs]) {
    try {
      cb(payload);
    } catch (err) {
      console.error("[animation] 动画事件回调异常:", err);
    }
  }
}

/** 一次性动作播完（finished）：淡出自身并淡回基础动作（官方 morph 示例模式） */
function restoreOneShot(b: Binding, action: THREE.AnimationAction): void {
  const os = b.oneShot;
  if (!os || os.action !== action) return;
  b.oneShot = null;
  action.fadeOut(os.fade);
  if (os.base && os.base !== action) os.base.fadeIn(os.fade);
}

/** 动作查找：同名剪辑的加法层优先（权重/淡入淡出/单动作控制指向已创建的层） */
function findAction(b: Binding, clip: string): THREE.AnimationAction | null {
  if (!clip) return null;
  return b.additiveActions.get(clip) ?? b.actions.get(clip) ?? null;
}

// —— 骨骼/IK 目标绑定（物体跟随骨骼；官方 ik 示例 target/挂点语义的通用化）——

const _attM1 = new THREE.Matrix4();
const _attM2 = new THREE.Matrix4();
const _attM3 = new THREE.Matrix4();
const _attV = new THREE.Vector3();
const _attQ = new THREE.Quaternion();
const _attS = new THREE.Vector3();

/**
 * 解析骨骼引用：骨骼名 → IK（id 或 name）→ "__ikTarget_<id>" 内部名。
 * IK 目标不在 boneByName（建表晚于 addIK），单独查记录。未命中 null。
 */
function resolveBone(b: Binding, name: string): THREE.Bone | null {
  if (!name) return null;
  const bone = b.boneByName.get(name);
  if (bone) return bone;
  const ik = b.iks.find((r) => r.id === name || r.name === name);
  if (ik) return ik.targetBone;
  if (name.startsWith("__ikTarget_")) {
    const id = name.slice("__ikTarget_".length);
    const rec = b.iks.find((r) => r.id === id);
    return rec ? rec.targetBone : null;
  }
  return null;
}

/** 目标对象合法性：非模型根自身/祖先/子树内（骨骼世界矩阵依赖树外对象才无反馈环） */
function attachmentTargetAllowed(b: Binding, obj: THREE.Object3D): boolean {
  if (!obj || obj === b.root) return false;
  for (let cur = b.root.parent; cur; cur = cur.parent) {
    if (cur === obj) return false;
  }
  for (let cur = obj.parent; cur; cur = cur.parent) {
    if (cur === b.root) return false;
  }
  return true;
}

/** 每帧应用绑定：把 boneWorld × offset 变换到目标对象（局部系分解） */
function updateAttachments(b: Binding): void {
  if (!b.attachments.length) return;
  for (const at of b.attachments) {
    const parent = at.obj.parent;
    if (!parent) continue;
    at.boneObj.updateWorldMatrix(true, false);
    _attM1.multiplyMatrices(at.boneObj.matrixWorld, at.offset);
    parent.updateWorldMatrix(true, false);
    _attM2.copy(parent.matrixWorld).invert();
    _attM3.multiplyMatrices(_attM2, _attM1);
    if (at.syncRotation) {
      if (at.syncScale) {
        _attM3.decompose(at.obj.position, at.obj.quaternion, at.obj.scale);
      } else {
        _attM3.decompose(_attV, _attQ, _attS);
        at.obj.position.copy(_attV);
        at.obj.quaternion.copy(_attQ);
      }
    } else {
      // 仅跟随锚点位置（骨骼坐标系下的 attach 时相对偏移），姿态保持自身控制
      _attM3.decompose(_attV, _attQ, _attS);
      at.obj.position.copy(_attV);
    }
  }
}

export class AnimationSystem {
  private bindings = new Map<string, Binding>();
  private listeners = new Set<AnimChangeListener>();
  /** 编辑器辅助物总开关（预览渲染时隐藏骨骼辅助线） */
  private overlayVisible = true;
  private selectedId: string | null = null;
  /** 场景节点 id → three 对象解析（attachObject 用；引擎构造时注入） */
  private targetResolver: ((nodeId: string) => THREE.Object3D | null) | null = null;
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

  /** 注入场景节点对象解析器（attachObject 按节点 id 找目标对象；引擎构造时调用） */
  setTargetResolver(fn: (nodeId: string) => THREE.Object3D | null): void {
    this.targetResolver = fn;
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
      // 绑定数据可能被节点补丁改写（面板增删绑定）：签名不同则重建绑定
      const sig = JSON.stringify(node.boneBindings ?? []);
      if (sig !== existing.bindingsSig) {
        existing.bindingsSig = sig;
        existing.attachDefs = parseBoneBindings(node.boneBindings);
        existing.attachments = [];
        this.restoreAttachments(existing);
      }
      this.applySettings(existing, node);
      return;
    }
    // 实例重建：骨骼绑定改为数据驱动（node.boneBindings），运行时叠加 defs 丢弃
    if (existing) this.disposeBinding(existing);

    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of clips) {
      const name = clip.name || "clip";
      if (!actions.has(name)) {
        const action = mixer.clipAction(clip);
        // 权重默认清零：混合面板以 0 为“未参与”，播放路径显式回到 1
        action.setEffectiveWeight(0);
        actions.set(name, action);
      }
    }
    // —— 蒙皮通道：骨骼 / 形态键 ——
    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes.push(o as THREE.SkinnedMesh);
    });
    const skeleton = skinnedMeshes[0]?.skeleton ?? null;
    const bones: THREE.Bone[] = [];
    const boneNames: string[] = [];
    const boneByName = new Map<string, THREE.Bone>();
    const boneNameOf = new Map<THREE.Bone, string>();
    const restPose = new Map<
      THREE.Bone,
      { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }
    >();
    if (skeleton) {
      for (const bone of skeleton.bones) {
        const name = bone.name || `bone${bones.length}`;
        bones.push(bone);
        boneNames.push(name);
        if (!boneByName.has(name)) boneByName.set(name, bone);
        if (!boneNameOf.has(bone)) boneNameOf.set(bone, name);
        restPose.set(bone, {
          position: bone.position.clone(),
          quaternion: bone.quaternion.clone(),
          scale: bone.scale.clone(),
        });
      }
    }
    const morphTable: Binding["morphTable"] = [];
    root.traverse((o) => {
      // 形态键常见于骨骼挂接的表情网格（不一定是 SkinnedMesh），扫全部网格
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        morphTable.push({
          mesh,
          name: mesh.name || `mesh${morphTable.length}`,
          dictionary: mesh.morphTargetDictionary,
        });
      }
    });

    const binding: Binding = {
      nodeId: node.id,
      root,
      rootUuid: root.uuid,
      mixer,
      actions,
      clips,
      additiveActions: new Map(),
      additiveClips: new Map(),
      skinnedMeshes,
      skeleton,
      bones,
      boneNames,
      boneByName,
      boneNameOf,
      restPose,
      morphTable,
      iks: [],
      ikSeq: 0,
      attachDefs: parseBoneBindings(node.boneBindings),
      attachments: [],
      bindingsSig: JSON.stringify(node.boneBindings ?? []),
      oneShot: null,
      finishedCbs: new Set(),
      loopCbs: new Set(),
      hasSkeleton: skeleton !== null,
      currentClip: null,
      clipSettings: { ...node.anim },
      playing: false,
      paused: false,
      graph: null,
      graphSig: "",
      graphState: null,
      skeletonHelper: null,
      helperSelected: false,
      helperForced: false,
    };
    mixer.addEventListener("finished", (e) => {
      restoreOneShot(binding, e.action);
      dispatchAnimEvent(binding.finishedCbs, e.action);
      this.notify(binding.nodeId);
    });
    mixer.addEventListener("loop", (e) => {
      dispatchAnimEvent(binding.loopCbs, e.action);
    });
    // 骨骼辅助线挂在场景根上（其 matrix 引用模型根 matrixWorld，随节点变换；
    // 仅选中且辅助物可见时显示，调试面板可强制常显）
    if (binding.hasSkeleton) {
      const helper = new THREE.SkeletonHelper(root);
      helper.name = "__skelHelper";
      helper.visible = false;
      const host = this.sceneRoot ?? root.parent;
      if (host) host.add(helper);
      binding.skeletonHelper = helper;
    }
    this.bindings.set(node.id, binding);
    this.applySettings(binding, node);
    this.restoreAttachments(binding);
  }

  /** 按 attachDefs 恢复骨骼绑定（绑定重建/模型实例重载后调用） */
  private restoreAttachments(b: Binding): void {
    for (const def of [...b.attachDefs]) {
      b.attachments = b.attachments.filter((at) => at.target !== def.target);
      if (def.target) this.buildAttachment(b, def);
    }
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
    target.setEffectiveWeight(1);
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

  /** 每帧推进：mixer 步进 → IK 求解 → 骨骼绑定跟随 → 图状态机评估过渡（exitTime + 参数条件） */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const b of this.bindings.values()) {
      if (b.playing && !b.paused) b.mixer.update(dt);
      this.updateIK(b);
      updateAttachments(b);
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
          action.setEffectiveWeight(1);
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

  /** 停止（回到初始姿势；含加法层/一次性动作） */
  stop(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    b.mixer.stopAllAction();
    b.currentClip = null;
    b.playing = false;
    b.paused = false;
    b.oneShot = null;
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

  // —— 蒙皮完全控制（与运行时 animation.mjs 镜像同语义；全部不落盘）——

  /** 蒙皮能力摘要（骨骼数/形态键网格数；未绑定 null） */
  skinInfoOf(nodeId: string): SkinInfo | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return {
      boneCount: b.bones.length,
      boneNames: [...b.boneNames],
      morphMeshes: b.morphTable.length,
    };
  }

  // —— 动作级控制（官方 blending/morph 模式）——

  /** 动作权重（setEffectiveWeight；确保动作在播，权重 0 即静默层） */
  setWeight(nodeId: string, clip: string, w: number): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    a.enabled = true;
    a.setEffectiveWeight(clamp01(fin(w, 0)));
    if (!a.isRunning()) a.play();
    b.playing = true;
    this.notify(nodeId);
    return true;
  }

  /** 动作当前有效权重（含淡入淡出进行中的值） */
  getWeight(nodeId: string, clip: string): number | null {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    return a ? a.getEffectiveWeight() : null;
  }

  /** 权重 0→1 淡入（官方 fadeToAction 的进入侧） */
  fadeIn(nodeId: string, clip: string, dur: number): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    a.enabled = true;
    if (!a.isRunning()) a.play();
    a.fadeIn(Math.max(0, fin(dur, 0.25)));
    b.playing = true;
    this.notify(nodeId);
    return true;
  }

  /** 权重→0 淡出（可淡到 None；动作本身不停止） */
  fadeOut(nodeId: string, clip: string, dur: number): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    a.fadeOut(Math.max(0, fin(dur, 0.25)));
    this.notify(nodeId);
    return true;
  }

  /** 交叉淡化 from→to（warp=true 时自动对齐相位；官方 setWeight 辅助模式） */
  crossFade(nodeId: string, from: string, to: string, dur: number, warp: boolean): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    const fa = findAction(b, from);
    const ta = findAction(b, to);
    if (!fa || !ta || fa === ta) return false;
    ta.enabled = true;
    ta.setEffectiveTimeScale(1);
    ta.setEffectiveWeight(1);
    ta.time = 0;
    if (!fa.isRunning()) fa.play();
    if (!ta.isRunning()) ta.play();
    fa.crossFadeTo(ta, Math.max(0, fin(dur, 0.25)), warp === true);
    if (b.actions.has(to)) b.currentClip = to;
    b.playing = true;
    this.notify(nodeId);
    return true;
  }

  /** 单动作播放速度（setEffectiveTimeScale；与 globalSpeed 相乘生效） */
  setActionSpeed(nodeId: string, clip: string, scale: number): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    a.setEffectiveTimeScale(Math.max(0, fin(scale, 1)));
    this.notify(nodeId);
    return true;
  }

  /** 单动作循环模式（"loop"/"once"/"pingpong"；once 定格末帧） */
  setActionLoop(nodeId: string, clip: string, mode: AnimLoopMode): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    const { loop, clamp } = threeLoopOf(mode);
    a.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    a.clampWhenFinished = clamp;
    this.notify(nodeId);
    return true;
  }

  /** 停止单个动作（与 stop 区分：不影响其他混合层） */
  stopAction(nodeId: string, clip: string): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    if (b.oneShot?.action === a) b.oneShot = null;
    a.stop();
    if (b.currentClip === clip) b.currentClip = null;
    this.notify(nodeId);
    return true;
  }

  /**
   * 一次性动作（官方 morph 表情模式）：LoopOnce+clamp 定格末帧，当前动作淡出，
   * mixer finished 后自动淡出该动作并淡回基础动作。
   */
  playOneShot(nodeId: string, clip: string, fade: number): boolean {
    const b = this.bindings.get(nodeId);
    const a = b ? findAction(b, clip) : null;
    if (!b || !a) return false;
    const f = Math.max(0, fin(fade, 0.25));
    // 仍在进行的前一个一次性动作直接停掉（其回落已无意义）
    if (b.oneShot && b.oneShot.action !== a) {
      b.oneShot.action.stop();
      b.oneShot = null;
    }
    const base = b.currentClip ? (b.actions.get(b.currentClip) ?? null) : null;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    if (base && base !== a && base.isRunning()) base.fadeOut(f);
    a.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(f).play();
    b.oneShot = { action: a, base: base && base !== a ? base : null, fade: f };
    b.playing = true;
    this.notify(nodeId);
    return true;
  }

  /** 全局播放速度（mixer.timeScale；与单动作速度相乘） */
  globalSpeed(nodeId: string, scale: number): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    b.mixer.timeScale = Math.max(0, fin(scale, 1));
    this.notify(nodeId);
    return true;
  }

  /** 订阅动作播完事件（LoopOnce 到达末帧；负载 {clip}），返回注销函数 */
  onFinished(nodeId: string, cb: AnimEventCallback): () => void {
    const b = this.bindings.get(nodeId);
    if (!b) return () => {};
    b.finishedCbs.add(cb);
    return () => b.finishedCbs.delete(cb);
  }

  /** 订阅动作循环事件（LoopRepeat 每圈 / PingPong 半圈；负载 {clip}） */
  onLoop(nodeId: string, cb: AnimEventCallback): () => void {
    const b = this.bindings.get(nodeId);
    if (!b) return () => {};
    b.loopCbs.add(cb);
    return () => b.loopCbs.delete(cb);
  }

  // —— 加法层（官方 additive_blending 模式）——

  /** 惰性取加法层动作：makeClipAdditive 转换缓存后按 Additive 混合模式创建 */
  private additiveActionOf(b: Binding, clip: string): THREE.AnimationAction | null {
    let action = b.additiveActions.get(clip);
    if (action) return action;
    const source = b.clips.find((c) => (c.name || "clip") === clip);
    if (!source) return null;
    let converted = b.additiveClips.get(clip);
    if (!converted) {
      converted =
        source.blendMode === THREE.AdditiveAnimationBlendMode
          ? source
          : THREE.AnimationUtils.makeClipAdditive(source);
      b.additiveClips.set(clip, converted);
    }
    action = b.mixer.clipAction(converted, undefined, THREE.AdditiveAnimationBlendMode);
    b.additiveActions.set(clip, action);
    return action;
  }

  /** 以加法混合叠加播放剪辑（权重独立于基础层） */
  playAdditive(nodeId: string, clip: string, weight: number): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    const a = this.additiveActionOf(b, clip);
    if (!a) return false;
    a.reset().play();
    a.setEffectiveWeight(clamp01(fin(weight, 1)));
    b.playing = true;
    this.notify(nodeId);
    return true;
  }

  /** 停止加法层动作（转换缓存保留，重复播放不再重转换） */
  stopAdditive(nodeId: string, clip: string): boolean {
    const b = this.bindings.get(nodeId);
    const a = b && clip ? b.additiveActions.get(clip) : null;
    if (!b || !a) return false;
    a.stop();
    this.notify(nodeId);
    return true;
  }

  // —— 骨骼级控制 ——

  /** 骨骼名列表（骨架扁平顺序；未绑定/无骨骼返回 null/[]） */
  bonesOf(nodeId: string): string[] | null {
    const b = this.bindings.get(nodeId);
    return b ? [...b.boneNames] : null;
  }

  /** 骨骼层级（[{name,parent,children}]；parent 为骨骼名或 null） */
  boneHierarchy(nodeId: string): BoneHierarchyEntry[] | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return b.bones.map((bone) => {
      const parentBone = bone.parent as THREE.Bone | null;
      const parent = parentBone?.isBone ? (b.boneNameOf.get(parentBone) ?? null) : null;
      const children: string[] = [];
      for (const child of bone.children) {
        if ((child as THREE.Bone).isBone) {
          const n = b.boneNameOf.get(child as THREE.Bone);
          if (n) children.push(n);
        }
      }
      return { name: b.boneNameOf.get(bone) ?? "", parent, children };
    });
  }

  /** 骨骼本地变换快照（rotation 为度制欧拉；未命中 null） */
  getBoneTransform(nodeId: string, name: string): BoneTransformSnapshot | null {
    const b = this.bindings.get(nodeId);
    const bone = b?.boneByName.get(name);
    if (!b || !bone) return null;
    const deg = THREE.MathUtils.radToDeg;
    const v3 = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
    return {
      position: v3(bone.position),
      rotation: { x: deg(bone.rotation.x), y: deg(bone.rotation.y), z: deg(bone.rotation.z) },
      scale: v3(bone.scale),
    };
  }

  /** 骨骼本地位移（注意：动作播放中 mixer 每帧覆写被驱动骨骼） */
  setBonePosition(nodeId: string, name: string, x: number, y: number, z: number): boolean {
    const b = this.bindings.get(nodeId);
    const bone = b?.boneByName.get(name);
    if (!b || !bone) return false;
    bone.position.set(fin(x, 0), fin(y, 0), fin(z, 0));
    return true;
  }

  /** 骨骼本地旋转（度制欧拉，与节点 transform 同度制） */
  setBoneRotation(nodeId: string, name: string, x: number, y: number, z: number): boolean {
    const b = this.bindings.get(nodeId);
    const bone = b?.boneByName.get(name);
    if (!b || !bone) return false;
    const rad = THREE.MathUtils.degToRad;
    bone.rotation.set(rad(fin(x, 0)), rad(fin(y, 0)), rad(fin(z, 0)));
    return true;
  }

  /** 骨骼本地缩放 */
  setBoneScale(nodeId: string, name: string, x: number, y: number, z: number): boolean {
    const b = this.bindings.get(nodeId);
    const bone = b?.boneByName.get(name);
    if (!b || !bone) return false;
    bone.scale.set(fin(x, 1), fin(y, 1), fin(z, 1));
    return true;
  }

  /** 复位单个骨骼到绑定姿势 */
  resetBone(nodeId: string, name: string): boolean {
    const b = this.bindings.get(nodeId);
    const bone = b?.boneByName.get(name);
    const snap = bone && b ? b.restPose.get(bone) : undefined;
    if (!b || !bone || !snap) return false;
    bone.position.copy(snap.position);
    bone.quaternion.copy(snap.quaternion);
    bone.scale.copy(snap.scale);
    this.notify(nodeId);
    return true;
  }

  /** 复位全部骨骼到绑定姿势（快照恢复，等价加载时姿势） */
  resetPose(nodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b || !b.restPose.size) return false;
    for (const [bone, snap] of b.restPose) {
      bone.position.copy(snap.position);
      bone.quaternion.copy(snap.quaternion);
      bone.scale.copy(snap.scale);
    }
    this.notify(nodeId);
    return true;
  }

  /** 骨骼世界坐标（attach 物体/瞄准参考；名字可传 IK id/IK 名。未命中 null） */
  getBoneWorldPosition(nodeId: string, name: string): { x: number; y: number; z: number } | null {
    const b = this.bindings.get(nodeId);
    const bone = b ? resolveBone(b, name) : null;
    if (!b || !bone) return null;
    bone.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    return { x: p.x, y: p.y, z: p.z };
  }

  // —— 骨骼/IK 目标绑定（物体跟随骨骼；官方 ik 示例挂点语义）——

  /** 组建单条绑定（解析目标对象与骨骼、计算相对偏移；失败 false 不入列） */
  private buildAttachment(b: Binding, def: BoneAttachDef): boolean {
    const targetObj = def.target
      ? (this.targetResolver?.(def.target) ?? null)
      : null;
    if (!targetObj) return false;
    const boneObj = resolveBone(b, def.bone);
    if (!boneObj || !attachmentTargetAllowed(b, targetObj)) return false;
    const at: BoneAttachment = { ...def, obj: targetObj, boneObj, offset: new THREE.Matrix4() };
    if (def.keepOffset) {
      // attach 时刻的相对位姿：boneWorld⁻¹ × objWorld（骨骼带动下保持刚性相对关系）
      boneObj.updateWorldMatrix(true, false);
      targetObj.updateWorldMatrix(true, false);
      at.offset.copy(boneObj.matrixWorld).invert().multiply(targetObj.matrixWorld);
    }
    // 同一目标重复 attach = 改绑（先解除旧绑定）
    b.attachments = b.attachments.filter((a) => a.obj !== targetObj);
    b.attachments.push(at);
    return true;
  }

  /**
   * 运行时叠加一条骨骼绑定（数据源见 node.boneBindings：syncNode 按节点数据
   * 初始化绑定；本方法叠加的 def 不落盘，实例重绑后不保留）。
   * bone 传骨骼名、IK id 或 IK name；opts 见 BoneAttachOptions。成功返回 true。
   */
  attachObject(nodeId: string, targetNodeId: string, bone: string, opts: BoneAttachOptions = {}): boolean {
    const b = this.bindings.get(nodeId);
    if (!b || !targetNodeId || !bone) return false;
    const def: BoneAttachDef = {
      target: targetNodeId,
      bone,
      keepOffset: opts.keepOffset !== false,
      syncRotation: opts.syncRotation !== false,
      syncScale: opts.syncScale === true,
    };
    if (!this.buildAttachment(b, def)) return false;
    b.attachDefs = b.attachDefs.filter((d) => d.target !== targetNodeId);
    b.attachDefs.push(def);
    this.notify(nodeId);
    return true;
  }

  /** 解除节点绑定（未绑定返回 false） */
  detachObject(nodeId: string, targetNodeId: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    const before = b.attachments.length;
    b.attachments = b.attachments.filter((at) => at.target !== targetNodeId);
    const defs = b.attachDefs.length;
    b.attachDefs = b.attachDefs.filter((d) => d.target !== targetNodeId);
    if (b.attachments.length !== before || b.attachDefs.length !== defs) {
      this.notify(nodeId);
      return true;
    }
    return false;
  }

  /** 绑定清单（[{node, bone, syncRotation, syncScale, keepOffset}]） */
  attachmentsOf(nodeId: string): BoneAttachmentEntry[] {
    const b = this.bindings.get(nodeId);
    if (!b) return [];
    return b.attachments.map((at) => ({
      node: at.target,
      bone: at.bone,
      syncRotation: at.syncRotation,
      syncScale: at.syncScale,
      keepOffset: at.keepOffset,
    }));
  }

  // —— 形态键（官方 morph 表情滑块语义）——

  /** 形态键清单（[{mesh, targets}]；未绑定 null） */
  morphsOf(nodeId: string): MorphGroup[] | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return b.morphTable.map((m) => ({ mesh: m.name, targets: Object.keys(m.dictionary) }));
  }

  /** 形态键权重写入（0..1；mesh 空则取首个含该目标的网格） */
  setMorphWeight(nodeId: string, mesh: string, target: string, v: number): boolean {
    const b = this.bindings.get(nodeId);
    if (!b || !target) return false;
    const entry =
      (mesh ? b.morphTable.find((m) => m.name === mesh) : undefined) ??
      b.morphTable.find((m) => target in m.dictionary);
    if (!entry || !(target in entry.dictionary)) return false;
    const influences = entry.mesh.morphTargetInfluences;
    if (!influences) return false;
    influences[entry.dictionary[target]] = clamp01(fin(v, 0));
    return true;
  }

  /** 形态键权重读取（未命中 null） */
  getMorphWeight(nodeId: string, mesh: string, target: string): number | null {
    const b = this.bindings.get(nodeId);
    if (!b || !target) return null;
    const entry =
      (mesh ? b.morphTable.find((m) => m.name === mesh) : undefined) ??
      b.morphTable.find((m) => target in m.dictionary);
    if (!entry || !(target in entry.dictionary)) return null;
    return entry.mesh.morphTargetInfluences?.[entry.dictionary[target]] ?? null;
  }

  // —— IK（官方 skinning_ik，CCD 求解）——

  /**
   * 注册 IK 链（限位度制）：目标点由引擎创建并作为 Bone 追加进骨架（求解器从
   * skeleton.bones 取 target/effector），挂模型根下（局部空间）。编辑器侧同时
   * 创建可视化 helper（挂场景根，随选中显示）。成功返回 IK id，失败 false。
   */
  addIK(nodeId: string, def: IKDefInput): string | false {
    const b = this.bindings.get(nodeId);
    if (!b || !b.skeleton || !def || typeof def !== "object" || !def.effector) return false;
    const effector = b.boneByName.get(def.effector);
    if (!effector) return false;
    const mesh = b.skinnedMeshes.find((m) => m.skeleton === b.skeleton);
    if (!mesh) return false;
    b.ikSeq += 1;
    const id = `ik${b.ikSeq}`;
    // 目标 Bone：不参与蒙皮（无 skinIndex 引用），仅提供 matrixWorld 给求解器；
    // 追加进 skeleton.bones（boneInverses 同步补位）而不动 boneMatrices（渲染
    // 不会读到该索引，OOB 写入被 TypedArray 静默忽略）。
    const targetBone = new THREE.Bone();
    targetBone.name = `__ikTarget_${id}`;
    b.root.add(targetBone);
    b.skeleton.bones.push(targetBone);
    b.skeleton.boneInverses.push(new THREE.Matrix4());
    const toRad = THREE.MathUtils.degToRad;
    const limit = (v: number[] | undefined): THREE.Vector3 | undefined => {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(x))) return undefined;
      return new THREE.Vector3(v[0], v[1], v[2]).multiplyScalar(toRad(1));
    };
    const links: CCDIKSolver["iks"][number]["links"] = [];
    for (const l of Array.isArray(def.links) ? def.links : []) {
      const bone = l && typeof l.bone === "string" ? b.boneByName.get(l.bone) : undefined;
      if (!bone) continue;
      const link: CCDIKSolver["iks"][number]["links"][number] = {
        index: b.bones.indexOf(bone),
        enabled: l.enabled !== false,
      };
      const rmin = limit(l.rotationMin);
      if (rmin) link.rotationMin = rmin;
      const rmax = limit(l.rotationMax);
      if (rmax) link.rotationMax = rmax;
      links.push(link);
    }
    const config = {
      target: b.skeleton.bones.length - 1,
      effector: b.bones.indexOf(effector),
      links,
      iteration: def.iteration === undefined ? 1 : Math.max(1, Math.floor(fin(def.iteration, 1))),
    };
    const solver = new CCDIKSolver(mesh, [config]);
    let helper: CCDIKHelper | null = null;
    if (this.sceneRoot) {
      helper = solver.createHelper();
      helper.visible = false;
      this.sceneRoot.add(helper);
    }
    const rec: IKRecord = {
      id,
      name: def.name && def.name.trim() ? def.name : id,
      solver,
      helper,
      targetBone,
      effector: def.effector,
      enabled: true,
    };
    b.iks.push(rec);
    this.refreshHelperVisibility();
    this.notify(nodeId);
    return id;
  }

  /** 移除 IK（solver 不再更新；目标 Bone 保留在骨架中维持索引稳定） */
  removeIK(nodeId: string, id: string): boolean {
    const b = this.bindings.get(nodeId);
    if (!b) return false;
    const i = b.iks.findIndex((r) => r.id === id);
    if (i < 0) return false;
    const [rec] = b.iks.splice(i, 1);
    if (rec.helper) {
      rec.helper.parent?.remove(rec.helper);
      rec.helper.dispose();
    }
    this.notify(nodeId);
    return true;
  }

  /** IK 启停（官方示例 GUI checkbox 语义） */
  setIKEnabled(nodeId: string, id: string, v: boolean): boolean {
    const b = this.bindings.get(nodeId);
    const rec = b && b.iks.find((r) => r.id === id);
    if (!b || !rec) return false;
    rec.enabled = v === true;
    this.notify(nodeId);
    return true;
  }

  /** 目标点位置（模型根局部空间） */
  setIKTargetPosition(nodeId: string, id: string, x: number, y: number, z: number): boolean {
    const b = this.bindings.get(nodeId);
    const rec = b && b.iks.find((r) => r.id === id);
    if (!b || !rec) return false;
    rec.targetBone.position.set(fin(x, 0), fin(y, 0), fin(z, 0));
    return true;
  }

  /** 目标点位置读取（未命中 null） */
  getIKTargetPosition(nodeId: string, id: string): { x: number; y: number; z: number } | null {
    const b = this.bindings.get(nodeId);
    const rec = b && b.iks.find((r) => r.id === id);
    if (!b || !rec) return null;
    const p = rec.targetBone.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /** IK 清单（[{id,name,effector,enabled}]） */
  iksOf(nodeId: string): IKEntry[] | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return b.iks.map((r) => ({ id: r.id, name: r.name, effector: r.effector, enabled: r.enabled }));
  }

  /** 每帧 IK 求解（mixer 之后调用；求解过的绑定重算蒙皮包围球防误剔除） */
  private updateIK(b: Binding): void {
    if (!b.iks.length) return;
    let ran = false;
    for (const rec of b.iks) {
      if (!rec.enabled) continue;
      rec.solver.update();
      ran = true;
    }
    if (ran) {
      for (const mesh of b.skinnedMeshes) mesh.computeBoundingSphere();
    }
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

  /** 调试面板强制显示骨骼辅助线（不选中也可看） */
  setBoneHelperVisible(nodeId: string, v: boolean): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    b.helperForced = v === true;
    this.refreshHelperVisibility();
  }

  private refreshHelperVisibility(): void {
    for (const b of this.bindings.values()) {
      b.helperSelected = b.nodeId === this.selectedId;
      const show = (b.helperSelected || b.helperForced) && this.overlayVisible;
      if (b.skeletonHelper) {
        b.skeletonHelper.visible = show;
      }
      for (const rec of b.iks) {
        if (rec.helper) rec.helper.visible = show;
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
    b.attachments = [];
    if (b.skeletonHelper) {
      b.skeletonHelper.parent?.remove(b.skeletonHelper);
      b.skeletonHelper.dispose();
      b.skeletonHelper = null;
    }
    for (const rec of b.iks) {
      if (rec.helper) {
        rec.helper.parent?.remove(rec.helper);
        rec.helper.dispose();
      }
    }
    b.iks = [];
  }

  dispose(): void {
    this.unbindAll();
    this.listeners.clear();
  }
}

/** 从任意 JSON 解析动画图（节点读取用；null = 无图） */
export { parseAnimGraph };
