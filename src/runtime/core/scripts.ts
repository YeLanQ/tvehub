// ---------------------------------------------------------------------------
// 脚本宿主：加载用户脚本（编辑器编译后的 src/**.js），按节点 components 数组与
// config.entryScript 实例化 tve.Component，并驱动生命周期
// （onEnable → onStart → onUpdate → onLateUpdate → onDisable/onDestroy，
//  另有固定步长的 onFixedUpdate，见文末 fixedUpdate/lateUpdate 驱动）。
//
// 执行顺序：组件 executionOrder 升序稳定排序（同序按挂载顺序）。
//
// 模块寻址（与构建产物形态对应）：
// - 文件模式（编辑器预览 / 多文件产物）：按页面地址 new URL(rel, baseURI) 导入；
// - 单页内联模式（window.__TVE_BUILD_DATA 存在）：bootstrap 已注入 tve:<rel>
//   import map，直接以裸说明符导入 Blob 模块。
//
// 错误隔离：单个脚本加载/实例化/生命周期出错只停用该实例并上报
// （postLog → 编辑器控制台），不影响渲染与其他脚本。
// ---------------------------------------------------------------------------
import type { Object3D } from "../core/three.module.min.js";
import { postLog } from "./log";
import {
  Component,
  getEntity,
  installRuntime,
  registerComponent,
  registerScriptClass,
  resolveComponentField,
  resolveNodeEntity,
  resolveScriptClass,
  resolveScriptInstance,
  tickTime,
} from "./tve";

/** 源路径（src/**.ts）→ 编译产物路径（src/**.js） */
function jsPathOf(srcRel: string): string {
  return srcRel.replace(/\.tsx?$/, ".js");
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 固定步长与掉帧补偿上限：与 runtime/physics.mjs 的物理步进同参数（同频推进，
// onFixedUpdate 里的施力/速度写入在紧随其后的物理步进生效）
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

/** 属性默认值深拷贝（vec3 等对象默认值不与 schema 共享引用） */
function cloneDefault(v: unknown): unknown {
  if (v && typeof v === "object") return Array.isArray(v) ? [...v] : { ...v };
  return v;
}

/** 脚本类静态形状（装饰器元数据挂在构造器上；legacy 模式用静态 props 表） */
interface ScriptKlass {
  new (entity: unknown): Record<string, unknown>;
  prototype: object;
  name: string;
  /** @property 字段名集（装饰器模式非空） */
  __tvePropKeys?: string[];
  /** 节点引用字段（@property({type: 节点类})；字段名集） */
  __tveEntityKeys?: string[];
  /** 组件引用字段（[字段名, 组件类型键]） */
  __tveComponentKeys?: [string, string][];
  /** legacy 静态属性表（字段名 → { default }） */
  props?: Record<string, { default?: unknown }>;
}

/** 脚本实例运行记录（生命周期驱动/错误停用/图输入缓存） */
interface ScriptRecord {
  inst: Record<string, unknown>;
  script: string;
  dead: boolean;
  order: number;
  graphInput?: unknown;
}

/** 组件挂载绑定（场景 script 组件收集结果） */
interface ScriptBinding {
  obj: Object3D;
  script: string;
  props: unknown;
  order: number;
}

/**
 * 实例化脚本组件并挂接属性视图：
 * - 装饰器模式（字段 @property，klass.__tvePropKeys 非空）：new 后字段初值即
 *   默认值；节点配置的 props 覆盖字段（this.字段名 直接读写）；
 * - legacy 静态 props（klass.props）：默认值取声明 default，节点配置覆盖；
 *   两者都挂只读视图 this.props（默认 + 配置覆盖的字典快照）。
 */
function buildInstance(klass: ScriptKlass, entity: unknown, configured: unknown): Record<string, unknown> {
  const inst = new klass(entity);
  const keys = Array.isArray(klass.__tvePropKeys) ? klass.__tvePropKeys : [];
  const fieldMode = keys.length > 0;
  const merged: Record<string, unknown> = {};
  if (fieldMode) {
    for (const k of keys) merged[k] = inst[k];
  } else {
    const schema = typeof klass === "function" ? klass.props : null;
    if (schema && typeof schema === "object") {
      for (const [k, def] of Object.entries(schema)) {
        if (def && typeof def === "object" && Object.prototype.hasOwnProperty.call(def, "default")) {
          merged[k] = cloneDefault(def.default);
        }
      }
    }
  }
  if (configured && typeof configured === "object") {
    const cfg = configured as Record<string, unknown>;
    Object.assign(merged, cfg);
    if (fieldMode) {
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(cfg, k)) inst[k] = merged[k];
      }
    }
  }
  // 场景节点引用（@property({type: 节点类}) 登记的实体键）：把配置里存的节点 id
  // 解析为 Entity；未配置/空 id → null
  const entityKeys = Array.isArray(klass.__tveEntityKeys) ? klass.__tveEntityKeys : [];
  if (entityKeys.length) {
    const raw = (configured && typeof configured === "object" ? configured : {}) as Record<string, unknown>;
    for (const k of entityKeys) {
      const id = raw[k];
      const ent = typeof id === "string" && id ? resolveNodeEntity(id) : null;
      merged[k] = ent;
      inst[k] = ent;
    }
  }
  // 组件引用字段（__tveComponentKeys：[字段名, 组件类型键]）不在 buildInstance
  // 内绑定：脚本组件字段的 get-or-create 需要实例表闭包，改由 instantiate/
  // spawn 在注册实例后调用 bindComponentFields 完成。
  Object.defineProperty(inst, "props", {
    value: Object.freeze(merged),
    writable: false,
    configurable: true,
    enumerable: false,
  });
  return inst;
}

