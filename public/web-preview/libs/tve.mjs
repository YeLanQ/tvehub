// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 运行时（模块说明符 "tve"）。
// 类型契约见 src/framework/scripting/tve.d.ts（两者保持镜像同步；本文件是
// 播放器侧实现，编辑器侧不加载本模块）。
//
// 设计约束：
// - 对用户脚本只暴露引擎自有类型（Vec3 普通对象 / 度制欧拉角，与编辑器
//   数据模型一致），不暴露任何 three.js 接口；three 对象仅在本模块内部使用；
// - 本模块不主动启动：由 libs/scripts.mjs（脚本宿主）经 installRuntime 注入
//   场景注册表与动画控制后，engine 各接口才可用（未注入时安全空转）。
// ---------------------------------------------------------------------------
import * as THREE from "./three.module.min.js";
import { postLog } from "./log.mjs";

export const VERSION = "1.0.0";

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
 * @property {{play,stop,pause,resume}|null} animations 动画控制（按节点 id 寻址）
 * @property {{play,stop,pause,resume,setVolume}|null} audios 音频控制（按节点 id 寻址）
 */

/** @type {TveHost|null} */
let host = null;

/** three 对象 → Entity 句柄缓存（同一对象恒返回同一句柄） */
const entityByObj = new Map();

/** 节点 id → Component 实例列表（宿主注册；getComponent 用） */
const componentsByNode = new Map();

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

/** 宿主注册组件实例（getComponent 查询用） */
export function registerComponent(nodeId, instance) {
  let list = componentsByNode.get(nodeId);
  if (!list) {
    list = [];
    componentsByNode.set(nodeId, list);
  }
  list.push(instance);
}

/**
 * 安装运行时宿主（scripts.mjs 在实例化脚本前调用一次）。
 * @param {TveHost} api
 */
export function installRuntime(api) {
  host = api;
  entityByObj.clear();
  componentsByNode.clear();
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

  getComponent(componentClass) {
    const list = componentsByNode.get(this.id);
    if (!list) return null;
    return list.find((c) => c instanceof componentClass) ?? null;
  }
}

function numOr(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
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

// 编辑器 type 键 → 类型类（供 getEntity 按 userData.nodeKind 构建实例）
const KIND_CLASSES = {
  node: Transform,
  meshNode: MeshNode,
  cameraNode: CameraNode,
  skyboxNode: SkyboxNode,
  audioNode: Transform,
  lightNode: LightNode,
  pointLightNode: LightNode,
  directionalLightNode: LightNode,
  ambientLightNode: LightNode,
  spotLightNode: LightNode,
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
// 装饰器（参考 Cocos Creator @property / @nodeType 声明式写法）
// - property：字段装饰器，登记字段为组件可编辑属性（host 据此读取字段初值作
//   默认并注入节点配置覆盖）；类型契约见 tve.d.ts。
// - nodeType：类装饰器，登记脚本类为可创建节点类型（编辑器创建入口用）。
// 元数据挂在类上（__tvePropKeys / __tveNodeType），editor 经 AST 静态解析，
// 运行期仅 host 需要属性键集合（见 libs/scripts.mjs）。
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

/**
 * @property 装饰器（参考 Cocos Creator）。双形态：
 * - @property / @property() / @property({...})：字段装饰器，把字段名记入类
 *   __tvePropKeys，host 据此以字段初值为默认、按节点配置覆盖（this.字段名 读写）；
 *   options.type 传节点类型类（如 MeshNode）时，把该字段登记为场景节点引用
 *   （__tveEntityKeys）：host 会把节点配置里存的节点 id 解析为对应 Entity；
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
  // 工厂形态：@property() / @property({...}) → 返回字段装饰器
  const nodeRef = !!(
    targetOrOptions &&
    typeof targetOrOptions === "object" &&
    isNodeRefType(targetOrOptions.type)
  );
  return function decorate(target, key) {
    const ctor = typeof target === "function" ? target : target.constructor;
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

const engine = {
  time: timeState,
  input: inputApi,
  scene: sceneApi,
  animation: animationApi,
  audio: audioApi,
  physics: physicsApi,
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
  Transform,
  MeshNode,
  LightNode,
  CameraNode,
  SkyboxNode,
  Transform as transform,
  MeshNode as meshNode,
  LightNode as lightNode,
  CameraNode as cameraNode,
  SkyboxNode as skyboxNode,
};
