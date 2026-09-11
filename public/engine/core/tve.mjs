// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 运行时（模块说明符 "tve"）。
// 类型契约见 src/framework/scripting/tve.d.ts（两者保持镜像同步；本文件是
// 播放器侧实现，编辑器侧不加载本模块）。
//
// 设计约束：
// - 对用户脚本只暴露引擎自有类型（Vec3 普通对象 / 度制欧拉角，与编辑器
//   数据模型一致），不暴露任何 three.js 接口；three 对象仅在本模块内部使用；
// - 本模块不主动启动：由 scripts.mjs（脚本宿主）经 installRuntime 注入
//   场景注册表与动画控制后，engine 各接口才可用（未注入时安全空转）。
// ---------------------------------------------------------------------------
import * as THREE from "./three.module.min.js";
import { postLog } from "./log.mjs";
import { buildComponentLight } from "./lights.mjs";

export const VERSION = "1.3.0";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------------------
// 运行时宿主接线（scripts.mjs 安装；所有引擎状态的唯一持有处）
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TveHost 宿主接线（由 scripts.mjs 提供）
 * @property {Array<{json: object, obj: THREE.Object3D}>} registry 全节点注册表
 * @property {THREE.Object3D|null} rootObj 场景根
 * @property {HTMLCanvasElement|null} canvas 预览画布（指针输入坐标基准）
 * @property {{play,stop,pause,resume,bindingOf,clipsOf,reapply,applyAnim,applyGraph,removeGraph,setSpeed,setLoop,setAutoplay,setParam}|null} animations 动画控制（按节点 id 寻址）
 * @property {{play,stop,pause,resume,setVolume,addSource,updateSettings,infoOf}|null} audios 音频控制（按节点 id / 组件 id 寻址）
 * @property {{bindingOf,play,pause,resume,stop,setTime,setSpeed,setLoop,setAutoplay,changeClip,add}|null} clipAnims 关键帧动画剪辑控制（按组件 id 寻址）
 * @property {{play,pause,stop,restart,clear,infoOf,settingsOf,updateSettings}|null} particles 粒子系统控制（按节点 id 寻址）
 * @property {{spawn(entity, tokenOrClass, props?): object|null}|null} scripts 脚本组件动态创建（getComponent 字段 get-or-create / addComponent 用）
 */

/** @type {TveHost|null} */
let host = null;

/** three 对象 → Entity 句柄缓存（同一对象恒返回同一句柄） */
const entityByObj = new Map();

/** 节点 id → Component 实例列表（宿主注册；getComponent 用） */
const componentsByNode = new Map();

/** 脚本类注册表（单一程序集语义：脚本加载即全项目可见）。
 *  按源路径（src/**.ts）与类名双键注册，getComponent/addComponent/组件字段
 *  解析按 token 命中，脚本之间无需 import 即可互相引用组件类型。 */
const scriptClassByPath = new Map();
const scriptClassByName = new Map();

/** 节点 id → (组件类型键 → 门面实例)（内置组件句柄缓存） */
const builtinByNode = new Map();

/** 空对象（宿主未注入时的安全兜底） */
const EMPTY_REGISTRY = [];

function registry() {
  return host ? host.registry : EMPTY_REGISTRY;
}

/**
 * 是否为场景节点对象（nodes.mjs 构建时打 userData.nodeId 标记；
 * 灯光实例/模型挂载点等 three 内部子对象不带标记，不作为实体暴露）。
 */
function isNodeObj(obj) {
  return !!obj && typeof obj.userData?.nodeId === "string" && obj.userData.nodeId !== "";
}

/** three 对象 → Entity 子类实例（按 userData.nodeKind 映射节点类型类；非节点对象返回 null） */
export function getEntity(obj) {
  if (!isNodeObj(obj) || !host) return null;
  let e = entityByObj.get(obj);
  if (!e) {
    const kind = typeof obj.userData?.nodeKind === "string" ? obj.userData.nodeKind : "";
    const Cls = kind && KIND_CLASSES[kind] ? KIND_CLASSES[kind] : Entity;
    e = new Cls(obj);
    entityByObj.set(obj, e);
  }
  return e;
}

/** 按节点 id 解析场景实体（host 注册表；节点引用属性的运行期求值） */
export function resolveNodeEntity(nodeId) {
  if (!host || typeof nodeId !== "string" || !nodeId) return null;
  const entry = (host.registry || []).find((r) => r.json && r.json.id === nodeId);
  return entry ? getEntity(entry.obj) : null;
}

/** 宿主注册组件实例（getComponent 查询用；scriptRel 为脚本源路径，
 *  打在实例的隐藏标记上供按路径/类名查找） */
export function registerComponent(nodeId, instance, scriptRel) {
  if (instance && typeof scriptRel === "string" && scriptRel) {
    Object.defineProperty(instance, "__tveScript", {
      value: scriptRel,
      configurable: true,
      writable: true,
    });
  }
  let list = componentsByNode.get(nodeId);
  if (!list) {
    list = [];
    componentsByNode.set(nodeId, list);
  }
  list.push(instance);
}

/** 脚本类注册（宿主在脚本模块加载后调用；路径与类名双键，类名先到先得） */
export function registerScriptClass(srcRel, klass) {
  if (typeof srcRel !== "string" || !srcRel || typeof klass !== "function") return;
  scriptClassByPath.set(srcRel, klass);
  if (klass.name && !scriptClassByName.has(klass.name)) {
    scriptClassByName.set(klass.name, klass);
  }
}

/** 脚本路径收敛："./a/b.js" / "a/b" → "src/a/b.ts"（注册表键形态） */
function normalizeScriptPath(token) {
  let p = String(token).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.js$/i, ".ts");
  if (!p.startsWith("src/")) p = "src/" + p;
  return p;
}

/** 按脚本类查找注册表中的类：token = 类（原样）/ 源路径 / 类名；未命中 null */
export function resolveScriptClass(token) {
  if (typeof token === "function") return { klass: token, srcRel: "" };
  if (typeof token !== "string" || !token) return null;
  if (token.includes("/") || /\.(ts|js)$/i.test(token)) {
    const p = normalizeScriptPath(token);
    const klass = scriptClassByPath.get(p);
    return klass ? { klass, srcRel: p } : null;
  }
  const klass = scriptClassByName.get(token);
  return klass ? { klass, srcRel: "" } : null;
}

/** 实体上按脚本源路径 / 脚本类名查找已挂载的脚本组件实例（未挂载 null） */
export function resolveScriptInstance(nodeId, token) {
  const list = componentsByNode.get(nodeId);
  if (!list || typeof token !== "string" || !token) return null;
  if (token.includes("/") || /\.(ts|js)$/i.test(token)) {
    const p = normalizeScriptPath(token);
    return list.find((c) => c.__tveScript === p) ?? null;
  }
  const byName = list.find((c) => c.constructor && c.constructor.name === token);
  if (byName) return byName;
  const klass = scriptClassByName.get(token);
  return klass ? list.find((c) => c instanceof klass) ?? null : null;
}

/**
 * 安装运行时宿主（scripts.mjs 在实例化脚本前调用一次）。
 * @param {TveHost} api
 */
export function installRuntime(api) {
  host = api;
  entityByObj.clear();
  componentsByNode.clear();
  builtinByNode.clear();
  scriptClassByPath.clear();
  scriptClassByName.clear();
  installInputListeners();
}

// ---------------------------------------------------------------------------
// 时间 / 输入状态
// ---------------------------------------------------------------------------

const timeState = { delta: 0, elapsed: 0, frame: 0 };

/** 每帧推进（scripts.mjs 在调用 onUpdate 前驱动） */
export function tickTime(dt) {
  timeState.delta = dt > 0 && Number.isFinite(dt) ? dt : 0;
  timeState.elapsed += timeState.delta;
  timeState.frame += 1;
}

const heldKeys = new Set();
const keyDownHandlers = new Set();
const keyUpHandlers = new Set();

const pointerState = { x: 0, y: 0, down: false };
const pointerDownHandlers = new Set();
const pointerUpHandlers = new Set();
const pointerMoveHandlers = new Set();

let inputInstalled = false;

/** 键盘/指针监听（随 installRuntime 一次性安装；页面级生命周期无需卸载） */
function installInputListeners() {
  if (inputInstalled) return;
  inputInstalled = true;

  window.addEventListener("keydown", (e) => {
    if (!heldKeys.has(e.code)) {
      heldKeys.add(e.code);
      keyDownHandlers.forEach((fn) => fn(e.code));
    }
  });
  window.addEventListener("keyup", (e) => {
    if (heldKeys.delete(e.code)) keyUpHandlers.forEach((fn) => fn(e.code));
  });
  // 画布失焦时清空按住状态，避免切页后"卡键"
  window.addEventListener("blur", () => heldKeys.clear());

  const canvas = host && host.canvas;
  if (!canvas) return;
  const sync = (e) => {
    if (e && typeof e.offsetX === "number") {
      pointerState.x = e.offsetX;
      pointerState.y = e.offsetY;
    }
  };
  canvas.addEventListener("pointerdown", (e) => {
    sync(e);
    pointerState.down = true;
    pointerDownHandlers.forEach((fn) => fn({ ...pointerState }));
  });
  canvas.addEventListener("pointerup", (e) => {
    sync(e);
    pointerState.down = false;
    pointerUpHandlers.forEach((fn) => fn({ ...pointerState }));
  });
  canvas.addEventListener("pointermove", (e) => {
    sync(e);
    pointerMoveHandlers.forEach((fn) => fn({ ...pointerState }));
  });
}

// ---------------------------------------------------------------------------
// 日志（参数格式化 → 编辑器控制台转发 + 浏览器控制台）
// ---------------------------------------------------------------------------

function formatArgs(args) {
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

// ---------------------------------------------------------------------------
// Entity：节点句柄（three 对象的引擎语义包装）
// ---------------------------------------------------------------------------

function toVec3(v) {
  return { x: v.x, y: v.y, z: v.z };
}

/** 写入部分字段（仅接受有限数值，其余保持原值） */
function applyVec3(target, src) {
  if (!src || typeof src !== "object") return;
  for (const k of ["x", "y", "z"]) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) target[k] = v;
  }
}

/** 子树内按名称深度优先查找（只匹配节点对象，跳过灯光实例等内部子对象） */
function deepFind(obj, name) {
  for (const child of obj.children) {
    if (isNodeObj(child) && child.name === name) return child;
    const hit = deepFind(child, name);
    if (hit) return hit;
  }
  return null;
}

class Entity {
  /** @param {THREE.Object3D} obj（不在场景树内的对象由宿主保证不传入） */
  constructor(obj) {
    this.__obj = obj;
  }

  get id() {
    return String(this.__obj.userData.nodeId ?? "");
  }