/** 生命周期调用（出错 → 停用该实例并上报，不再驱动） */
function callLifecycle(record: ScriptRecord, method: string, ...args: unknown[]): void {
  const fn = record.inst[method];
  if (typeof fn !== "function") return;
  try {
    (fn as (...a: unknown[]) => void)(...args);
  } catch (e) {
    record.dead = true;
    postLog("error", `[脚本] ${record.script} ${method}() 出错（已停用）: ${errText(e)}`);
    console.error(e);
  }
}

/** createScripts 装配选项（player 传入；各子系统控制面允许缺省） */
export interface ScriptsOptions {
  /** buildSceneTree 的全节点注册表（json + obj） */
  nodes: { json: Record<string, unknown>; obj: Object3D }[];
  /** 项目配置（entryScript = 入口脚本源路径） */
  cfg: Record<string, unknown>;
  /** 动画控制（engine.animation 转发） */
  animations?: object | null;
  /** 音频控制（engine.audio 转发） */
  audios?: object | null;
  /** 物理控制（engine.physics 转发；碰撞回调分发读 drainCollisions） */
  physics?: { drainCollisions?(): unknown[] } | null;
  /** 关键帧动画剪辑控制（组件字段/门面用） */
  clipAnims?: object | null;
  /** 粒子系统控制（engine.particles / ParticleSystemNode 转发） */
  particles?: object | null;
  /** 地形系统（TerrainNode 贴地采样转发） */
  terrains?: object | null;
  /** UI 运行时控制（engine.ui / UI 节点门面转发） */
  ui?: object | null;
  /** 逻辑运行器控制（状态机/行为树；engine.logic 转发） */
  logic?: object | null;
  /** 预览画布（指针输入；DOM 结构由桥接层按平台注入，此处不直引 DOM 类型） */
  canvas?: unknown;
  /** 渲染相机控制（CameraNode.screenToRay 转发） */
  camera?: {
    screenToRay(screenX: number, screenY: number): { origin: object; direction: object } | null;
  } | null;
}

/**
 * 创建脚本运行时。
 */
