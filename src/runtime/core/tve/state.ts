// ---------------------------------------------------------------------------
// 共享可变状态与基础工具函数（所有 tve 子模块的唯一事实来源）。
// host / 注册表 Map / 序号 / 输入状态集中持有；组件函数经 state 注入解耦
// （entity.mjs 不直接导入 component-registry / runtime，打破循环依赖）。
// ---------------------------------------------------------------------------
import type * as THREE from "../three.module.min.js";
import type { Entity } from "./entity";
import type {
  RigidBody,
  Collider,
  AudioSource,
  AnimationClip,
  SkeletalAnimation,
} from "./component-facades";
import type { Light } from "./component-light";

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const EPS = 1e-6;

// ---------------------------------------------------------------------------
// 引擎自有基础类型（SDK 契约镜像；消费面最小结构，见 framework/scripting/tve.d.ts）
// ---------------------------------------------------------------------------

/** 三维向量（引擎自有类型；旋转型 Vec3 使用"度"为单位） */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 向量类入参（SDK 容错视图：缺分量/非法值经 numOr 按 0 收敛） */
export interface Vec3Input {
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

/** 组件 JSON 通用字段（场景文档节点 components[] 条目；私有字段经索引签名放行） */
export interface ComponentJson {
  /** 组件 id（运行时创建的内置组件为生成 id） */
  id?: string;
  type?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** 场景节点 JSON（运行时只读视图；形状对齐编辑器节点序列化） */
export interface NodeJson {
  /** 节点 id（tve SDK 实体寻址；根/内部对象可能缺省） */
  id?: string;
  /** 节点类型（meshNode/cameraNode/fsmRunnerNode/…） */
  type?: string;
  name?: string;
  tag?: string;
  components?: ComponentJson[];
  [key: string]: unknown;
}

/** buildSceneTree 全节点注册表条目（json + three 对象；文档序） */
export interface SceneNodeEntry {
  json: NodeJson;
  obj: THREE.Object3D;
}

/** 脚本组件实例（宿主实例化的脚本对象；字段开放） */
export type ScriptInstance = Record<string, unknown>;

/** 脚本类静态形状（装饰器元数据挂在构造器上，见 scripts.ts 同名接口） */
export interface ScriptKlass {
  new (entity: unknown): Record<string, unknown>;
  prototype: object;
  name: string;
  /** 原始类名（编译期注入的静态字段；下游压缩混淆改写 name 后按名解析锚点） */
  __tveClassName?: string;
}

/** 内置组件门面实例联合（component-registry 注册的六类） */
export type BuiltinFacade =
  | RigidBody
  | Collider
  | Light
  | AudioSource
  | AnimationClip
  | SkeletalAnimation;

// ---------------------------------------------------------------------------
// 运行时宿主（installRuntime 注入）的各子系统控制面 —— 按本目录消费面声明的
// 最小结构接口；真实后端见 runtime/*（animations/audios/physics/clipAnims/
// particles/terrains/ui/logic），字段以"门面/引擎 API 读写了什么"为准。
// ---------------------------------------------------------------------------

/** 逻辑运行器状态快照（引擎自有形状） */
export interface LogicStateInfo {
  id: string;
  name: string;
  time: number;
}

/** 行为树动作叶子（脚本可见子集） */
export interface BtActionLeaf {
  id: string;
  action: string;
  node: unknown;
}

/** 行为树动作求值会话（seq 随重启自增） */
export interface BtActionSession {
  seq: number;
}

/** 行为树动作处理器（返回 "success"/"failure"/"running"，缺省 success） */
export type BtActionHandler = (leaf: BtActionLeaf, session: BtActionSession) => string | void;

/** 状态进入/退出回调（match 为空 = 任意状态） */
export type FsmStateCb = (state: LogicStateInfo) => void;

/** 逻辑运行器控制面（状态机/行为树；createLogic 产物，按节点 id 寻址） */
export interface LogicHostApi {
  fsmStateOf(nodeId: string): LogicStateInfo | null;
  fire(nodeId: string, event: string): unknown;
  setFsmParam(nodeId: string, name: string, value: number | boolean): unknown;
  getFsmParam(nodeId: string, name: string): number | boolean | undefined;
  forceState(nodeId: string, state: string): unknown;
  onFsmEnter(nodeId: string, match: string, cb: FsmStateCb): () => void;
  onFsmExit(nodeId: string, match: string, cb: FsmStateCb): () => void;
  onFsmTransition(nodeId: string, cb: (from: LogicStateInfo, to: LogicStateInfo) => void): () => void;
  btStatusOf(nodeId: string): string | null;
  setBtParam(nodeId: string, name: string, value: number | boolean): unknown;
  getBtParam(nodeId: string, name: string): number | boolean | undefined;
  onAction(nodeId: string, name: string, handler: BtActionHandler): () => void;
  setRunning(nodeId: string, running: boolean): unknown;
  restart(nodeId: string): unknown;
}

/** 相机渲染控制（CameraNode.screenToRay 转发） */
export interface CameraHostApi {
  screenToRay(screenX: number, screenY: number): { origin: Vec3; direction: Vec3 } | null;
}

/** 物理体信息（脚本 SDK getComponent("rigidBody") 门面数据源） */
export interface PhysicsBodyInfo {
  mode: string;
  gravityScale: number;
  colliderCount: number;
}

/** 物理射线命中结果（世界空间） */
export interface PhysicsRayHit {
  nodeId: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/** 物理控制面（按节点 id 寻址；方法返回值门面只做真值判断，放宽为 unknown） */
export interface PhysicsHostApi {
  applyImpulse(nodeId: string, x: number, y: number, z: number): unknown;
  applyForce(nodeId: string, x: number, y: number, z: number): unknown;
  setLinearVelocity(nodeId: string, x: number, y: number, z: number): unknown;
  setAngularVelocity(nodeId: string, x: number, y: number, z: number): unknown;
  getLinearVelocity(nodeId: string): Vec3 | null;
  bodyInfo(nodeId: string): PhysicsBodyInfo | null;
  setGravityScale(nodeId: string, scale: number): unknown;
  wakeUp(nodeId: string): unknown;
  setGravity(x: number, y: number, z: number): unknown;
  /** Worker 模式返回 Promise（engine.physics.castRay 原样透传） */
  castRay(options: unknown): PhysicsRayHit[] | Promise<PhysicsRayHit[]>;
}

/** 音源运行态（AudioSource 门面 playing/paused/ready 数据源） */
export interface AudioInfo {
  playing: boolean;
  paused: boolean;
  ready: boolean;
}

/** 音频控制面（按节点/音源 key 寻址） */
export interface AudiosHostApi {
  play(key: string): unknown;
  stop(key: string): unknown;
  pause(key: string): unknown;
  resume(key: string): unknown;
  setVolume(key: string, volume: number): unknown;
  addSource(
    json: { id?: string; audio?: unknown; [key: string]: unknown },
    obj: THREE.Object3D,
    nodeId?: string,
  ): unknown;
  updateSettings(key: string, patch: unknown): unknown;
  infoOf(key: string): AudioInfo | null;
}

/** 关键帧动画剪辑绑定（AnimationClip 门面数据源；animclip.ts ClipBinding 的消费面视图） */
export interface ClipBinding {
  /** .anim 资产相对路径 */
  clipPath?: string;
  clip?: { duration?: number; [key: string]: unknown } | null;
  time?: number;
  speed?: number;
  loop?: boolean;
  autoplay?: boolean;
  playing?: boolean;
  paused?: boolean;
  [key: string]: unknown;
}

/** 关键帧动画剪辑控制面（animclip.ts ClipAnimApi 的消费面视图；按组件 id 寻址） */
export interface ClipAnimsHostApi {
  add(entry: {
    key: string;
    obj: THREE.Object3D;
    clip: string;
    autoplay: boolean;
    loop: boolean;
    speed: number;
  }): unknown;
  bindingOf(key: unknown): ClipBinding | null;
  changeClip(b: ClipBinding | null, rel: unknown): unknown;
  setTime(b: ClipBinding | null, t: unknown): unknown;
  setSpeed(b: ClipBinding | null, s: unknown): unknown;
  setLoop(b: ClipBinding | null, v: unknown): unknown;
  setAutoplay(b: ClipBinding | null, v: unknown): unknown;
  play(b: ClipBinding | null): unknown;
  pause(b: ClipBinding | null): unknown;
  resume(b: ClipBinding | null): unknown;
  stop(b: ClipBinding | null): unknown;
}

/** 动画图状态（SkeletalAnimation 图活对象；states/transitions 运行期可直接改写） */
export interface AnimStateEntry {
  name: string;
  clip: string;
  speed?: number;
  loop?: string;
}

/** 动画图过渡（conditions 的 op/value 由引擎收敛，门面写入侧放宽） */
export interface AnimTransitionEntry {
  id: string;
  from: string;
  to: string;
  duration?: number;
  exitTime?: number;
  conditions?: { param: string; op: unknown; value: unknown }[];
}

/** 动画图活对象（AnimGraphDef 的运行期视图） */
export interface AnimGraph {
  entry?: string;
  states: AnimStateEntry[];
  transitions: AnimTransitionEntry[];
  params: Record<string, number | boolean>;
  [key: string]: unknown;
}

/** 骨骼动画绑定（SkeletalAnimation 门面数据源；nodeJson.anim 为节点设置视图） */
export interface AnimBinding {
  currentClip?: string | null;
  playing?: boolean;
  nodeJson?: {
    anim?: { speed?: unknown; loop?: string; autoplay?: unknown; [key: string]: unknown };
    [key: string]: unknown;
  } | null;
  graph?: AnimGraph | null;
  [key: string]: unknown;
}

/** 蒙皮能力摘要 */
export interface SkinInfo {
  boneCount: number;
  boneNames: string[];
  morphMeshes: number;
}

/** 骨骼本地变换快照（rotation 为度制欧拉） */
export interface BoneTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
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

/** IK 链运行态条目 */
export interface IKEntry {
  id: string;
  name: string;
  effector: string;
  enabled: boolean;
}

/** 骨骼绑定运行态条目 */
export interface BoneAttachmentEntry {
  node: string;
  bone: string;
  syncRotation: boolean;
  syncScale: boolean;
  keepOffset: boolean;
}

/** 动画事件负载（finished/loop 回调参数） */
export interface AnimEventPayload {
  clip: string;
}

/** 模型动画控制面（engine.animation + SkeletalAnimation 门面的后端） */
export interface AnimationsHostApi {
  play(nodeId: string, clip?: string): unknown;
  stop(nodeId: string): unknown;
  pause(nodeId: string): unknown;
  resume(nodeId: string): unknown;
  setSpeed(nodeId: string, v: number): unknown;
  setLoop(nodeId: string, v: string): unknown;
  setAutoplay(nodeId: string, v: boolean): unknown;
  setParam(nodeId: string, name: string, value: number | boolean): unknown;
  applyGraph(nodeId: string, def: unknown): unknown;
  removeGraph(nodeId: string): unknown;
  applyAnim(nodeId: string, anim: Record<string, unknown>): unknown;
  bindingOf(nodeId: string): AnimBinding | null;
  clipsOf(nodeId: string): string[];
  skinInfoOf(nodeId: string): SkinInfo | null;
  setWeight(nodeId: string, clip: string, w: number): unknown;
  getWeight(nodeId: string, clip: string): number | null;
  fadeIn(nodeId: string, clip: string, dur?: number): unknown;
  fadeOut(nodeId: string, clip: string, dur?: number): unknown;
  crossFade(nodeId: string, from: string, to: string, dur?: number, warp?: boolean): unknown;
  setActionSpeed(nodeId: string, clip: string, scale: number): unknown;
  setActionLoop(nodeId: string, clip: string, mode: string): unknown;
  stopAction(nodeId: string, clip: string): unknown;
  playOneShot(nodeId: string, clip: string, fade?: number): unknown;
  globalSpeed(nodeId: string, scale: number): unknown;
  onFinished(nodeId: string, cb: (e: AnimEventPayload) => void): () => void;
  onLoop(nodeId: string, cb: (e: AnimEventPayload) => void): () => void;
  playAdditive(nodeId: string, clip: string, weight?: number): unknown;
  stopAdditive(nodeId: string, clip: string): unknown;
  bonesOf(nodeId: string): string[];
  boneHierarchy(nodeId: string): BoneHierarchyEntry[];
  getBoneTransform(nodeId: string, name: string): BoneTransform | null;
  setBonePosition(nodeId: string, name: string, x: number, y: number, z: number): unknown;
  setBoneRotation(nodeId: string, name: string, x: number, y: number, z: number): unknown;
  setBoneScale(nodeId: string, name: string, x: number, y: number, z: number): unknown;
  resetBone(nodeId: string, name: string): unknown;
  resetPose(nodeId: string): unknown;
  getBoneWorldPosition(nodeId: string, name: string): Vec3 | null;
  morphsOf(nodeId: string): MorphGroup[];
  setMorphWeight(nodeId: string, mesh: string, target: string, v: number): unknown;
  getMorphWeight(nodeId: string, mesh: string, target: string): number | null;
  addIK(nodeId: string, def: unknown): string | null;
  removeIK(nodeId: string, ikId: string): unknown;
  setIKEnabled(nodeId: string, ikId: string, v: boolean): unknown;
  setIKTargetPosition(nodeId: string, ikId: string, x: number, y: number, z: number): unknown;
  getIKTargetPosition(nodeId: string, ikId: string): Vec3 | null;
  iksOf(nodeId: string): IKEntry[];
  attachObject(nodeId: string, obj: THREE.Object3D, bone: string, opts: unknown): unknown;
  detachObject(nodeId: string, obj: THREE.Object3D): unknown;
  attachmentsOf(nodeId: string): BoneAttachmentEntry[];
}

/** 粒子系统运行态 */
export interface ParticleState {
  playing: boolean;
  paused: boolean;
  finished: boolean;
  alive: number;
  [key: string]: unknown;
}

/** 粒子发射设置（ParticleSystemNode 门面读写；字段经节点属性访问器按键索引） */
export interface ParticleSettings {
  [key: string]: unknown;
}

/** 粒子系统控制面（按节点 id 寻址） */
export interface ParticlesHostApi {
  play(nodeId: string): unknown;
  pause(nodeId: string): unknown;
  stop(nodeId: string): unknown;
  restart(nodeId: string): unknown;
  clear(nodeId: string): unknown;
  infoOf(nodeId: string): ParticleState | null;
  settingsOf(nodeId: string): ParticleSettings | null;
  updateSettings(nodeId: string, patch: unknown): unknown;
}

/** 地形设置快照（SDK 只读视图；字段见 tve.d.ts TerrainSettingsSnapshot） */
export type TerrainSettingsSnapshot = Record<string, unknown>;

/** 地形控制面（TerrainNode 贴地采样转发） */
export interface TerrainsHostApi {
  sampleHeight(nodeId: string, x: number, z: number): number;
  sampleSlope(nodeId: string, x: number, z: number): number;
  settingsOf(nodeId: string): TerrainSettingsSnapshot | null;
}

/** UI Widget/画布设置快照（编辑器序列化设置；ui-api 与 UI 节点访问器按键索引） */
export interface UiSettings {
  scaleMode?: string;
  designWidth?: number;
  designHeight?: number;
  [key: string]: unknown;
}

/** UI 矩形（画布局部空间：原点 = 画布中心，y 向上；单位 = UI 单位） */
export interface UiRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** UI 控制面（engine.ui 与 UI 节点门面的后端；按节点 id 寻址） */
export interface UiHostApi {
  updateSettings(nodeId: string, patch: unknown): unknown;
  settingsOf(nodeId: string): UiSettings | null;
  onClick(nodeId: string, cb: () => void): () => void;
  offClick(nodeId: string, cb: () => void): unknown;
}

/** 脚本组件动态创建（entity.addComponent 脚本分支转发；scripts.ts 装配） */
export interface ScriptsHostApi {
  spawn(
    entity: { id: string },
    tokenOrClass: unknown,
    props?: unknown,
  ): Record<string, unknown> | null;
}

/** 运行时宿主接线与全部可变状态的唯一持有处（TveHost；installRuntime 注入） */
export interface TveHost {
  /** buildSceneTree 全节点注册表（json + obj；文档序） */
  registry: SceneNodeEntry[];
  /** 场景根对象（空场景 null） */
  rootObj: THREE.Object3D | null;
  /** 预览画布（指针输入安装） */
  canvas: PointerCanvas | null;
  /** 渲染相机控制（CameraNode.screenToRay 转发） */
  camera: CameraHostApi | null;
  /** 模型动画控制（engine.animation / SkeletalAnimation 门面转发） */
  animations: AnimationsHostApi | null;
  /** 音频控制（engine.audio / AudioSource 门面转发） */
  audios: AudiosHostApi | null;
  /** 物理控制（engine.physics / RigidBody 门面转发） */
  physics: PhysicsHostApi | null;
  /** 关键帧动画剪辑控制（AnimationClip 门面转发） */
  clipAnims: ClipAnimsHostApi | null;
  /** 粒子系统控制（engine.particles / ParticleSystemNode 转发） */
  particles: ParticlesHostApi | null;
  /** 地形系统（TerrainNode 贴地采样转发） */
  terrains: TerrainsHostApi | null;
  /** UI 运行时控制（engine.ui / UI 节点门面转发） */
  ui: UiHostApi | null;
  /** 逻辑运行器控制（engine.logic 转发） */
  logic: LogicHostApi | null;
  /** 脚本组件动态创建（entity.addComponent 脚本分支转发） */
  scripts: ScriptsHostApi | null;
}

/** 指针触点状态（主指针与多点触点共用；坐标 = 画布内 CSS 像素） */
export interface PointerState {
  x: number;
  y: number;
  down: boolean;
  pointerId: number;
}

/** 每帧时间状态（engine.time 视图） */
export interface TimeState {
  delta: number;
  elapsed: number;
  frame: number;
}

/** 键盘按下回调 */
export type KeyHandler = (key: string) => void;
/** 指针事件回调（down/up/cancel/move 共用负载形状） */
export type PointerHandler = (pointer: PointerState) => void;
/** 内置组件类型键解析（类/字符串 token → 类型键；未知 null） */
export type BuiltinTypeKeyOf = (token: unknown) => string | null;

export const state = {
  host: null as TveHost | null,
  entityByObj: new Map<THREE.Object3D, Entity>(),
  componentsByNode: new Map<string, ScriptInstance[]>(),
  scriptClassByPath: new Map<string, ScriptKlass>(),
  scriptClassByName: new Map<string, ScriptKlass>(),
  builtinByNode: new Map<string, Map<string, BuiltinFacade>>(),
  runtimeCompSeq: 0,
  timeState: { delta: 0, elapsed: 0, frame: 0 } as TimeState,
  heldKeys: new Set<string>(),
  keyDownHandlers: new Set<KeyHandler>(),
  keyUpHandlers: new Set<KeyHandler>(),
  /** 主指针（最后活跃触点；pointerId = -1 表示尚未有任何指针事件） */
  pointerState: { x: 0, y: 0, down: false, pointerId: -1 } as PointerState,
  /** 按下中的触点（pointerId → 状态；鼠标也是一个触点） */
  pointersById: new Map<number, PointerState>(),
  pointerDownHandlers: new Set<PointerHandler>(),
  pointerUpHandlers: new Set<PointerHandler>(),
  pointerCancelHandlers: new Set<PointerHandler>(),
  pointerMoveHandlers: new Set<PointerHandler>(),
  inputInstalled: false,
  // 注入的组件函数（由 component-registry / runtime 设置；entity 经 state 调用）
  builtinTypeKeyOf: null as BuiltinTypeKeyOf | null,
  builtinFacadeOf: null as ((entity: Entity, typeKey: string) => BuiltinFacade | null) | null,
  createRuntimeBuiltin: null as ((
    entity: Entity,
    typeKey: string,
    settings: unknown,
  ) => BuiltinFacade | null) | null,
  resolveScriptInstance: null as ((nodeId: string, token: string) => unknown) | null,
};

export const EMPTY_REGISTRY: SceneNodeEntry[] = [];

export function registry(): SceneNodeEntry[] {
  return state.host ? state.host.registry : EMPTY_REGISTRY;
}

export function isNodeObj(obj: THREE.Object3D | null | undefined): obj is THREE.Object3D {
  return !!obj && typeof obj.userData?.nodeId === "string" && obj.userData.nodeId !== "";
}

export function numOr(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

export function nextRuntimeCompId(): string {
  state.runtimeCompSeq += 1;
  return `comp_rt${state.runtimeCompSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nodeJsonOf(id: string): NodeJson | null {
  const entry = registry().find((r) => r.json && r.json.id === id);
  return entry ? entry.json : null;
}

export function componentJsonOf(nodeJson: NodeJson | null, typeKey: string): ComponentJson | null {
  const comps = Array.isArray(nodeJson?.components) ? nodeJson.components : [];
  return comps.find((c) => c && c.type === typeKey && c.enabled !== false) ?? null;
}

export function pushComponentJson(nodeJson: NodeJson, comp: ComponentJson): void {
  if (!Array.isArray(nodeJson.components)) nodeJson.components = [];
  nodeJson.components.push(comp);
}

export function normalizeScriptPath(token: string): string {
  let p = String(token).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.js$/i, ".ts");
  if (!p.startsWith("src/")) p = "src/" + p;
  return p;
}

export function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** 节点 id → 脚本组件实例列表（宿主注册；getComponent 用） */
export function scriptComponentsOf(nodeId: string): ScriptInstance[] | undefined {
  return state.componentsByNode.get(nodeId);
}

/** 指针输入画布（DOM Canvas 的最小消费面；桥接层按平台注入等价对象） */
export interface PointerCanvas {
  style: { touchAction: string } & Record<string, unknown>;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(type: string, cb: (e: never) => void, options?: boolean): void;
  [key: string]: unknown;
}