  /** 节点类型键（与场景序列化 type 一致：node/meshNode/pointLightNode…） */
  get kind() {
    const k = this.__obj.userData?.nodeKind;
    return typeof k === "string" ? k : "";
  }

  get name() {
    return this.__obj.name ?? "";
  }
  set name(value) {
    if (typeof value === "string" && value) this.__obj.name = value;
  }

  /** 节点标签（编辑器检查器设置，随场景序列化） */
  get tag() {
    const t = this.__obj.userData?.nodeTag;
    return typeof t === "string" ? t : "";
  }

  /** 渲染层级索引（0~31；写入应用到对象子树的渲染层） */
  get layer() {
    const l = this.__obj.userData?.nodeLayer;
    return typeof l === "number" && Number.isFinite(l) ? Math.round(l) : 0;
  }
  set layer(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const i = Math.min(31, Math.max(0, Math.round(n)));
    this.__obj.layers.set(i);
    this.__obj.traverse((o) => {
      // 灯光对象自带 cullingMask 语义，不随节点层覆盖
      if (o.isLight !== true) o.layers.set(i);
    });
    this.__obj.userData.nodeLayer = i;
  }

  get visible() {
    return this.__obj.visible === true;
  }
  set visible(value) {
    this.__obj.visible = value === true;
  }

  get position() {
    return toVec3(this.__obj.position);
  }
  set position(value) {
    applyVec3(this.__obj.position, value);
  }

  /** 度制欧拉角（与编辑器数据模型一致；内部转弧度） */
  get rotation() {
    const r = this.__obj.rotation;
    return { x: r.x * R2D, y: r.y * R2D, z: r.z * R2D };
  }
  set rotation(value) {
    const r = this.__obj.rotation;
    if (!value || typeof value !== "object") return;
    r.order = "XYZ";
    if (typeof value.x === "number" && Number.isFinite(value.x)) r.x = value.x * D2R;
    if (typeof value.y === "number" && Number.isFinite(value.y)) r.y = value.y * D2R;
    if (typeof value.z === "number" && Number.isFinite(value.z)) r.z = value.z * D2R;
  }

  get scale() {
    return toVec3(this.__obj.scale);
  }
  set scale(value) {
    applyVec3(this.__obj.scale, value);
  }

  get worldPosition() {
    const v = new THREE.Vector3();
    this.__obj.getWorldPosition(v);
    return toVec3(v);
  }

  get parent() {
    const p = this.__obj.parent;
    // 父为 three.Scene（根节点）或内部对象 → 无父实体
    return isNodeObj(p) ? getEntity(p) : null;
  }

  get children() {
    return this.__obj.children.filter(isNodeObj).map((c) => getEntity(c)).filter(Boolean);
  }

  translate(x, y, z) {
    this.__obj.position.x += numOr(x, 0);
    this.__obj.position.y += numOr(y, 0);
    this.__obj.position.z += numOr(z, 0);
  }

  /** 度制旋转叠加 */
  rotate(xDeg, yDeg, zDeg) {
    const r = this.__obj.rotation;
    r.x += numOr(xDeg, 0) * D2R;
    r.y += numOr(yDeg, 0) * D2R;
    r.z += numOr(zDeg, 0) * D2R;
  }

  lookAt(target) {
    if (!target || typeof target !== "object") return;
    this.__obj.lookAt(numOr(target.x, 0), numOr(target.y, 0), numOr(target.z, 0));
    // three 对非 Camera 对象的 lookAt 是 +Z 朝向目标；引擎契约前向 = -Z
    //（tve.d.ts：与灯光/相机朝向约定一致），非相机对象绕 Y 转 180° 校正。
    if (!this.__obj.isCamera) this.__obj.rotateY(Math.PI);
  }

  /** 名称路径（a/b/c）精确行走；单名称或路径失配时子树深度优先查找 */
  find(nameOrPath) {
    if (typeof nameOrPath !== "string" || !nameOrPath.trim()) return null;
    const parts = nameOrPath.split("/").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    let cur = this.__obj;
    for (let i = 0; i < parts.length; i++) {
      const next = cur.children.find((c) => isNodeObj(c) && c.name === parts[i]);
      if (!next) {
        // 失配：首个名称退化为子树深度查找
        if (i !== 0) return null;
        const hit = deepFind(cur, parts[0]);
        return hit ? getEntity(hit) : null;
      }
      cur = next;
    }
    return getEntity(cur);
  }

  /**
   * 获取实体上挂载的组件（未挂载返回 null）。
   * - 内置组件：传门面类（RigidBody/Light/AudioSource/AnimationClip/
   *   SkeletalAnimation/Collider）或类型键字符串（"rigidBody" 等；"animation"/
   *   "anim" 为骨骼动画别名）。多实例组件（如多个动画剪辑组件）取首个，句柄稳定；
   * - 脚本组件：传脚本类（构造器）按类匹配；或传脚本源路径 / 类名字符串
   *   （"src/hp.ts" / "HPBar"，按类型名查找——脚本间无需 import）。
   */
  getComponent(componentClass) {
    const typeKey = builtinTypeKeyOf(componentClass);
    if (typeKey) return builtinFacadeOf(this, typeKey);
    if (typeof componentClass === "function") {
      const list = componentsByNode.get(this.id);
      if (!list) return null;
      return list.find((c) => c instanceof componentClass) ?? null;
    }
    if (typeof componentClass === "string") {
      return resolveScriptInstance(this.id, componentClass);
    }
    return null;
  }

  /**
   * 动态添加组件并返回实例/门面（预览运行态生效，不回写场景文件）：
   * - 内置组件 Light / AudioSource / AnimationClip：在本节点追加一个新组件
   *   （多实例）；settings 为组件设置对象（缺省项回默认）；
   * - 内置组件 SkeletalAnimation：仅模型网格节点可用，settings 可含 clip/
   *   autoplay/speed/loop/graph（graph 为动画图定义，创建即生效）；
   * - 脚本组件：传脚本类（构造器）或脚本源路径 / 类名字符串，在本实体上
   *   实例化并立即进入生命周期（onEnable/onStart）；settings 作为属性配置；
   * - RigidBody / Collider：物理组件仅启动期构建，运行时创建返回 null。
   */
  addComponent(componentClass, settings) {
    const typeKey = builtinTypeKeyOf(componentClass);
    if (!typeKey) {
      if (typeof componentClass === "function" || typeof componentClass === "string") {
        return host?.scripts?.spawn?.(this, componentClass, settings) ?? null;
      }
      postLog("warn", "[tve] addComponent 仅支持内置组件或脚本组件类型");
      return null;
    }
    if (typeKey === "rigidBody" || typeKey === "collider") {
      postLog("warn", "[tve] 运行时不支持动态创建物理组件（请在编辑器中为节点挂载）");
      return null;
    }
    return createRuntimeBuiltin(this, typeKey, settings);
  }
}