export async function createScripts({
  nodes,
  cfg,
  animations,
  audios,
  physics,
  clipAnims,
  particles,
  terrains,
  ui,
  logic,
  canvas,
  camera,
}: ScriptsOptions): Promise<{
  fixedUpdate(dt: number): void;
  update(dt: number): void;
  lateUpdate(dt: number): void;
  scriptProp(nodeId: string, scriptRel: string | null, key: string): unknown;
  setScriptProp(nodeId: string, scriptRel: string | null, key: string, value: unknown): boolean;
  setScriptGraphInput(nodeId: string, scriptRel: string | null, value: unknown): boolean;
  dispose(): void;
}> {
  type ScriptsHandle = {
    fixedUpdate(dt: number): void;
    update(dt: number): void;
    lateUpdate(dt: number): void;
    scriptProp(nodeId: string, scriptRel: string | null, key: string): unknown;
    setScriptProp(nodeId: string, scriptRel: string | null, key: string, value: unknown): boolean;
    setScriptGraphInput(nodeId: string, scriptRel: string | null, value: unknown): boolean;
    dispose(): void;
  };
  const noop = {
    fixedUpdate() {},
    update() {},
    lateUpdate() {},
    scriptProp: () => null,
    setScriptProp: () => false,
    setScriptGraphInput: () => false,
    dispose() {},
  } as ScriptsHandle;
  const rootEntry = nodes.length ? nodes[0] : null;
  installRuntime({
    registry: nodes,
    rootObj: rootEntry ? rootEntry.obj : null,
    // ScriptsOptions.canvas 为 unknown 透传；装配边界在 installRuntime 内统一断言
    canvas: canvas as unknown as import("./tve/state").PointerCanvas | null,
    animations: animations ?? null,
    audios: audios ?? null,
    physics: physics ?? null,
    clipAnims: clipAnims ?? null,
    particles: particles ?? null,
    terrains: terrains ?? null,
    ui: ui ?? null,
    logic: logic ?? null,
    camera: camera ?? null,
    scripts: { spawn },
  });

  // 组件引用收集（注册表为文档序：先父后子）；executionOrder 为执行顺序
  // （小者先跑，同序按挂载顺序）
  const bindings: ScriptBinding[] = [];
  for (const { json, obj } of nodes) {
    const comps = Array.isArray(json.components) ? (json.components as Record<string, unknown>[]) : [];
    for (const c of comps) {
      if (!c || typeof c !== "object" || c.type !== "script" || c.enabled === false) continue;
      if (typeof c.script !== "string" || !c.script) continue;
      bindings.push({
        obj,
        script: c.script,
        props: c.props,
        order: typeof c.executionOrder === "number" && Number.isFinite(c.executionOrder)
          ? c.executionOrder
          : 0,
      });
    }
  }
  const entryRel = typeof cfg.entryScript === "string" ? cfg.entryScript.trim() : "";
  if (!bindings.length && !entryRel) return noop;

  // 模块缓存（源路径 → Promise<module>；失败缓存避免重复报错）
  const modules = new Map<string, Promise<Record<string, unknown>>>();
  function loadModule(srcRel: string): Promise<Record<string, unknown>> {
    let p = modules.get(srcRel);
    if (!p) {
      // 锚点「return await import(spec);」被 wechat 构建改写（勿加注释/改形）
      p = (async () => {
        const jsRel = jsPathOf(srcRel);
        const spec = (window as { __TVE_BUILD_DATA?: unknown }).__TVE_BUILD_DATA
          ? "tve:" + jsRel
          : new URL(jsRel, document.baseURI).href;
        return await import(spec);
      })() as Promise<Record<string, unknown>>;
      p.catch(() => {});
      modules.set(srcRel, p);
    }
    return p;
  }

  const instances: ScriptRecord[] = [];
  /** 节点 id → 挂载的脚本实例记录（碰撞回调按节点寻址分发） */
  const instancesByNode = new Map<string, ScriptRecord[]>();
  const failedScripts = new Set<string>();

  async function instantiate(items: ScriptBinding[]): Promise<void> {
    for (const item of items) {
      let mod: Record<string, unknown>;
      try {
        mod = await loadModule(item.script);
      } catch (e) {
        if (!failedScripts.has(item.script)) {
          failedScripts.add(item.script);
          postLog("error", `[脚本] 加载失败 ${item.script}: ${errText(e)}`);
        }
        continue;
      }
      const Klass = mod && mod.default;
      if (typeof Klass !== "function" || !((Klass as ScriptKlass).prototype instanceof Component)) {
        if (!failedScripts.has(item.script)) {
          failedScripts.add(item.script);
          postLog("error", `[脚本] ${item.script} 缺少默认导出的 Component 子类`);
        }
        continue;
      }
      const klass = Klass as ScriptKlass;
      const entity = getEntity(item.obj);
      if (!entity) continue;
      let inst: Record<string, unknown>;
      try {
        inst = buildInstance(klass, entity, item.props);
      } catch (e) {
        postLog("error", `[脚本] 实例化失败 ${item.script}: ${errText(e)}`);
        continue;
      }
      // 注册表登记（脚本类全局可见 + 实例挂节点），随后绑定组件引用字段
      registerScriptClass(item.script, klass);
      registerComponent(entity.id, inst, item.script);
      const record: ScriptRecord = { inst, script: item.script, dead: false, order: item.order ?? 0 };
      instances.push(record);
      let list = instancesByNode.get(entity.id);
      if (!list) {
        list = [];
        instancesByNode.set(entity.id, list);
      }
      list.push(record);
      bindComponentFields(inst, klass, entity);
    }
  }

  /**
   * 组件引用字段绑定（__tveComponentKeys；实例注册后调用）：
   * - 内置组件键（"animationClip" 等）→ tve resolveComponentField get-or-create；
   * - 脚本组件键（"script:类名"）→ 实体已有该脚本组件则绑定，没有则动态创建
   *   （按需自动挂载依赖组件；创建的实例立即进入生命周期）。
   */
  function bindComponentFields(inst: Record<string, unknown>, klass: ScriptKlass, entity: { id: string }): void {
    const compKeys = Array.isArray(klass.__tveComponentKeys) ? klass.__tveComponentKeys : [];
    for (const entry of compKeys) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
        continue;
      }
      const token = entry[1];
      inst[entry[0]] = token.startsWith("script:")
        ? resolveScriptField(entity, token.slice(7))
        : resolveComponentField(entity, token);
    }
  }

  /** 脚本组件字段解析：实体已有该脚本组件 → 绑定；没有 → 动态创建 */
  function resolveScriptField(entity: { id: string }, name: string): unknown {
    return resolveScriptInstance(entity.id, name) ?? spawn(entity, name);
  }

  /**
   * 动态实例化脚本组件（entity.addComponent(脚本类/路径/类名) 与脚本字段
   * get-or-create 的共用入口）。tokenOrClass = 脚本类 / 源路径 / 类名；
   * props 为属性配置。创建的实例立即走 onEnable → onStart（统一批次已过）
   * 并进入每帧更新队列（onFixedUpdate/onUpdate/onLateUpdate；执行顺序排末尾）。
   */
  function spawn(entity: { id: string }, tokenOrClass: unknown, props?: unknown): Record<string, unknown> | null {
    const found = resolveScriptClass(tokenOrClass);
    if (!found) {
      const label = typeof tokenOrClass === "function" ? tokenOrClass.name : String(tokenOrClass);
      postLog("warn", `[脚本] 未找到脚本类: ${label}（该脚本需已挂载在场景任意节点或为入口脚本，才会被加载注册）`);
      return null;
    }
    const { klass, srcRel } = found;
    if (!entity || typeof entity.id !== "string" || !entity.id) return null;
    let inst: Record<string, unknown>;
    try {
      inst = buildInstance(klass, entity, props);
    } catch (e) {
      postLog("error", `[脚本] 动态创建失败 ${srcRel || klass.name}: ${errText(e)}`);
      return null;
    }
    // 先注册再绑字段：被引用脚本（含自引用）的字段解析能命中本实例
    registerComponent(entity.id, inst, srcRel);
    const record: ScriptRecord = { inst, script: srcRel || klass.name || "(动态创建)", dead: false, order: 1e9 };
    instances.push(record);
    let list = instancesByNode.get(entity.id);
    if (!list) {
      list = [];
      instancesByNode.set(entity.id, list);
    }
    list.push(record);
    bindComponentFields(inst, klass, entity);
    callLifecycle(record, "onEnable");
    callLifecycle(record, "onStart");
    return inst;
  }

  await instantiate(bindings);
  // 入口脚本挂根节点（脚本模式：全局逻辑）
  if (entryRel && rootEntry) {
    await instantiate([{ obj: rootEntry.obj, script: entryRel, props: {}, order: 0 }]);
  }
  if (!instances.length) return noop;

  // 执行顺序：按 executionOrder 升序稳定排序（同序保持挂载顺序；入口脚本 order=0）
  instances.sort((a, b) => a.order - b.order);

  // 生命周期：全部实例化后先统一 onEnable（组件就绪/可引用其他实体），再统一 onStart
  // （onEnable → onStart 批次顺序）
  for (const record of instances) callLifecycle(record, "onEnable");
  for (const record of instances) callLifecycle(record, "onStart");
  postLog("info", `[脚本] 已启动 ${instances.length} 个脚本实例`);

  let disposed = false;
  /** onFixedUpdate 固定步长累积器（帧间隔凑满 1/60s 才触发，见 fixedUpdate） */
  let fixedAccumulator = 0;
  /** 页面卸载/宿主停机：onDisable → onDestroy（各一次；错误实例已停用则跳过） */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const record of instances) {
      if (record.dead) continue;
      callLifecycle(record, "onDisable");
      callLifecycle(record, "onDestroy");
      record.dead = true;
    }
  }

  /**
   * 物理碰撞回调分发（onCollisionEnter/Exit 在 Update 前调用）。
   * 事件为节点 id 对（physics.mjs 后端收集）；双方实体各自收到一次回调，
   * 参数为对方实体。同一帧内按 self|other|started 去重（复合形状多碰撞体）。
   */
  function dispatchCollisions(): void {
    const events = physics?.drainCollisions?.() ?? [];
    if (!events.length) return;
    const seen = new Set<string>();
    for (const raw of events) {
      const ev = raw as { a?: unknown; b?: unknown; started?: unknown } | null;
      if (!ev || typeof ev.a !== "string" || typeof ev.b !== "string") continue;
      const started = ev.started === true;
      const forward = `${ev.a}|${ev.b}|${started ? 1 : 0}`;
      const backward = `${ev.b}|${ev.a}|${started ? 1 : 0}`;
      if (!seen.has(forward)) {
        seen.add(forward);
        dispatchCollision(ev.a, ev.b, started);
      }
      if (ev.a !== ev.b && !seen.has(backward)) {
        seen.add(backward);
        dispatchCollision(ev.b, ev.a, started);
      }
    }
  }

  function dispatchCollision(selfId: string, otherId: string, started: boolean): void {
    const list = instancesByNode.get(selfId);
    if (!list || !list.length) return;
    const other = resolveNodeEntity(otherId);
    for (const record of list) {
      if (record.dead) continue;
      callLifecycle(record, started ? "onCollisionEnter" : "onCollisionExit", other);
    }
  }

  // ----- 脚本属性访问（场景图 script:<路径>:<属性> 寻址；图运行时 scriptApi 消费） -----

  /** 节点上的脚本实例记录定位（relPath 精确匹配 → 缺省首个存活实例） */
  function findScriptRecord(nodeId: string, scriptRel: string | null): ScriptRecord | null {
    const list = instancesByNode.get(nodeId);
    if (!list || !list.length) return null;
    if (scriptRel) {
      const exact = list.find((r) => r.script === scriptRel && !r.dead);
      if (exact) return exact;
    }
    return list.find((r) => !r.dead) ?? null;
  }

  /** 读 @property 实时值（字段模式读 inst 字段；legacy 读 props 快照；非标量回 null） */
  function scriptProp(nodeId: string, scriptRel: string | null, key: string): unknown {
    const record = findScriptRecord(nodeId, scriptRel);
    if (!record) return null;
    let v = record.inst[key];
    if (v === undefined && record.inst.props) v = (record.inst.props as Record<string, unknown>)[key];
    const t = typeof v;
    if (t === "number") return Number.isFinite(v as number) ? v : null;
    if (t === "boolean" || t === "string") return v;
    return null;
  }

  /** 写 @property（仅字段模式可写；legacy props 是冻结视图，回 false） */
  function setScriptProp(nodeId: string, scriptRel: string | null, key: string, value: unknown): boolean {
    const record = findScriptRecord(nodeId, scriptRel);
    if (!record) return false;
    const ctor = record.inst.constructor as ScriptKlass | undefined;
    const keys = Array.isArray(ctor?.__tvePropKeys) ? (ctor!.__tvePropKeys as string[]) : [];
    if (!keys.includes(key)) return false;
    try {
      record.inst[key] = value;
      return true;
    } catch {
      return false;
    }
  }

  // ----- 图接入口交付（原型卡「接入」→ 实体上脚本实例；graph-kernel 消费） -----

  /** 图输入值收敛：NodeObj（带 id 标记）→ Entity，三分量对象 → 普通向量，标量透传 */
  function convertGraphInputValue(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && o.id) return resolveNodeEntity(o.id);
      const x = typeof o.x === "number" ? o.x : null;
      const y = typeof o.y === "number" ? o.y : null;
      const z = typeof o.z === "number" ? o.z : null;
      if (x !== null && y !== null && z !== null) return { x, y, z };
    }
    return null;
  }

  /** onGraphInput 出错不拖垮脚本实例（每脚本只报一次） */
  const graphInputWarned = new Set<string>();

  /**
   * 接入口值交付：写入该节点上全部存活脚本实例的 this.graphInput（可轮询的
   * 最新值）并回调 onGraphInput(value)（实现了才触发）。scriptRel 为空 = 全部
   * 脚本；节点上没有存活脚本实例回 false（kernel 据此给可定位告警）。
   */
  function setScriptGraphInput(nodeId: string, scriptRel: string | null, value: unknown): boolean {
    const list = instancesByNode.get(nodeId);
    if (!list || !list.length) return false;
    const targets = list.filter((r) => !r.dead && (!scriptRel || r.script === scriptRel));
    if (!targets.length) return false;
    const converted: unknown = Array.isArray(value)
      ? (value as unknown[]).map(convertGraphInputValue).filter((v) => v !== null)
      : convertGraphInputValue(value);
    for (const record of targets) {
      record.graphInput = converted;
      // 字段模式脚本若恰好声明了同名 @property，字段归属脚本本身，不注入
      const ctor = record.inst.constructor as ScriptKlass | undefined;
      const keys = Array.isArray(ctor?.__tvePropKeys) ? (ctor!.__tvePropKeys as string[]) : [];
      if (!keys.includes("graphInput")) {
        try {
          record.inst.graphInput = converted;
        } catch {
          /* 冻结/只读实例忽略 */
        }
      }
      if (typeof record.inst.onGraphInput === "function") {
        try {
          (record.inst.onGraphInput as (v: unknown) => void)(converted);
        } catch (e) {
          if (!graphInputWarned.has(record.script)) {
            graphInputWarned.add(record.script);
            postLog("warn", `[脚本] ${record.script} onGraphInput() 出错: ${errText(e)}`);
          }
          console.error(e);
        }
      }
    }
    return true;
  }

  return {
    /**
     * 固定步长驱动（播放器每帧最先调用，先于同帧 update/物理步进）：
     * 帧间隔累积到固定步长（1/60s，与 runtime/physics.mjs 的 FIXED_DT 同频，
     * 脚本可在 onFixedUpdate 里做与物理同步的确定性逻辑）才触发，一次渲染帧
     * 可能不调用或连续调用多次（掉帧补偿上限与物理一致，避免死亡螺旋）。
     */
    fixedUpdate(dt: number) {
      fixedAccumulator += Math.min(Math.max(dt, 0), FIXED_DT * MAX_SUBSTEPS);
      while (fixedAccumulator >= FIXED_DT) {
        fixedAccumulator -= FIXED_DT;
        for (const record of instances) {
          if (record.dead) continue;
          callLifecycle(record, "onFixedUpdate", FIXED_DT);
        }
      }
    },
    /** 每帧驱动：碰撞回调 → 时间推进 + onUpdate（错误实例自动停用） */
    update(dt: number) {
      dispatchCollisions();
      tickTime(dt);
      for (const record of instances) {
        if (record.dead) continue;
        callLifecycle(record, "onUpdate", dt);
      }
    },
    /**
     * 晚更新驱动（播放器在全部脚本/动画/物理/粒子更新后、相机回填与渲染前
     * 调用）：相机跟随等「要覆盖本帧一切位姿写入」的逻辑放 onLateUpdate。
     */
    lateUpdate(dt: number) {
      for (const record of instances) {
        if (record.dead) continue;
        callLifecycle(record, "onLateUpdate", dt);
      }
    },
    /** 脚本组件属性读/写（场景图 script:<路径>:<属性> 寻址；player 注入 graph ctx.scriptApi） */
    scriptProp,
    setScriptProp,
    /** 图接入口交付（原型卡「接入」口 → 实体上脚本实例；player 注入 graph scriptApi） */
    setScriptGraphInput,
    dispose,
  };
}
