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
function jsPathOf(srcRel) {
  return srcRel.replace(/\.tsx?$/, ".js");
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// 固定步长与掉帧补偿上限：与 runtime/physics.mjs 的物理步进同参数（同频推进，
// onFixedUpdate 里的施力/速度写入在紧随其后的物理步进生效）
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

/** 属性默认值深拷贝（vec3 等对象默认值不与 schema 共享引用） */
function cloneDefault(v) {
  if (v && typeof v === "object") return Array.isArray(v) ? [...v] : { ...v };
  return v;
}

/**
 * 实例化脚本组件并挂接属性视图：
 * - 装饰器模式（字段 @property，klass.__tvePropKeys 非空）：new 后字段初值即
 *   默认值；节点配置的 props 覆盖字段（this.字段名 直接读写）；
 * - legacy 静态 props（klass.props）：默认值取声明 default，节点配置覆盖；
 *   两者都挂只读视图 this.props（默认 + 配置覆盖的字典快照）。
 */
function buildInstance(klass, entity, configured) {
  const inst = new klass(entity);
  const keys = Array.isArray(klass.__tvePropKeys) ? klass.__tvePropKeys : [];
  const fieldMode = keys.length > 0;
  const merged = {};
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
    Object.assign(merged, configured);
    if (fieldMode) {
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(configured, k)) inst[k] = merged[k];
      }
    }
  }
  // 场景节点引用（@property({type: 节点类}) 登记的实体键）：把配置里存的节点 id
  // 解析为 Entity；未配置/空 id → null
  const entityKeys = Array.isArray(klass.__tveEntityKeys) ? klass.__tveEntityKeys : [];
  if (entityKeys.length) {
    const raw = (configured && typeof configured === "object" ? configured : {});
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
function callLifecycle(record, method, ...args) {
  const fn = record.inst[method];
  if (typeof fn !== "function") return;
  try {
    record.inst[method](...args);
  } catch (e) {
    record.dead = true;
    postLog("error", `[脚本] ${record.script} ${method}() 出错（已停用）: ${errText(e)}`);
    console.error(e);
  }
}

/**
 * 创建脚本运行时。
 * @param {object} opts
 * @param {Array<{json: object, obj: object}>} opts.nodes buildSceneTree 的全节点注册表
 * @param {object} opts.cfg 项目配置（entryScript = 入口脚本源路径）
 * @param {{play,stop,pause,resume,bindingOf,...}|null} opts.animations 动画控制（engine.animation 转发）
 * @param {{play,stop,pause,resume,setVolume,...}|null} opts.audios 音频控制（engine.audio 转发）
 * @param {object|null} opts.physics 物理控制（engine.physics 转发）
 * @param {object|null} opts.clipAnims 关键帧动画剪辑控制（组件字段/门面用）
 * @param {{play,pause,stop,restart,clear,infoOf,settingsOf,updateSettings}|null} opts.particles 粒子系统控制（engine.particles / ParticleSystemNode 转发）
 * @param {{sampleHeight,sampleSlope,settingsOf}|null} opts.terrains 地形系统（TerrainNode 贴地采样转发）
 * @param {{update,applyTextures,settingsOf,updateSettings,onClick,offClick}|null} opts.ui UI 运行时控制（engine.ui / UI 节点门面转发）
 * @param {HTMLCanvasElement|null} opts.canvas 预览画布（指针输入）
 * @returns {Promise<{update(dt: number): void}>}
 */
export async function createScripts({ nodes, cfg, animations, audios, physics, clipAnims, particles, terrains, ui, canvas }) {
  const noop = { fixedUpdate() {}, update() {}, lateUpdate() {}, dispose() {} };
  const rootEntry = nodes.length ? nodes[0] : null;
  installRuntime({
    registry: nodes,
    rootObj: rootEntry ? rootEntry.obj : null,
    canvas: canvas ?? null,
    animations: animations ?? null,
    audios: audios ?? null,
    physics: physics ?? null,
    clipAnims: clipAnims ?? null,
    particles: particles ?? null,
    terrains: terrains ?? null,
    ui: ui ?? null,
    scripts: { spawn },
  });

  // 组件引用收集（注册表为文档序：先父后子）；executionOrder 为执行顺序
  // （小者先跑，同序按挂载顺序）
  const bindings = [];
  for (const { json, obj } of nodes) {
    const comps = Array.isArray(json.components) ? json.components : [];
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
  const modules = new Map();
  function loadModule(srcRel) {
    let p = modules.get(srcRel);
    if (!p) {
      p = (async () => {
        const jsRel = jsPathOf(srcRel);
        const spec = window.__TVE_BUILD_DATA
          ? "tve:" + jsRel
          : new URL(jsRel, document.baseURI).href;
        return await import(spec);
      })();
      p.catch(() => {});
      modules.set(srcRel, p);
    }
    return p;
  }

  /** @type {Array<{inst: object, script: string, dead: boolean, order: number}>} */
  const instances = [];
  /** 节点 id → 挂载的脚本实例记录（碰撞回调按节点寻址分发） */
  const instancesByNode = new Map();
  const failedScripts = new Set();

  async function instantiate(items) {
    for (const item of items) {
      let mod;
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
      if (typeof Klass !== "function" || !(Klass.prototype instanceof Component)) {
        if (!failedScripts.has(item.script)) {
          failedScripts.add(item.script);
          postLog("error", `[脚本] ${item.script} 缺少默认导出的 Component 子类`);
        }
        continue;
      }
      const entity = getEntity(item.obj);
      if (!entity) continue;
      let inst;
      try {
        inst = buildInstance(Klass, entity, item.props);
      } catch (e) {
        postLog("error", `[脚本] 实例化失败 ${item.script}: ${errText(e)}`);
        continue;
      }
      // 注册表登记（脚本类全局可见 + 实例挂节点），随后绑定组件引用字段
      registerScriptClass(item.script, Klass);
      registerComponent(entity.id, inst, item.script);
      const record = { inst, script: item.script, dead: false, order: item.order ?? 0 };
      instances.push(record);
      let list = instancesByNode.get(entity.id);
      if (!list) {
        list = [];
        instancesByNode.set(entity.id, list);
      }
      list.push(record);
      bindComponentFields(inst, Klass, entity);
    }
  }

  /**
   * 组件引用字段绑定（__tveComponentKeys；实例注册后调用）：
   * - 内置组件键（"animationClip" 等）→ tve resolveComponentField get-or-create；
   * - 脚本组件键（"script:类名"）→ 实体已有该脚本组件则绑定，没有则动态创建
   *   （按需自动挂载依赖组件；创建的实例立即进入生命周期）。
   */
  function bindComponentFields(inst, Klass, entity) {
    const compKeys = Array.isArray(Klass.__tveComponentKeys) ? Klass.__tveComponentKeys : [];
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
  function resolveScriptField(entity, name) {
    return resolveScriptInstance(entity.id, name) ?? spawn(entity, name);
  }

  /**
   * 动态实例化脚本组件（entity.addComponent(脚本类/路径/类名) 与脚本字段
   * get-or-create 的共用入口）。tokenOrClass = 脚本类 / 源路径 / 类名；
   * props 为属性配置。创建的实例立即走 onEnable → onStart（统一批次已过）
   * 并进入每帧更新队列（onFixedUpdate/onUpdate/onLateUpdate；执行顺序排末尾）。
   */
  function spawn(entity, tokenOrClass, props) {
    const found = resolveScriptClass(tokenOrClass);
    if (!found) {
      const label = typeof tokenOrClass === "function" ? tokenOrClass.name : String(tokenOrClass);
      postLog("warn", `[脚本] 未找到脚本类: ${label}（该脚本需已挂载在场景任意节点或为入口脚本，才会被加载注册）`);
      return null;
    }
    const { klass, srcRel } = found;
    if (!entity || typeof entity.id !== "string" || !entity.id) return null;
    let inst;
    try {
      inst = buildInstance(klass, entity, props);
    } catch (e) {
      postLog("error", `[脚本] 动态创建失败 ${srcRel || klass.name}: ${errText(e)}`);
      return null;
    }
    // 先注册再绑字段：被引用脚本（含自引用）的字段解析能命中本实例
    registerComponent(entity.id, inst, srcRel);
    const record = { inst, script: srcRel || klass.name || "(动态创建)", dead: false, order: 1e9 };
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
  function dispose() {
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
  function dispatchCollisions() {
    const events = physics?.drainCollisions?.() ?? [];
    if (!events.length) return;
    const seen = new Set();
    for (const ev of events) {
      if (!ev || typeof ev.a !== "string" || typeof ev.b !== "string") continue;
      const forward = `${ev.a}|${ev.b}|${ev.started ? 1 : 0}`;
      const backward = `${ev.b}|${ev.a}|${ev.started ? 1 : 0}`;
      if (!seen.has(forward)) {
        seen.add(forward);
        dispatchCollision(ev.a, ev.b, ev.started);
      }
      if (ev.a !== ev.b && !seen.has(backward)) {
        seen.add(backward);
        dispatchCollision(ev.b, ev.a, ev.started);
      }
    }
  }

  function dispatchCollision(selfId, otherId, started) {
    const list = instancesByNode.get(selfId);
    if (!list || !list.length) return;
    const other = resolveNodeEntity(otherId);
    for (const record of list) {
      if (record.dead) continue;
      callLifecycle(record, started ? "onCollisionEnter" : "onCollisionExit", other);
    }
  }

  return {
    /**
     * 固定步长驱动（播放器每帧最先调用，先于同帧 update/物理步进）：
     * 帧间隔累积到固定步长（1/60s，与 runtime/physics.mjs 的 FIXED_DT 同频，
     * 脚本可在 onFixedUpdate 里做与物理同步的确定性逻辑）才触发，一次渲染帧
     * 可能不调用或连续调用多次（掉帧补偿上限与物理一致，避免死亡螺旋）。
     */
    fixedUpdate(dt) {
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
    update(dt) {
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
    lateUpdate(dt) {
      for (const record of instances) {
        if (record.dead) continue;
        callLifecycle(record, "onLateUpdate", dt);
      }
    },
    dispose,
  };
}