function numOr(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

// ---------------------------------------------------------------------------
// 内置组件门面：getComponent(组件类/类型键) 的返回对象，也是 @property(组件类)
// 与裸组件字段声明（public anim: AnimationClip）的运行期绑定对象。
// 门面 = 组件引用 JSON（场景数据）+ 运行时后端（three 对象/动画/音频/物理）
// 的实时视图；属性写入即时生效（预览运行态，不回写场景文件）。
// ---------------------------------------------------------------------------

const LIGHT_KINDS = ["point", "directional", "spot", "ambient"];
const LOOP_MODES = ["loop", "once", "pingpong"];
const CONDITION_OPS = [">", "<", ">=", "<=", "==", "!="];

let runtimeCompSeq = 0;
function nextRuntimeCompId() {
  runtimeCompSeq += 1;
  return `comp_rt${runtimeCompSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 节点 id → 节点 JSON（registry 查找；未命中 null） */
function nodeJsonOf(id) {
  const entry = registry().find((r) => r.json && r.json.id === id);
  return entry ? entry.json : null;
}

/** 节点 JSON 中首个启用的指定类型组件引用（无则 null） */
function componentJsonOf(nodeJson, typeKey) {
  const comps = Array.isArray(nodeJson?.components) ? nodeJson.components : [];
  return comps.find((c) => c && c.type === typeKey && c.enabled !== false) ?? null;
}

/** 运行时创建的组件引用并入节点 JSON（预览运行态；重载预览即失效） */
function pushComponentJson(nodeJson, comp) {
  if (!Array.isArray(nodeJson.components)) nodeJson.components = [];
  nodeJson.components.push(comp);
}

/** 门面基类：承装实体句柄 / 组件类型键 / 组件引用 JSON */
class BuiltinComponent {
  constructor(entity, typeKey, json) {
    this.entity = entity;
    this.type = typeKey;
    this.__json = json ?? null;
  }

  /** 组件引用 id（运行时创建的为 comp_rt* 生成 id；场景组件为其序列化 id） */
  get id() {
    return String(this.__json?.id ?? "");
  }
}

/** 刚体组件门面（只读信息 + 物理控制方法；运行时不可创建，编辑器挂载生效） */
class RigidBody extends BuiltinComponent {
  /** 刚体形态：static（隐式静态）/ kinematic（运动学）/ dynamic（动力学） */
  get mode() {
    return host?.physics?.bodyInfo(this.entity.id)?.mode ?? "dynamic";
  }
  get gravityScale() {
    return host?.physics?.bodyInfo(this.entity.id)?.gravityScale ?? 1;
  }
  get colliderCount() {
    return host?.physics?.bodyInfo(this.entity.id)?.colliderCount ?? 0;
  }
  setGravityScale(s) {
    physicsApi.setGravityScale(this.entity, s);
  }
  setLinearVelocity(x, y, z) {
    physicsApi.setLinearVelocity(this.entity, x, y, z);
  }
  getLinearVelocity() {
    return physicsApi.getLinearVelocity(this.entity);
  }
  applyImpulse(x, y, z) {
    physicsApi.applyImpulse(this.entity, x, y, z);
  }
  wakeUp() {
    physicsApi.wakeUp(this.entity);
  }
}

/** 碰撞体组件门面（只读信息；形状/表面材质编辑在检查器进行，运行时不可变） */
class Collider extends BuiltinComponent {
  /** 场景中命中的碰撞形状（box/sphere/capsule/cylinder/convex） */
  get shape() {
    return this.__json?.collider?.shape ?? "box";
  }
  /** 是否传感器（只产生触发不产生碰撞响应） */
  get isSensor() {
    return this.__json?.collider?.isSensor === true;
  }
  get friction() {
    return numOr(this.__json?.collider?.friction, 0.6);
  }
  get restitution() {
    return numOr(this.__json?.collider?.restitution, 0.1);
  }
  /** 物理世界中的碰撞体数量 */
  get count() {
    return host?.physics?.bodyInfo(this.entity.id)?.colliderCount ?? 0;
  }
}

/** 灯光组件门面：设置写入组件 JSON 并同步活动灯光对象（类型切换重建灯光） */
class Light extends BuiltinComponent {
  __settings() {
    return this.__json && typeof this.__json.light === "object" ? this.__json.light : null;
  }
  __lightObj() {
    const group = this.entity.__obj.getObjectByName("__compLight");
    let light = null;
    if (group) group.traverse((o) => { if (!light && o.isLight) light = o; });
    return light;
  }
  get enabled() {
    return this.__json ? this.__json.enabled !== false : true;
  }
  set enabled(v) {
    if (!this.__json) return;
    this.__json.enabled = v === true;
    const group = this.entity.__obj.getObjectByName("__compLight");
    if (group) group.visible = v === true;
  }
  /** 灯光类型（point/directional/spot/ambient；切换即重建灯光对象） */
  get kind() {
    return this.__settings()?.kind ?? "point";
  }
  set kind(v) {
    const s = this.__settings();
    if (!s || !LIGHT_KINDS.includes(v) || s.kind === v) return;
    s.kind = v;
    const obj = this.entity.__obj;
    const old = obj.getObjectByName("__compLight");
    if (old) obj.remove(old);
    buildComponentLight(s, obj);
  }
  /** 光色（0xRRGGBB） */
  get color() {
    return (this.__settings()?.lightColor ?? 0xffffff) & 0xffffff;
  }
  set color(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.lightColor = Math.max(0, Math.round(n)) & 0xffffff;
    this.__lightObj()?.color.setHex(s.lightColor);
  }
  get intensity() {
    return numOr(this.__settings()?.intensity, 1);
  }
  set intensity(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.intensity = Math.max(0, n);
    const light = this.__lightObj();
    if (light) light.intensity = s.intensity;
  }
  /** 渲染层级掩码（灯光 Culling Mask：只照亮掩码内层的对象；-1 = 全部层） */
  get cullingMask() {
    const m = this.__settings()?.cullingMask;
    return typeof m === "number" && Number.isFinite(m) ? m | 0 : -1;
  }
  set cullingMask(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.cullingMask = n | 0;
    const light = this.__lightObj();
    if (light) {
      light.layers.mask = s.cullingMask;
      // 阴影相机层同步（不同步会让非 0 层对象有光无影，与建出逻辑一致）
      if (light.shadow) light.shadow.camera.layers.mask = s.cullingMask;
    }
  }
  /** 点光/聚光灯：照射距离（0 = 无限远） */
  get distance() {
    return numOr(this.__settings()?.distance, 10);
  }
  set distance(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.distance = Math.max(0, n);
    if (light && (light.isPointLight || light.isSpotLight)) light.distance = s.distance;
  }
  /** 点光/聚光灯：物理衰减指数 */
  get decay() {
    return numOr(this.__settings()?.decay, 2);
  }
  set decay(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.decay = Math.max(0, n);
    if (light && (light.isPointLight || light.isSpotLight)) light.decay = s.decay;
  }
  /** 聚光灯：光束半角（度） */
  get angle() {
    return numOr(this.__settings()?.angle, 45);
  }
  set angle(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.angle = Math.min(89, Math.max(1, n));
    if (light && light.isSpotLight) light.angle = s.angle * D2R;
  }
  /** 聚光灯：边缘柔和度 0~1 */
  get penumbra() {
    return numOr(this.__settings()?.penumbra, 0.2);
  }
  set penumbra(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.penumbra = Math.min(1, Math.max(0, n));
    if (light && light.isSpotLight) light.penumbra = s.penumbra;
  }
  /** 点光/平行光/聚光灯：投射阴影 */
  get castShadow() {
    return this.__settings()?.castShadow === true;
  }
  set castShadow(v) {
    const s = this.__settings();
    if (!s) return;
    s.castShadow = v === true;
    const light = this.__lightObj();
    if (
      light &&
      (light.isDirectionalLight || light.isSpotLight || light.isPointLight)
    ) {
      light.castShadow = s.castShadow;
    }
  }
  /** 阴影浓度 0~1（1 = 纯黑阴影） */
  get shadowStrength() {
    return numOr(this.__settings()?.shadowStrength, 1);
  }
  set shadowStrength(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowStrength = Math.min(1, Math.max(0, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.intensity = s.shadowStrength;
  }
  /** 阴影深度偏移（压制自阴影麻点） */
  get shadowBias() {
    return numOr(this.__settings()?.shadowBias, -0.0005);
  }
  set shadowBias(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowBias = Math.min(0, Math.max(-0.05, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.bias = s.shadowBias;
  }
  /** 阴影法线偏移（≤0 = 自动按纹素相对化） */
  get shadowNormalBias() {
    return numOr(this.__settings()?.shadowNormalBias, 0);
  }
  set shadowNormalBias(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowNormalBias = Math.max(0, n);
    const light = this.__lightObj();
    if (light && light.shadow && s.shadowNormalBias > 0) light.shadow.normalBias = s.shadowNormalBias;
  }
  /** 阴影近裁剪面（比这更近的物体不参与投影） */
  get shadowNear() {
    return numOr(this.__settings()?.shadowNear, 0.1);
  }
  set shadowNear(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.shadowNear = Math.max(0.01, n);
    if (light && light.shadow && !light.isDirectionalLight) {
      // 平行光的阴影相机按场景包围盒自动贴合（near 由运行时合成），不直接写
      light.shadow.camera.near = s.shadowNear;
      light.shadow.camera.updateProjectionMatrix();
    }
  }
  /** 阴影软化半径（PCF 采样核；1 = 硬阴影） */
  get shadowRadius() {
    return numOr(this.__settings()?.shadowRadius, 4);
  }
  set shadowRadius(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowRadius = Math.min(5, Math.max(1, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.radius = s.shadowRadius;
  }
  /** 阴影贴图分辨率（0 = 自动：平面 2048 / 点光 1024；写入会重建灯光对象以重新分配贴图） */
  get shadowResolution() {
    return numOr(this.__settings()?.shadowResolution, 0);
  }
  set shadowResolution(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowResolution = [512, 1024, 2048, 4096].includes(n) ? n : 0;
    // three 只在灯光对象首次渲染前按 mapSize 分配阴影贴图：重建灯光对象使其生效
    const obj = this.entity.__obj;
    const old = obj.getObjectByName("__compLight");
    if (old) obj.remove(old);
    buildComponentLight(s, obj);
  }
  /** Shadow 类型档位（"off" | "hard" | "soft"；读写投射开关 + 软化半径） */
  get shadowType() {
    if (!this.castShadow) return "off";
    return this.shadowRadius >= 2 ? "soft" : "hard";
  }
  set shadowType(v) {
    if (v === "off") {
      this.castShadow = false;
    } else if (v === "hard" || v === "soft") {
      this.castShadow = true;
      this.shadowRadius = v === "hard" ? 1 : 4;
    }
  }
}

/** 音源组件门面：播放控制按组件 id 寻址；设置写入经运行时后端合并生效 */
class AudioSource extends BuiltinComponent {
  __key() {
    return this.__json && typeof this.__json.id === "string" ? this.__json.id : this.entity.id;
  }
  __settings() {
    return this.__json && typeof this.__json.audio === "object" ? this.__json.audio : null;
  }
  __update(patch) {
    host?.audios?.updateSettings(this.__key(), patch);
  }
  /** 音频资产引用（写入即重载） */
  get source() {
    return this.__settings()?.source ?? "";
  }
  set source(v) {
    if (typeof v === "string") this.__update({ source: v });
  }
  get autoplay() {
    return this.__settings()?.autoplay !== false;
  }
  set autoplay(v) {
    this.__update({ autoplay: v === true });
  }
  get loop() {
    return this.__settings()?.loop !== false;
  }
  set loop(v) {
    this.__update({ loop: v === true });
  }
  /** 音量 0..1 */
  get volume() {
    return numOr(this.__settings()?.volume, 1);
  }
  set volume(v) {
    const n = Number(v);
    if (Number.isFinite(n)) this.__update({ volume: Math.min(1, Math.max(0, n)) });
  }
  /** 播放倍速 0.1..4 */
  get speed() {
    return numOr(this.__settings()?.speed, 1);
  }
  set speed(v) {
    const n = Number(v);
    if (Number.isFinite(n)) this.__update({ speed: Math.min(4, Math.max(0.1, n)) });
  }
  /** 空间化："2d" 全局 / "3d" 位置音源 */
  get spatial() {
    return this.__settings()?.spatial === "3d" ? "3d" : "2d";
  }
  set spatial(v) {
    this.__update({ spatial: v === "3d" ? "3d" : "2d" });
  }
  get playing() {
    return host?.audios?.infoOf(this.__key())?.playing ?? false;
  }
  get paused() {
    return host?.audios?.infoOf(this.__key())?.paused ?? false;
  }
  get ready() {
    return host?.audios?.infoOf(this.__key())?.ready ?? false;
  }
  play() {
    host?.audios?.play(this.__key());
  }
  stop() {
    host?.audios?.stop(this.__key());
  }
  pause() {
    host?.audios?.pause(this.__key());
  }
  resume() {
    host?.audios?.resume(this.__key());
  }
  setVolume(v) {
    host?.audios?.setVolume(this.__key(), v);
  }
}

/** 关键帧动画剪辑组件门面（.anim 资产绑定 + 播放控制/进度/倍速） */
class AnimationClip extends BuiltinComponent {
  __key() {
    return this.__json && typeof this.__json.id === "string" ? this.__json.id : this.entity.id;
  }
  __b() {
    return host?.clipAnims?.bindingOf(this.__key()) ?? null;
  }
  /** .anim 资产相对路径（写入即重载剪辑；空串解绑） */
  get clip() {
    return this.__b()?.clipPath ?? "";
  }
  set clip(rel) {
    void host?.clipAnims?.changeClip(this.__b(), rel);
  }
  /** 剪辑时长（秒；未加载为 0） */
  get duration() {
    return this.__b()?.clip?.duration ?? 0;
  }
  /** 播放进度（秒；写入即跳转采样） */
  get time() {
    return this.__b()?.time ?? 0;
  }
  set time(v) {
    host?.clipAnims?.setTime(this.__b(), v);
  }
  get speed() {
    return this.__b()?.speed ?? 1;
  }
  set speed(v) {
    host?.clipAnims?.setSpeed(this.__b(), v);
  }
  get loop() {
    return this.__b()?.loop ?? true;
  }
  set loop(v) {
    host?.clipAnims?.setLoop(this.__b(), v === true);
  }
  get autoplay() {
    return this.__b()?.autoplay ?? true;
  }
  set autoplay(v) {
    host?.clipAnims?.setAutoplay(this.__b(), v === true);
  }
  get playing() {
    return this.__b()?.playing ?? false;
  }
  get paused() {
    return this.__b()?.paused ?? false;
  }
  /** 从头播放 */
  play() {
    host?.clipAnims?.play(this.__b());
  }
  pause() {
    host?.clipAnims?.pause(this.__b());
  }
  resume() {
    host?.clipAnims?.resume(this.__b());
  }
  /** 停止并回初始姿势 */
  stop() {
    host?.clipAnims?.stop(this.__b());
  }
}

/**
 * 骨骼动画（模型内嵌动画）门面：单剪辑 anim / 动画图 animGraph 的运行期视图。
 * 仅模型网格节点（source=model）拥有绑定；graph 为活动图对象（states/transitions/
 * entry/params 可直接改写，下一帧状态机评估即生效）。
 */
class SkeletalAnimation extends BuiltinComponent {
  __b() {
    return host?.animations?.bindingOf(this.entity.id) ?? null;
  }
  /** 模型内嵌剪辑名列表 */
  get clips() {
    return host?.animations?.clipsOf(this.entity.id) ?? [];
  }
  /** 当前播放的剪辑名（图模式为当前状态绑定的剪辑；未播放 null） */
  get currentClip() {
    return this.__b()?.currentClip ?? null;
  }
  get playing() {
    return this.__b()?.playing ?? false;
  }
  /** 当前剪辑名（缺省取首个；写入即切换播放） */
  get clip() {
    return this.currentClip ?? "";
  }
  set clip(name) {
    this.play(name);
  }
  /** 播放速度倍率（当前动作 + 单剪辑设置） */
  get speed() {
    return numOr(this.__b()?.nodeJson?.anim?.speed, 1);
  }
  set speed(v) {
    host?.animations?.setSpeed(this.entity.id, v);
  }
  /** 循环模式：loop/once/pingpong */
  get loop() {
    const v = this.__b()?.nodeJson?.anim?.loop;
    return LOOP_MODES.includes(v) ? v : "loop";
  }
  set loop(v) {
    host?.animations?.setLoop(this.entity.id, v);
  }
  get autoplay() {
    return this.__b()?.nodeJson?.anim?.autoplay !== false;
  }
  set autoplay(v) {
    host?.animations?.setAutoplay(this.entity.id, v === true);
  }
  /** 是否启用动画图模式 */
  get hasGraph() {
    return !!this.__b()?.graph;
  }
  /** 动画图活对象（entry/states/transitions/params 可直接改写；无图为 null） */
  get graph() {
    return this.__b()?.graph ?? null;
  }
  /** 播放：clip 缺省取首个剪辑；图模式下参数为目标状态名（缺省回入口） */
  play(clipOrState) {
    host?.animations?.play(
      this.entity.id,
      typeof clipOrState === "string" && clipOrState ? clipOrState : undefined,
    );
  }
  pause() {
    host?.animations?.pause(this.entity.id);
  }
  resume() {
    host?.animations?.resume(this.entity.id);
  }
  stop() {
    host?.animations?.stop(this.entity.id);
  }
  /** 图参数读取（无图/未声明返回 null） */
  getParam(name) {
    const g = this.graph;
    if (!g || typeof name !== "string" || !(name in g.params)) return null;
    return g.params[name];
  }
  /** 图参数写入（布尔/数值；条件评估每帧读取） */
  setParam(name, value) {
    host?.animations?.setParam(this.entity.id, name, value);
  }
  /** 创建/替换动画图（def 为动画图定义；非法部分按引擎规则收敛剔除） */
  ensureGraph(def) {
    return host?.animations?.applyGraph(this.entity.id, def) === true;
  }
  /** 移除动画图（回单剪辑语义） */
  removeGraph() {
    host?.animations?.removeGraph(this.entity.id);
  }
  /** 新增图状态（{name, clip, speed?, loop?}；重名拒绝） */
  addState(opts) {
    const g = this.graph;
    if (!g || !opts || typeof opts !== "object") return false;
    const name = typeof opts.name === "string" ? opts.name.trim() : "";
    if (!name || g.states.some((s) => s.name === name)) return false;
    g.states.push({
      name,
      clip: typeof opts.clip === "string" ? opts.clip : "",
      speed:
        typeof opts.speed === "number" && Number.isFinite(opts.speed) && opts.speed >= 0
          ? opts.speed
          : 1,
      loop: LOOP_MODES.includes(opts.loop) ? opts.loop : "loop",
    });
    return true;
  }
  /** 移除图状态（连带剔除涉及它的过渡；当前状态被移除后播放保持至下次切换） */
  removeState(name) {
    const g = this.graph;
    if (!g || typeof name !== "string") return false;
    const i = g.states.findIndex((s) => s.name === name);
    if (i < 0) return false;
    g.states.splice(i, 1);
    g.transitions = g.transitions.filter((t) => t.from !== name && t.to !== name);
    return true;
  }
  /** 新增过渡（{from, to, duration?, exitTime?, conditions?}；from/to 须为已有状态） */
  addTransition(opts) {
    const g = this.graph;
    if (!g || !opts || typeof opts !== "object") return false;
    const from = typeof opts.from === "string" ? opts.from : "";
    const to = typeof opts.to === "string" ? opts.to : "";
    if (
      !from ||
      !to ||
      from === to ||
      !g.states.some((s) => s.name === from) ||
      !g.states.some((s) => s.name === to)
    ) {
      return false;
    }
    let id = typeof opts.id === "string" && opts.id && !g.transitions.some((t) => t.id === opts.id)
      ? opts.id
      : "";
    if (!id) {
      let n = g.transitions.length + 1;
      while (g.transitions.some((t) => t.id === `t${n}`)) n += 1;
      id = `t${n}`;
    }
    const num = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
    g.transitions.push({
      id,
      from,
      to,
      duration: Math.max(0, num(opts.duration, 0.25)),
      exitTime: Math.max(0, Math.min(1, num(opts.exitTime, 0))),
      conditions: (Array.isArray(opts.conditions) ? opts.conditions : [])
        .filter((c) => !!c && typeof c === "object" && typeof c.param === "string" && c.param)
        .map((c) => ({
          param: c.param,
          op: CONDITION_OPS.includes(c.op) ? c.op : "==",
          value: num(c.value, 0),
        })),
    });
    return true;
  }
  /** 移除过渡（按 id） */
  removeTransition(id) {
    const g = this.graph;
    if (!g || typeof id !== "string") return false;
    const i = g.transitions.findIndex((t) => t.id === id);
    if (i < 0) return false;
    g.transitions.splice(i, 1);
    return true;
  }
}

// 组件类型键标记（字符串名 ↔ 门面类双通道寻址；@property 组件字段识别用）
RigidBody.__tveComponentType = "rigidBody";
Collider.__tveComponentType = "collider";
Light.__tveComponentType = "light";
AudioSource.__tveComponentType = "audioSource";
AnimationClip.__tveComponentType = "animationClip";
SkeletalAnimation.__tveComponentType = "skeletalAnimation";

/** 门面类注册表（类型键 → 类；"animation"/"anim" 别名指向骨骼动画） */
const BUILTIN_FACADES = {
  rigidBody: RigidBody,
  collider: Collider,
  light: Light,
  audioSource: AudioSource,
  animationClip: AnimationClip,
  skeletalAnimation: SkeletalAnimation,
};
const BUILTIN_TYPE_KEYS = Object.keys(BUILTIN_FACADES);

/** getComponent/addComponent 参数 → 组件类型键（类或字符串；未知返回 null） */
function builtinTypeKeyOf(token) {
  if (typeof token === "string") {
    if (token === "animation" || token === "anim") return "skeletalAnimation";
    return BUILTIN_TYPE_KEYS.includes(token) ? token : null;
  }
  if (typeof token === "function" && typeof token.__tveComponentType === "string") {
    return BUILTIN_TYPE_KEYS.includes(token.__tveComponentType) ? token.__tveComponentType : null;
  }
  return null;
}

/** 按类型键解析实体已有组件为门面（不存在返回 null；不写缓存） */
function createBuiltinFacade(entity, typeKey) {
  const json = nodeJsonOf(entity.id);
  switch (typeKey) {
    case "rigidBody":
      return host?.physics?.bodyInfo(entity.id)
        ? new RigidBody(entity, typeKey, componentJsonOf(json, "rigidBody"))
        : null;
    case "collider": {
      const c = componentJsonOf(json, "collider");
      return c ? new Collider(entity, typeKey, c) : null;
    }
    case "light": {
      const c = componentJsonOf(json, "light");
      return c ? new Light(entity, typeKey, c) : null;
    }
    case "audioSource": {
      const c = componentJsonOf(json, "audioSource");
      return c ? new AudioSource(entity, typeKey, c) : null;
    }
    case "animationClip": {
      const c = componentJsonOf(json, "animationClip");
      return c ? new AnimationClip(entity, typeKey, c) : null;
    }
    case "skeletalAnimation":
      return host?.animations?.bindingOf?.(entity.id)
        ? new SkeletalAnimation(entity, typeKey, null)
        : null;
    default:
      return null;
  }
}

/** 实体的指定类型内置组件门面（句柄缓存；未挂载返回 null） */
function builtinFacadeOf(entity, typeKey) {
  let byType = builtinByNode.get(entity.id);
  const hit = byType?.get(typeKey);
  if (hit) return hit;
  const facade = createBuiltinFacade(entity, typeKey);
  if (!facade) return null;
  if (!byType) {
    byType = new Map();
    builtinByNode.set(entity.id, byType);
  }
  byType.set(typeKey, facade);
  return facade;
}

/** 灯光组件设置收敛（缺省项回默认；color 为 lightColor 别名） */
function lightSettingsFrom(s) {
  const out = {
    kind: "point",
    lightColor: 0xffffff,
    intensity: 1,
    distance: 10,
    decay: 2,
    angle: 45,
    penumbra: 0.2,
    castShadow: false,
  };
  if (!s || typeof s !== "object") return out;
  if (LIGHT_KINDS.includes(s.kind)) out.kind = s.kind;
  const color = typeof s.lightColor === "number" ? s.lightColor : s.color;
  if (typeof color === "number" && Number.isFinite(color)) {
    out.lightColor = Math.max(0, Math.round(color)) & 0xffffff;
  }
  const num = (v, fb, lo, hi) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fb;
    return hi === undefined ? Math.max(lo, v) : Math.min(hi, Math.max(lo, v));
  };
  out.intensity = num(s.intensity, out.intensity, 0);
  out.distance = num(s.distance, out.distance, 0);
  // 渲染层级掩码（灯光 Culling Mask；缺省全部层）
  out.cullingMask =
    typeof s.cullingMask === "number" && Number.isFinite(s.cullingMask) ? s.cullingMask | 0 : -1;
  out.decay = num(s.decay, out.decay, 0);
  out.angle = num(s.angle, out.angle, 1, 89);
  out.penumbra = num(s.penumbra, out.penumbra, 0, 1);
  if (typeof s.castShadow === "boolean") out.castShadow = s.castShadow;
  // 阴影参数组（点光/平行光/聚光灯）
  out.shadowStrength = num(s.shadowStrength, 1, 0, 1);
  out.shadowBias = num(s.shadowBias, -0.0005, -0.05, 0);
  out.shadowNormalBias = num(s.shadowNormalBias, 0, 0);
  out.shadowNear = num(s.shadowNear, 0.1, 0.01);
  out.shadowRadius = num(s.shadowRadius, 4, 1, 5);
  out.shadowResolution = [512, 1024, 2048, 4096].includes(num(s.shadowResolution, 0))
    ? num(s.shadowResolution, 0)
    : 0;
  return out;
}

/** 音源组件设置收敛（缺省项回默认；与 audio.mjs parseAudioSettings 同一取值域） */
function audioSettingsFrom(s) {
  const out = {
    source: "",
    autoplay: true,
    loop: true,
    volume: 1,
    speed: 1,
    spatial: "2d",
    refDistance: 1,
    maxDistance: 30,
    rolloff: 1,
  };
  if (!s || typeof s !== "object") return out;
  const num = (v, fb, lo, hi) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fb;
    return hi === undefined ? Math.max(lo, v) : Math.min(hi, Math.max(lo, v));
  };
  if (typeof s.source === "string") out.source = s.source;
  if (typeof s.autoplay === "boolean") out.autoplay = s.autoplay;
  if (typeof s.loop === "boolean") out.loop = s.loop;
  out.volume = num(s.volume, out.volume, 0, 1);
  out.speed = num(s.speed, out.speed, 0.1, 4);
  if (s.spatial === "3d") out.spatial = "3d";
  out.refDistance = num(s.refDistance, out.refDistance, 0.01);
  out.maxDistance = num(s.maxDistance, out.maxDistance, 0.01);
  out.rolloff = num(s.rolloff, out.rolloff, 0);
  return out;
}

/** 动画剪辑组件设置收敛（clip/autoplay/loop/speed） */
function clipBindingFrom(s) {
  return {
    clip: s && typeof s.clip === "string" ? s.clip : "",
    autoplay: !(s && s.autoplay === false),
    loop: !(s && s.loop === false),
    speed:
      s && typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed >= 0 ? s.speed : 1,
  };
}

/** 在节点上创建运行时内置组件并返回门面（addComponent / 组件字段声明共用；
 *  light/audioSource/animationClip 每次调用都追加新组件实例） */
function createRuntimeBuiltin(entity, typeKey, settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const json = nodeJsonOf(entity.id);
  if (!json) return null;
  if (typeKey === "light") {
    const comp = {
      id: nextRuntimeCompId(),
      type: "light",
      enabled: true,
      light: lightSettingsFrom(s),
    };
    pushComponentJson(json, comp);
    buildComponentLight(comp.light, entity.__obj);
    return new Light(entity, typeKey, comp);
  }
  if (typeKey === "audioSource") {
    const comp = {
      id: nextRuntimeCompId(),
      type: "audioSource",
      enabled: true,
      audio: audioSettingsFrom(s),
    };
    pushComponentJson(json, comp);
    host?.audios?.addSource?.({ id: comp.id, audio: comp.audio }, entity.__obj, entity.id);
    return new AudioSource(entity, typeKey, comp);
  }
  if (typeKey === "animationClip") {
    const comp = {
      id: nextRuntimeCompId(),
      type: "animationClip",
      enabled: true,
      clip: clipBindingFrom(s),
    };
    pushComponentJson(json, comp);
    host?.clipAnims?.add?.({
      key: comp.id,
      obj: entity.__obj,
      clip: comp.clip.clip,
      autoplay: comp.clip.autoplay,
      loop: comp.clip.loop,
      speed: comp.clip.speed,
    });
    return new AnimationClip(entity, typeKey, comp);
  }
  if (typeKey === "skeletalAnimation") {
    if (!host?.animations?.bindingOf?.(entity.id)) {
      postLog("warn", "[tve] 骨骼动画组件只能用于模型网格节点（source=model）");
      return null;
    }
    if (s.graph && typeof s.graph === "object") host.animations.applyGraph(entity.id, s.graph);
    const anim = {};
    if (typeof s.clip === "string") anim.clip = s.clip;
    if (typeof s.autoplay === "boolean") anim.autoplay = s.autoplay;
    if (typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed >= 0) {
      anim.speed = s.speed;
    }
    if (LOOP_MODES.includes(s.loop)) anim.loop = s.loop;
    if (Object.keys(anim).length) host.animations.applyAnim(entity.id, anim);
    return builtinFacadeOf(entity, typeKey);
  }
  return null;
}

/**
 * 解析脚本组件字段声明（宿主实例化后调用；get-or-create 语义）：
 * 实体已有该组件 → 绑定其门面；没有 → 按缺省设置创建（物理组件除外——
 * rigidBody/collider 仅启动期构建，缺组件时字段保持 null）。
 * @param {Entity} entity 实体
 * @param {string} typeKey 组件类型键（"animationClip" 等）
 */
export function resolveComponentField(entity, typeKey) {
  if (!BUILTIN_TYPE_KEYS.includes(typeKey)) return null;
  if (typeKey === "rigidBody" || typeKey === "collider") {
    return createBuiltinFacade(entity, typeKey);
  }
  const existing = createBuiltinFacade(entity, typeKey);
  if (existing) return builtinFacadeOf(entity, typeKey);
  if (typeKey === "skeletalAnimation") return null; // 非模型节点：静默保持 null
  return createRuntimeBuiltin(entity, typeKey, {});
}

// ---------------------------------------------------------------------------
// 节点类型（Entity 子类 + 编辑器 type 键映射）
// 作为 @property({ type }) 的引用 token 与运行时类型（instanceof 可判断）。
// 层级：Transform 承载通用节点能力，具体类型继续派生，保证
//   meshNode 实例 instanceof Transform / Entity 均成立。
// ---------------------------------------------------------------------------

class Transform extends Entity {}
class MeshNode extends Transform {}
class LightNode extends Transform {}
class CameraNode extends Transform {}
class SkyboxNode extends Transform {}

/**
 * 粒子系统节点（编辑器 particleSystemNode）：除通用节点能力外提供运行时播放控制
 * 与发射参数读写（运行态生效，不回写场景文件）。全部经 host.particles 按节点 id 转发。
 */
class ParticleSystemNode extends Transform {
  /** 播放（暂停态续播；停止/播完态从头开始） */
  play() {
    host?.particles?.play(this.id);
  }
  /** 暂停（保留当前粒子） */
  pause() {
    host?.particles?.pause(this.id);
  }
  /** 停止发射（存活粒子自然消亡） */
  stop() {
    host?.particles?.stop(this.id);
  }
  /** 清空粒子并从头开始（预热系统下一帧快进一个周期） */
  restart() {
    host?.particles?.restart(this.id);
  }
  /** 立即清空全部粒子（不改变播放态） */
  clear() {
    host?.particles?.clear(this.id);
  }
  get playing() {
    return host?.particles?.infoOf(this.id)?.playing ?? false;
  }
  get paused() {
    return host?.particles?.infoOf(this.id)?.paused ?? false;
  }
  /** 非循环系统已发射完毕且粒子全部消亡 */
  get finished() {
    return host?.particles?.infoOf(this.id)?.finished ?? false;
  }
  /** 当前存活粒子数 */
  get aliveCount() {
    return host?.particles?.infoOf(this.id)?.alive ?? 0;
  }
  /** 发射设置快照（收敛后的完整对象；未绑定返回 null） */
  get settings() {
    return host?.particles?.settingsOf(this.id) ?? null;
  }
  /** 批量合并发射设置（子集；maxParticles/blending 变化会重建发射器） */
  setSettings(patch) {
    host?.particles?.updateSettings(this.id, patch);
  }
}

// 发射参数逐字段读写（与 tve.d.ts 的 ParticleSystemNode 属性表一致）
for (const key of [
  "duration",
  "looping",
  "prewarm",
  "startDelay",
  "startLifetime",
  "startSpeed",
  "startSize",
  "startColor",
  "endColor",
  "gravityModifier",
  "emissionRate",
  "maxParticles",
  "shape",
  "shapeRadius",
  "shapeAngle",
  "simulationSpace",
  "colorOverLifetime",
  "sizeOverLifetime",
  "blending",
  "texture",
]) {
  Object.defineProperty(ParticleSystemNode.prototype, key, {
    configurable: true,
    enumerable: false,
    get() {
      const s = host?.particles?.settingsOf(this.id);
      return s ? s[key] : undefined;
    },
    set(v) {
      host?.particles?.updateSettings(this.id, { [key]: v });
    },
  });
}

// UI（Canvas-Widget）节点门面：屏幕叠加渲染的画布与 Widget，
// 字段读写经 host.ui（settingsOf/updateSettings）转发到运行时 UI 系统（运行态生效，
// 不回写场景文件）。字段表与 tve.d.ts 的 UI 节点声明一致。
class UICanvasNode extends Transform {}
class UIImageNode extends Transform {}
class UITextNode extends Transform {}
class UIButtonNode extends Transform {}

for (const [Cls, keys] of [
  [UICanvasNode, ["sortOrder"]],
  [UIImageNode, ["sortOrder", "size", "image", "color"]],
  [UITextNode, ["sortOrder", "size", "text", "fontSize", "color", "bold", "italic", "fontFamily", "align"]],
  [UIButtonNode, ["sortOrder", "size", "image", "color", "label", "labelColor", "fontSize", "labelBold", "interactable"]],
]) {
  for (const key of keys) {
    Object.defineProperty(Cls.prototype, key, {
      configurable: true,
      enumerable: false,
      get() {
        const s = host?.ui?.settingsOf(this.id);
        return s ? s[key] : undefined;
      },
      set(v) {
        host?.ui?.updateSettings(this.id, { [key]: v });
      },
    });
  }
}

// 编辑器 type 键 → 类型类（供 getEntity 按 userData.nodeKind 构建实例）
const KIND_CLASSES = {
  node: Transform,
  meshNode: MeshNode,
  cameraNode: CameraNode,
  skyboxNode: SkyboxNode,
  audioNode: Transform,
  particleSystemNode: ParticleSystemNode,
  lightNode: LightNode,
  pointLightNode: LightNode,
  directionalLightNode: LightNode,
  ambientLightNode: LightNode,
  spotLightNode: LightNode,
  uiCanvasNode: UICanvasNode,
  uiImageNode: UIImageNode,
  uiTextNode: UITextNode,
  uiButtonNode: UIButtonNode,
};

// 节点类型类的静态过滤键（property 装饰器据此识别"节点引用"属性；
// 编辑器 AST 按 type token 名匹配同一集合）
Transform.__nodeKinds = null; // 任意场景节点
MeshNode.__nodeKinds = ["meshNode"];
LightNode.__nodeKinds = [
  "lightNode",
  "pointLightNode",
  "directionalLightNode",
  "ambientLightNode",
  "spotLightNode",
];
CameraNode.__nodeKinds = ["cameraNode"];
SkyboxNode.__nodeKinds = ["skyboxNode"];
ParticleSystemNode.__nodeKinds = ["particleSystemNode"];
UICanvasNode.__nodeKinds = ["uiCanvasNode"];
UIImageNode.__nodeKinds = ["uiImageNode"];
UITextNode.__nodeKinds = ["uiTextNode"];
UIButtonNode.__nodeKinds = ["uiButtonNode"];

/** @property({ type: 节点类 }) 是否节点引用选项（运行时标识） */
function isNodeRefType(v) {
  return typeof v === "function" && v !== Entity && Object.prototype.hasOwnProperty.call(v, "__nodeKinds");
}

// ---------------------------------------------------------------------------
// Component 基类（宿主 new 子类并注入 entity；props 由宿主在构造后挂只读视图）
// ---------------------------------------------------------------------------

class ComponentImpl {
  constructor(entity) {
    this.entity = entity;
  }
}

// ---------------------------------------------------------------------------
// 装饰器（@property / @nodeType 声明式写法）
// - property：字段装饰器，登记字段为组件可编辑属性（host 据此读取字段初值作
//   默认并注入节点配置覆盖）；类型契约见 tve.d.ts。
// - nodeType：类装饰器，登记脚本类为可创建节点类型（编辑器创建入口用）。
// 元数据挂在类上（__tvePropKeys / __tveNodeType），editor 经 AST 静态解析，
// 运行期仅 host 需要属性键集合（见 scripts.mjs）。
// ---------------------------------------------------------------------------

/** 把字段名登记到类的 __tvePropKeys（host 合并默认值与节点配置用） */
function recordPropKey(ctor, key) {
  const list = ctor.__tvePropKeys;
  if (Array.isArray(list)) {
    if (!list.includes(key)) list.push(key);
  } else {
    Object.defineProperty(ctor, "__tvePropKeys", {
      value: [key],
      configurable: true,
      writable: true,
    });
  }
}

/** 把实体引用键名记入类 __tveEntityKeys（host 将节点配置 id 解析为 Entity） */
function recordEntityKey(ctor, key) {
  const list = ctor.__tveEntityKeys;
  if (Array.isArray(list)) {
    if (!list.includes(key)) list.push(key);
  } else {
    Object.defineProperty(ctor, "__tveEntityKeys", {
      value: [key],
      configurable: true,
      writable: true,
    });
  }
}

/** 把组件引用键名记入类 __tveComponentKeys（[字段名, 组件类型键] 对；
 *  host 实例化后解析为内置组件门面：实体已有该组件则绑定，没有则创建） */
function recordComponentKey(ctor, key, typeKey) {
  const list = ctor.__tveComponentKeys;
  if (Array.isArray(list)) {
    if (!list.some((e) => e[0] === key)) list.push([key, typeKey]);
  } else {
    Object.defineProperty(ctor, "__tveComponentKeys", {
      value: [[key, typeKey]],
      configurable: true,
      writable: true,
    });
  }
}

/** 值是否为组件门面类（返回组件类型键；否则 null） */
function componentTypeKeyOfOption(v) {
  if (typeof v === "function" && typeof v.__tveComponentType === "string") {
    return BUILTIN_TYPE_KEYS.includes(v.__tveComponentType) ? v.__tveComponentType : null;
  }
  return null;
}

/**
 * @property 装饰器。双形态：
 * - @property / @property() / @property({...})：字段装饰器，把字段名记入类
 *   __tvePropKeys，host 据此以字段初值为默认、按节点配置覆盖（this.字段名 读写）；
 *   options.type 传节点类型类（如 MeshNode）时，把该字段登记为场景节点引用
 *   （__tveEntityKeys）：host 会把节点配置里存的节点 id 解析为对应 Entity；
 *   options.type 传内置组件门面类（如 AnimationClip，或裸 @property(AnimationClip)）
 *   时，把该字段登记为组件引用（__tveComponentKeys）：host 实例化后 get-or-create
 *   对应内置组件并绑定门面（不在检查器中出现，运行期 this.字段名 即组件门面）；
 * - 作为工厂被 @property(options) 调用时返回装饰器；被裸 @property 直接调用
 *   （legacy 装饰器把裸引用当作装饰器执行）时按 target/key 就地登记。
 */
export function property(targetOrOptions, maybeKey) {
  // 裸调用形态：@property → (prototype/class, key) 直接登记
  if (arguments.length >= 2) {
    const t = targetOrOptions;
    const ctor = typeof t === "function" ? t : t && t.constructor;
    if (typeof ctor === "function" && typeof maybeKey === "string") {
      recordPropKey(ctor, maybeKey);
    }
    return undefined;
  }
  // 工厂形态：@property() / @property({...}) / @property(组件类) → 返回字段装饰器
  const optType =
    targetOrOptions && typeof targetOrOptions === "object" ? targetOrOptions.type : undefined;
  const nodeRef = isNodeRefType(optType);
  // 组件引用：@property({ type: AnimationClip }) 或裸 @property(AnimationClip)
  const compType =
    componentTypeKeyOfOption(optType) ?? componentTypeKeyOfOption(targetOrOptions);
  return function decorate(target, key) {
    const ctor = typeof target === "function" ? target : target.constructor;
    if (compType) {
      recordComponentKey(ctor, key, compType);
      return;
    }
    recordPropKey(ctor, key);
    if (nodeRef) recordEntityKey(ctor, key);
  };
}

/** @nodeType(options) 类装饰器：登记脚本类为可创建节点类型（kind/label） */
export function nodeType(options) {
  const kind =
    options && typeof options.kind === "string" && options.kind ? options.kind : "node";
  const label =
    options && typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : "";
  return function decorate(ctor) {
    ctor.__tveNodeType = { kind, label };
    return ctor;
  };
}

// ---------------------------------------------------------------------------
// 委托（Delegate）：多播事件容器（参考 C# 多播委托）。
// 广播式回调的登记与触发，回调异常逐个隔离上报，不影响其余回调与其他脚本；
// invoke 用快照迭代，回调内 add/remove 自身或他人均安全。
// ---------------------------------------------------------------------------

/** 委托移除令牌（add 返回；remove 可传令牌或原函数） */
class DelegateToken {
  constructor(seq) {
    this.__delegateToken = seq;
  }
}

class Delegate {
  constructor() {
    this.__handlers = [];
    this.__seq = 0;
  }

  /** 已订阅回调数量 */
  get count() {
    return this.__handlers.length;
  }

  /**
   * 订阅回调：同一函数重复订阅只登记一次。
   * @param {Function} fn 回调（成员函数建议先 bind，或用返回的令牌退订）
   * @returns {DelegateToken|null} 移除令牌（非法入参返回 null）
   */
  add(fn) {
    if (typeof fn !== "function") return null;
    if (this.__handlers.some((h) => h.fn === fn)) return fn;
    const token = new DelegateToken((this.__seq += 1));
    this.__handlers.push({ fn, token });
    return token;
  }

  /**
   * 退订回调：传 add 返回的令牌或原函数均可。
   * @returns {boolean} 是否移除了一个订阅
   */
  remove(tokenOrFn) {
    const idx = this.__handlers.findIndex((h) => h.fn === tokenOrFn || h.token === tokenOrFn);
    if (idx < 0) return false;
    this.__handlers.splice(idx, 1);
    return true;
  }

  /** 清空全部订阅 */
  clear() {
    this.__handlers.length = 0;
  }

  /**
   * 广播：按订阅顺序逐个调用全部回调。
   * 单个回调抛错只停用该次调用并上报（编辑器控制台/浏览器控制台），不影响其余回调。
   */
  invoke(...args) {
    for (const { fn } of this.__handlers.slice()) {
      try {
        fn(...args);
      } catch (e) {
        const text = e && e.message ? e.message : String(e);
        postLog("error", "[tve] 委托回调异常: " + text);
        console.error(e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 对象池（Pool）：复用对象，避免频繁创建/销毁带来的卡顿与 GC 压力。
// get 复用空闲对象（无则新建）；put 归还（先调 reset 清理，空闲数达上限则丢弃）。
// 池只回收自己发出的对象：重复归还/外来对象会被拒绝。
// ---------------------------------------------------------------------------

class Pool {
  /**
   * @param {Function} factory 对象工厂（无参；新建对象时调用）
   * @param {{reset?: Function, initial?: number, max?: number}} [options]
   *        reset = 归还时清理回调；initial = 预热数量；max = 空闲上限（缺省无限）
   */
  constructor(factory, options) {
    if (typeof factory !== "function") {
      throw new Error("[tve] Pool 需要一个 factory 工厂函数");
    }
    const o = options && typeof options === "object" ? options : {};
    this.__factory = factory;
    this.__reset = typeof o.reset === "function" ? o.reset : null;
    this.__max = typeof o.max === "number" && Number.isFinite(o.max) ? Math.max(0, Math.floor(o.max)) : Infinity;
    this.__free = [];
    this.__live = new Set();
    this.__created = 0;
    const initial = typeof o.initial === "number" && Number.isFinite(o.initial) ? Math.max(0, Math.floor(o.initial)) : 0;
    if (initial > 0) this.prewarm(initial);
  }

  /** 空闲对象数量 */
  get count() {
    return this.__free.length;
  }

  /** 累计创建的对象总数（评估池命中率用） */
  get totalCreated() {
    return this.__created;
  }

  /** 预热：提前创建 n 个空闲对象（受 max 上限约束） */
  prewarm(n) {
    const total = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    while (this.__free.length < Math.min(total, this.__max)) {
      this.__free.push(this.__create());
    }
  }

  __create() {
    this.__created += 1;
    return this.__factory();
  }

  /** 取一个对象：优先复用空闲对象，池空则新建 */
  get() {
    const item = this.__free.pop() ?? this.__create();
    this.__live.add(item);
    return item;
  }

  /**
   * 归还对象：先调用 reset 清理（若配置），再入空闲池（达 max 上限则丢弃交给 GC）。
   * 非本池发出的对象或重复归还返回 false。
   */
  put(item) {
    if (!this.__live.delete(item)) return false;
    if (this.__reset) {
      try {
        this.__reset(item);
      } catch (e) {
        postLog("warn", "[tve] 对象池 reset 异常: " + (e && e.message ? e.message : String(e)));
      }
    }
    if (this.__free.length < this.__max) this.__free.push(item);
    return true;
  }

  /** 清空空闲列表（释放引用交给 GC；不影响已借出的对象） */
  clear() {
    this.__free.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 数据中心（DataCenter）：跨组件共享的命名数据仓库，内置热/冷分解。
// - 热数据（hot）：常驻内存的活动工作集，set/get 即时生效；
// - 冷数据（cold）：长期未访问或超出热容量的数据自动"降温"为冻结快照
//   （深拷贝隔离，避免误改），再次访问自动"回温"为热数据；
// - 降冷时机：访问时惰性自动清扫（autoSweep/sweepInterval），也可手动 sweep()。
// 冷数据建议存纯数据（普通对象/数组/原始值）；含函数等不可克隆对象按
// 结构化克隆 → JSON → 原引用的顺序降级兜底。
// ---------------------------------------------------------------------------

const DATA_DEFAULT_OPTIONS = {
  /** 热容量上限：热数据条数超过该值时，清扫会把最久未访问的条目降冷 */
  hotLimit: 64,
  /** 冷却时长（毫秒）：热数据闲置超过该时长，清扫时降冷 */
  coldTtl: 30000,
  /** 惰性自动清扫开关（在 set/get/has 访问时按 sweepInterval 触发） */
  autoSweep: true,
  /** 自动清扫最小间隔（毫秒） */
  sweepInterval: 10000,
};

/** 深拷贝冻结快照：结构化克隆 → JSON → 原引用（逐级兜底） */
function dataFreezeClone(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    /* 不可结构化克隆（含函数等）→ 尝试 JSON */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    /* JSON 不安全 → 原引用兜底 */
  }
  return value;
}

class DataCenter {
  constructor(options) {
    this.__hot = new Map(); // key → 活动值
    this.__meta = new Map(); // key → { lastAccess }
    this.__cold = new Map(); // key → { snapshot, cooledAt }
    this.__options = { ...DATA_DEFAULT_OPTIONS };
    this.__lastSweep = Date.now();
    this.__sweeps = 0;
    this.__accessSeq = 0;
    this.__promotions = 0;
    this.__hits = 0;
    this.__misses = 0;
    if (options) this.configure(options);
  }

  /** 调整容量/冷却策略（增量合并；触发条件见 DATA_DEFAULT_OPTIONS 同名字段） */
  configure(options) {
    const o = options && typeof options === "object" ? options : {};
    if (typeof o.hotLimit === "number" && Number.isFinite(o.hotLimit)) {
      this.__options.hotLimit = Math.max(1, Math.floor(o.hotLimit));
    }
    if (typeof o.coldTtl === "number" && Number.isFinite(o.coldTtl)) {
      this.__options.coldTtl = Math.max(0, Math.floor(o.coldTtl));
    }
    if (typeof o.autoSweep === "boolean") this.__options.autoSweep = o.autoSweep;
    if (typeof o.sweepInterval === "number" && Number.isFinite(o.sweepInterval)) {
      this.__options.sweepInterval = Math.max(0, Math.floor(o.sweepInterval));
    }
  }

  __now() {
    return Date.now();
  }

  /** 惰性自动清扫：距上次清扫超过 sweepInterval 时执行 */
  __lazySweep() {
    const now = this.__now();
    if (this.__options.autoSweep && now - this.__lastSweep >= this.__options.sweepInterval) {
      this.sweep();
    }
  }

  /** 单条降冷：热 → 冷（冻结快照） */
  __coolKey(key, now) {
    const value = this.__hot.get(key);
    const meta = this.__meta.get(key);
    this.__hot.delete(key);
    this.__meta.delete(key);
    this.__cold.set(key, { snapshot: dataFreezeClone(value), cooledAt: now });
    return true;
  }

  /** 单条回温：冷 → 热（快照转正为活动值） */
  __warmKey(key) {
    const entry = this.__cold.get(key);
    this.__cold.delete(key);
    this.__hot.set(key, entry.snapshot);
    this.__meta.set(key, { lastAccess: this.__now(), accessSeq: (this.__accessSeq += 1) });
    this.__promotions += 1;
  }

  /**
   * 写入数据（写即热：值进入热区，并自动回温同名冷数据）。
   * 同名冷数据若存在，其快照被新值覆盖。
   */
  set(key, value) {
    if (typeof key !== "string" || !key) return;
    this.__lazySweep();
    this.__cold.delete(key);
    this.__hot.set(key, value);
    this.__meta.set(key, { lastAccess: this.__now(), accessSeq: (this.__accessSeq += 1) });
  }

  /**
   * 读取数据：热数据直接返回（活动引用）；冷数据自动回温后返回快照；
   * 未命中返回 defaultValue。
   */
  get(key, defaultValue) {
    if (typeof key !== "string" || !key) return defaultValue;
    this.__lazySweep();
    if (this.__hot.has(key)) {
      const meta = this.__meta.get(key);
      meta.lastAccess = this.__now();
      meta.accessSeq = (this.__accessSeq += 1);
      this.__hits += 1;
      return this.__hot.get(key);
    }
    if (this.__cold.has(key)) {
      this.__warmKey(key);
      this.__hits += 1;
      return this.__hot.get(key);
    }
    this.__misses += 1;
    return defaultValue;
  }

  /** 是否存在该键（热或冷） */
  has(key) {
    if (typeof key !== "string" || !key) return false;
    this.__lazySweep();
    return this.__hot.has(key) || this.__cold.has(key);
  }

  /** 删除数据（热/冷一并移除）。返回是否存在 */
  delete(key) {
    if (typeof key !== "string" || !key) return false;
    this.__lazySweep();
    const existed = this.__hot.delete(key);
    this.__meta.delete(key);
    const coldExisted = this.__cold.delete(key);
    return existed || coldExisted;
  }

  /** 全部键名（热 + 冷） */
  keys() {
    return [...this.__hot.keys(), ...this.__cold.keys()];
  }

  /** 热数据键名（当前活动工作集） */
  hotKeys() {
    return [...this.__hot.keys()];
  }

  /** 冷数据键名（已降冷的冻结快照） */
  coldKeys() {
    return [...this.__cold.keys()];
  }

  /** 手动回温指定键（get/set 会自动回温，一般无需调用）。返回是否存在 */
  warm(key) {
    if (typeof key !== "string" || !key) return false;
    if (this.__cold.has(key)) {
      this.__warmKey(key);
      return true;
    }
    return this.__hot.has(key);
  }

  /** 手动降冷指定键（值以冻结快照形式进入冷区）。返回是否降冷 */
  cool(key) {
    if (typeof key !== "string" || !key) return false;
    if (!this.__hot.has(key)) return false;
    this.__coolKey(key, this.__now());
    return true;
  }

  /**
   * 清扫：执行热/冷分解。
   * - 闲置时长 ≥ coldTtl 的热数据降冷；
   * - 热数据条数超过 hotLimit 时，按最久未访问（LRU）降冷至容量内。
   * @returns 本次降冷的条数
   */
  sweep() {
    const now = this.__now();
    this.__lastSweep = now;
    let cooled = 0;
    // 1) 闲置超时降冷
    for (const [key, meta] of [...this.__meta]) {
      if (now - meta.lastAccess >= this.__options.coldTtl && this.__hot.has(key)) {
        this.__coolKey(key, now);
        cooled += 1;
      }
    }
    // 2) 超容量 LRU 降冷（最久未访问优先）
    if (this.__hot.size > this.__options.hotLimit) {
      const order = [...this.__meta.entries()]
        .filter(([key]) => this.__hot.has(key))
        .sort((a, b) => a[1].accessSeq - b[1].accessSeq);
      for (const [key] of order) {
        if (this.__hot.size <= this.__options.hotLimit) break;
        this.__coolKey(key, now);
        cooled += 1;
      }
    }
    this.__sweeps += 1;
    return cooled;
  }

  /** 统计快照：热/冷条数、清扫次数、回温次数、命中/未命中次数 */
  stats() {
    return {
      hot: this.__hot.size,
      cold: this.__cold.size,
      sweeps: this.__sweeps,
      promotions: this.__promotions,
      hits: this.__hits,
      misses: this.__misses,
    };
  }
}

/** 全局数据中心单例（跨组件共享游戏数据；需要隔离实例时可 new DataCenter()） */
const dataCenter = new DataCenter();

// ---------------------------------------------------------------------------
// engine 入口
// ---------------------------------------------------------------------------

const animationApi = {
  play(entity, clip) {
    host?.animations?.play(entity?.id, clip);
  },
  stop(entity) {
    host?.animations?.stop(entity?.id);
  },
  pause(entity) {
    host?.animations?.pause(entity?.id);
  },
  resume(entity) {
    host?.animations?.resume(entity?.id);
  },
};

/** 音频控制（按实体寻址；仅音源节点有效，脚本经 engine.audio 调用） */
const audioApi = {
  play(entity) {
    host?.audios?.play(entity?.id);
  },
  stop(entity) {
    host?.audios?.stop(entity?.id);
  },
  pause(entity) {
    host?.audios?.pause(entity?.id);
  },
  resume(entity) {
    host?.audios?.resume(entity?.id);
  },
  setVolume(entity, volume) {
    host?.audios?.setVolume(entity?.id, volume);
  },
};

/** 粒子系统控制（按实体寻址；仅粒子系统节点有效，脚本经 engine.particles 调用） */
const particlesApi = {
  play(entity) {
    host?.particles?.play(entity?.id);
  },
  pause(entity) {
    host?.particles?.pause(entity?.id);
  },
  stop(entity) {
    host?.particles?.stop(entity?.id);
  },
  restart(entity) {
    host?.particles?.restart(entity?.id);
  },
  clear(entity) {
    host?.particles?.clear(entity?.id);
  },
  /** 运行态（playing/paused/finished/alive/time；非粒子节点 null） */
  stateOf(entity) {
    return host?.particles?.infoOf(entity?.id) ?? null;
  },
  /** 合并发射设置（子集；运行态生效，不回写场景文件） */
  setSettings(entity, patch) {
    host?.particles?.updateSettings(entity?.id, patch);
  },
};

/** UI 运行期控制（按实体寻址；画布/Widget 设置 + 按钮点击订阅，经 engine.ui 调用） */
const uiApi = {
  /** 合并 Widget/画布设置（子集；运行态生效，不回写场景文件） */
  set(entity, patch) {
    host?.ui?.updateSettings(entity?.id, patch);
  },
  /** 读取 Widget/画布当前设置快照（非 UI 节点返回 null） */
  get(entity) {
    return host?.ui?.settingsOf(entity?.id) ?? null;
  },
  /** 订阅按钮点击（仅 uiButtonNode 且 interactable；返回解绑函数） */
  onClick(entity, cb) {
    const un = host?.ui?.onClick(entity?.id, cb);
    return typeof un === "function" ? un : () => {};
  },
  /** 解除按钮点击订阅 */
  offClick(entity, cb) {
    host?.ui?.offClick(entity?.id, cb);
  },
};

/** 物理控制（按实体寻址；仅挂刚体组件的节点有效，脚本经 engine.physics 调用） */
const physicsApi = {
  applyImpulse(entity, x, y, z) {
    host?.physics?.applyImpulse(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  applyForce(entity, x, y, z) {
    host?.physics?.applyForce(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  setLinearVelocity(entity, x, y, z) {
    host?.physics?.setLinearVelocity(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  setAngularVelocity(entity, x, y, z) {
    host?.physics?.setAngularVelocity(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  getLinearVelocity(entity) {
    return host?.physics?.getLinearVelocity(entity?.id) ?? null;
  },
  /** 节点物理体信息（mode/gravityScale/colliderCount；未绑定返回 null） */
  bodyInfo(entity) {
    return host?.physics?.bodyInfo(entity?.id) ?? null;
  },
  setGravityScale(entity, scale) {
    host?.physics?.setGravityScale(entity?.id, numOr(scale, 1));
  },
  wakeUp(entity) {
    host?.physics?.wakeUp(entity?.id);
  },
  setGravity(x, y, z) {
    host?.physics?.setGravity(numOr(x, 0), numOr(y, -9.81), numOr(z, 0));
  },
};

/** 单实体按 token 找组件：脚本类 / 脚本路径 / 类名 / 内置组件门面类 / 类型键 */
function findOnEntity(entity, token) {
  const typeKey = builtinTypeKeyOf(token);
  if (typeKey) return builtinFacadeOf(entity, typeKey);
  if (typeof token === "function") {
    const list = componentsByNode.get(entity.id);
    return list ? list.find((c) => c instanceof token) ?? null : null;
  }
  if (typeof token === "string") return resolveScriptInstance(entity.id, token);
  return null;
}

const sceneApi = {
  get root() {
    const rootObj = host && host.rootObj;
    return rootObj ? getEntity(rootObj) : null;
  },
  find(nameOrPath) {
    const rootObj = host && host.rootObj;
    if (!rootObj) return null;
    // 根自身名称优先，其次整树查找
    if (rootObj.name === nameOrPath) return getEntity(rootObj);
    const hit = deepFind(rootObj, nameOrPath);
    return hit ? getEntity(hit) : null;
  },
  findAll() {
    return registry().map((e) => getEntity(e.obj)).filter(Boolean);
  },
  /** 按标签查实体（返回第一个命中；无命中/空标签返回 null） */
  findByTag(tag) {
    for (const e of registry()) {
      if (e.obj?.userData?.nodeTag === tag) return getEntity(e.obj);
    }
    return null;
  },
  /** 按标签查实体（文档序全量；无命中返回空数组） */
  findAllByTag(tag) {
    return registry()
      .filter((e) => e.obj?.userData?.nodeTag === tag)
      .map((e) => getEntity(e.obj))
      .filter(Boolean);
  },
  /** 全场景按类型查组件：token = 脚本类 /
   *  脚本源路径 / 脚本类名 / 内置组件门面类 / 类型键；返回第一个命中 */
  findComponent(token) {
    for (const e of registry()) {
      const ent = getEntity(e.obj);
      if (!ent) continue;
      const hit = findOnEntity(ent, token);
      if (hit) return hit;
    }
    return null;
  },
  /** 全场景按类型查组件（文档序全量；无命中返回空数组） */
  findComponents(token) {
    const out = [];
    for (const e of registry()) {
      const ent = getEntity(e.obj);
      if (!ent) continue;
      const hit = findOnEntity(ent, token);
      if (hit) out.push(hit);
    }
    return out;
  },
};

const inputApi = {
  isKeyDown(key) {
    return heldKeys.has(key);
  },
  onKeyDown(handler) {
    keyDownHandlers.add(handler);
    return () => keyDownHandlers.delete(handler);
  },
  onKeyUp(handler) {
    keyUpHandlers.add(handler);
    return () => keyUpHandlers.delete(handler);
  },
  pointer: pointerState,
  onPointerDown(handler) {
    pointerDownHandlers.add(handler);
    return () => pointerDownHandlers.delete(handler);
  },
  onPointerUp(handler) {
    pointerUpHandlers.add(handler);
    return () => pointerUpHandlers.delete(handler);
  },
  onPointerMove(handler) {
    pointerMoveHandlers.add(handler);
    return () => pointerMoveHandlers.delete(handler);
  },
};

// ---------------------------------------------------------------------------
// math —— 向量数学库（引擎自有类型，纯函数、全部返回新对象不改写入参）。
// 与编辑器数据模型同一语义：Vec3 普通对象；非法入参按 0 收敛（numOr）。
// ---------------------------------------------------------------------------

const EPS = 1e-6;

function numv(v) {
  return { x: numOr(v && v.x, 0), y: numOr(v && v.y, 0), z: numOr(v && v.z, 0) };
}

const math = {
  /** 创建向量 {x,y,z}（缺省 0） */
  v3(x = 0, y = 0, z = 0) {
    return { x: numOr(x, 0), y: numOr(y, 0), z: numOr(z, 0) };
  },
  /** 常量：零向量 / 单位向量 / 各轴正方向（冻结，勿改写） */
  zero: Object.freeze({ x: 0, y: 0, z: 0 }),
  one: Object.freeze({ x: 1, y: 1, z: 1 }),
  up: Object.freeze({ x: 0, y: 1, z: 0 }),
  down: Object.freeze({ x: 0, y: -1, z: 0 }),
  forward: Object.freeze({ x: 0, y: 0, z: -1 }),
  back: Object.freeze({ x: 0, y: 0, z: 1 }),
  left: Object.freeze({ x: -1, y: 0, z: 0 }),
  right: Object.freeze({ x: 1, y: 0, z: 0 }),
  /** 克隆（快照副本，写入不影响原向量） */
  clone(v) {
    const c = numv(v);
    return { x: c.x, y: c.y, z: c.z };
  },
  /** 加法 a + b */
  add(a, b) {
    const x = numv(a), y = numv(b);
    return { x: x.x + y.x, y: x.y + y.y, z: x.z + y.z };
  },
  /** 减法 a - b（结果方向 = a 指向 b 的反方向） */
  sub(a, b) {
    const x = numv(a), y = numv(b);
    return { x: x.x - y.x, y: x.y - y.y, z: x.z - y.z };
  },
  /** 数乘 v * s */
  scale(v, s) {
    const c = numv(v);
    const k = numOr(s, 0);
    return { x: c.x * k, y: c.y * k, z: c.z * k };
  },
  /** 逐分量取反 */
  negate(v) {
    const c = numv(v);
    return { x: -c.x, y: -c.y, z: -c.z };
  },
  /** 逐分量取绝对值 */
  abs(v) {
    const c = numv(v);
    return { x: Math.abs(c.x), y: Math.abs(c.y), z: Math.abs(c.z) };
  },
  /** 逐分量取最小 / 最大 */
  min(a, b) {
    const x = numv(a), y = numv(b);
    return { x: Math.min(x.x, y.x), y: Math.min(x.y, y.y), z: Math.min(x.z, y.z) };
  },
  max(a, b) {
    const x = numv(a), y = numv(b);
    return { x: Math.max(x.x, y.x), y: Math.max(x.y, y.y), z: Math.max(x.z, y.z) };
  },
  /** 点积（结果 = |a||b|cosθ） */
  dot(a, b) {
    const x = numv(a), y = numv(b);
    return x.x * y.x + x.y * y.y + x.z * y.z;
  },
  /** 叉积（结果同时垂直于 a、b，方向满足右手定则） */
  cross(a, b) {
    const x = numv(a), y = numv(b);
    return {
      x: x.y * y.z - x.z * y.y,
      y: x.z * y.x - x.x * y.z,
      z: x.x * y.y - x.y * y.x,
    };
  },
  /** 模长平方（避免开方，比较距离时更快） */
  lengthSq(v) {
    const c = numv(v);
    return c.x * c.x + c.y * c.y + c.z * c.z;
  },
  /** 模长（直线距离原点） */
  length(v) {
    return Math.sqrt(this.lengthSq(v));
  },
  /** 两点直线距离 */
  distance(a, b) {
    return this.length(this.sub(a, b));
  },
  /** 距离平方 */
  distanceSq(a, b) {
    return this.lengthSq(this.sub(a, b));
  },
  /** 归一化（模长归 1；零向量返回零向量，不产生 NaN） */
  normalize(v) {
    const c = numv(v);
    const len = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
    if (len < EPS) return { x: 0, y: 0, z: 0 };
    return { x: c.x / len, y: c.y / len, z: c.z / len };
  },
  /** 线性插值 t∈[0,1]（t=0 返回 a 克隆，t=1 返回 b 克隆；越界按方向外插） */
  lerp(a, b, t) {
    const x = numv(a), y = numv(b);
    const k = numOr(t, 0);
    return {
      x: x.x + (y.x - x.x) * k,
      y: x.y + (y.y - x.y) * k,
      z: x.z + (y.z - x.z) * k,
    };
  },
  /** 由 a 向 b 移动最多 maxDelta（不超过直线距离；匀速移动用） */
  moveTowards(a, b, maxDelta) {
    const x = numv(a), y = numv(b);
    const d = numOr(maxDelta, 0);
    const dx = y.x - x.x, dy = y.y - x.y, dz = y.z - x.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= d || len < EPS) return { x: y.x, y: y.y, z: y.z };
    const k = d / len;
    return { x: x.x + dx * k, y: x.y + dy * k, z: x.z + dz * k };
  },
  /** 近似相等（逐分量误差 ≤ eps，缺省 1e-6） */
  equals(a, b, eps) {
    const x = numv(a), y = numv(b);
    const e = numOr(eps, EPS);
    return Math.abs(x.x - y.x) <= e && Math.abs(x.y - y.y) <= e && Math.abs(x.z - y.z) <= e;
  },
};

const engine = {
  time: timeState,
  input: inputApi,
  scene: sceneApi,
  animation: animationApi,
  audio: audioApi,
  particles: particlesApi,
  physics: physicsApi,
  ui: uiApi,
  log(...args) {
    postLog("info", formatArgs(args));
    console.log(...args);
  },
  warn(...args) {
    postLog("warn", formatArgs(args));
    console.warn(...args);
  },
  error(...args) {
    postLog("error", formatArgs(args));
    console.error(...args);
  },
};

export {
  ComponentImpl as Component,
  Entity,
  engine,
  math,
  Transform,
  MeshNode,
  LightNode,
  CameraNode,
  SkyboxNode,
  ParticleSystemNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  Transform as transform,
  MeshNode as meshNode,
  LightNode as lightNode,
  CameraNode as cameraNode,
  SkyboxNode as skyboxNode,
  ParticleSystemNode as particleSystemNode,
  UICanvasNode as uiCanvasNode,
  UIImageNode as uiImageNode,
  UITextNode as uiTextNode,
  UIButtonNode as uiButtonNode,
  // 脚本通用系统（委托/对象池/数据中心）
  Delegate,
  Pool,
  DataCenter,
  dataCenter,
  // 内置组件门面类（getComponent/addComponent 参数；组件字段声明类型）
  RigidBody,
  Collider,
  Light,
  AudioSource,
  AnimationClip,
  SkeletalAnimation,
};
