// 模型动画播放：移植编辑器 AnimationSystem 的“节点数据 → 运行时”语义
// （单剪辑 MeshNode.anim 直控 / 动画图 MeshNode.animGraph 状态机：
// exitTime + 参数条件 → 交叉淡化过渡）。预览只回放，不含编辑器侧的
// 骨骼辅助线、运行时手动控制（播放/暂停/参数注入）。
import * as THREE from "./three.module.min.js";

const LOOP_MODES = ["loop", "once", "pingpong"];

/** 单剪辑播放设置收敛（缺失字段回退默认；移植 parseClipSettings） */
function parseClipSettings(v) {
  const o = v && typeof v === "object" ? v : {};
  const loop = LOOP_MODES.includes(o.loop) ? o.loop : "loop";
  const num = (x, fb) => (typeof x === "number" && Number.isFinite(x) ? x : fb);
  return {
    autoplay: o.autoplay !== false,
    clip: typeof o.clip === "string" ? o.clip : "",
    speed: Math.max(0, num(o.speed, 1)),
    loop,
  };
}

/** 动画图收敛（状态去重、无效过渡剔除、entry 回退；移植 parseAnimGraph 关键分支） */
function parseAnimGraph(v) {
  if (!v || typeof v !== "object") return null;
  const states = [];
  const seen = new Set();
  for (const s of Array.isArray(v.states) ? v.states : []) {
    if (!s || typeof s !== "object" || typeof s.name !== "string" || !s.name || seen.has(s.name)) continue;
    seen.add(s.name);
    states.push({
      name: s.name,
      clip: typeof s.clip === "string" ? s.clip : "",
      speed: Math.max(0, typeof s.speed === "number" && Number.isFinite(s.speed) ? s.speed : 1),
      loop: LOOP_MODES.includes(s.loop) ? s.loop : "loop",
    });
  }
  if (!states.length) return null;
  const transitions = [];
  const seenIds = new Set();
  for (const t of Array.isArray(v.transitions) ? v.transitions : []) {
    if (!t || typeof t !== "object") continue;
    const from = typeof t.from === "string" ? t.from : "";
    const to = typeof t.to === "string" ? t.to : "";
    if (!from || !to || !seen.has(from) || !seen.has(to) || from === to) continue;
    const id = (typeof t.id === "string" && t.id) || `t${transitions.length + 1}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const num = (x, fb) => (typeof x === "number" && Number.isFinite(x) ? x : fb);
    transitions.push({
      id,
      from,
      to,
      duration: Math.max(0, num(t.duration, 0.25)),
      exitTime: Math.max(0, Math.min(1, num(t.exitTime, 0))),
      conditions: (Array.isArray(t.conditions) ? t.conditions : [])
        .filter((c) => !!c && typeof c === "object" && typeof c.param === "string" && c.param !== "")
        .map((c) => ({
          param: c.param,
          op: [">", "<", ">=", "<=", "==", "!="].includes(c.op) ? c.op : "==",
          value: num(c.value, 0),
        })),
    });
  }
  const params = {};
  if (v.params && typeof v.params === "object") {
    for (const [k, val] of Object.entries(v.params)) {
      if (typeof val === "number" && Number.isFinite(val)) params[k] = val;
      else if (typeof val === "boolean") params[k] = val;
    }
  }
  const entry = typeof v.entry === "string" && seen.has(v.entry) ? v.entry : states[0].name;
  return { entry, states, transitions, params };
}

/** 布尔/数值参数按数值比较（布尔 → 0/1） */
function evalCondition(param, cond) {
  if (param === undefined) return false;
  const v = typeof param === "boolean" ? (param ? 1 : 0) : param;
  switch (cond.op) {
    case ">":
      return v > cond.value;
    case "<":
      return v < cond.value;
    case ">=":
      return v >= cond.value;
    case "<=":
      return v <= cond.value;
    case "==":
      return v === cond.value;
    case "!=":
      return v !== cond.value;
  }
}

/** LoopMode → three 循环常量（once 需 clampWhenFinished 定格在末帧） */
function threeLoopOf(mode) {
  switch (mode) {
    case "once":
      return { loop: THREE.LoopOnce, clamp: true };
    case "pingpong":
      return { loop: THREE.LoopPingPong, clamp: false };
    default:
      return { loop: THREE.LoopRepeat, clamp: false };
  }
}

/** 单个模型节点的动画绑定（mixer + 剪辑动作表 + 图运行态） */
function createBinding(nodeJson, root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map();
  for (const clip of clips) {
    const name = clip.name || "clip";
    if (!actions.has(name)) actions.set(name, mixer.clipAction(clip));
  }
  return {
    nodeJson,
    mixer,
    actions,
    clips,
    currentClip: null,
    playing: false,
    graph: null,
    graphState: null,
  };
}

/** 剪辑名收敛：空/不存在 → 第一个剪辑（无剪辑返回 null） */
function resolveClipName(b, clip) {
  if (!b.actions.size) return null;
  if (clip && b.actions.has(clip)) return clip;
  return [...b.actions.keys()][0] ?? null;
}

function applyClipParams(action, settings) {
  action.timeScale = settings.speed;
  const { loop, clamp } = threeLoopOf(settings.loop);
  // repetitions：循环/往复取无限；LoopOnce 用 1（配合 clampWhenFinished 定格末帧）
  action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
  action.clampWhenFinished = clamp;
}

/** 剪辑切换：目标动作重置后播放，与当前动作交叉淡化 */
function playClipAction(b, clip, settings, fade) {
  const target = b.actions.get(clip);
  if (!target) return;
  const prev = b.currentClip ? b.actions.get(b.currentClip) : null;
  applyClipParams(target, settings);
  target.reset().play();
  if (prev && prev !== target && fade > 0) prev.crossFadeTo(target, fade, false);
  else if (prev && prev !== target) prev.stop();
  b.currentClip = clip;
  b.playing = true;
}

/** 图状态入场：切换 graphState 并播放对应剪辑（无剪辑则保持姿势） */
function enterGraphState(b, stateName, fade) {
  if (!b.graph) return;
  const state = b.graph.states.find((s) => s.name === stateName);
  b.graphState = stateName;
  if (!state || state.clip === "") {
    const cur = b.currentClip ? b.actions.get(b.currentClip) : null;
    if (cur) cur.fadeOut(fade);
    b.currentClip = null;
    b.playing = false;
    return;
  }
  const clip = resolveClipName(b, state.clip);
  if (!clip) return;
  playClipAction(b, clip, { speed: state.speed, loop: state.loop }, fade);
}

/** 应用节点动画设置：图优先，其次单剪辑，均无则停用（autoplay 默认开） */
function applySettings(b, nodeJson) {
  const anim = parseClipSettings(nodeJson.anim);
  const graph = parseAnimGraph(nodeJson.animGraph);
  if (graph) {
    b.graph = graph;
    enterGraphState(b, graph.entry, 0);
    if (anim.autoplay && !b.playing) {
      const state = b.graph.states.find((s) => s.name === (b.graphState ?? b.graph.entry));
      if (state && state.clip !== "") {
        const clip = resolveClipName(b, state.clip);
        if (clip) playClipAction(b, clip, { speed: state.speed, loop: state.loop }, 0);
      }
    }
    return;
  }
  b.graph = null;
  b.graphState = null;
  const wantClip = resolveClipName(b, anim.clip);
  if (anim.autoplay && wantClip) {
    playClipAction(b, wantClip, anim, 0.25);
    return;
  }
  // 未启用自动播放：停在初始姿势
  if (!b.playing) {
    b.mixer.stopAllAction();
    b.currentClip = null;
  }
}

/** 图状态机评估：exitTime（归一化进度）+ 参数条件满足 → 交叉淡化过渡 */
function evalGraph(b) {
  if (!b.graph || !b.graphState) return;
  const state = b.graph.states.find((s) => s.name === b.graphState);
  if (!state) return;
  const action = b.currentClip ? b.actions.get(b.currentClip) : null;
  let normalized = 1;
  if (action && b.currentClip) {
    const clip = b.clips.find((c) => (c.name || "clip") === b.currentClip);
    const dur = clip?.duration ?? 0;
    normalized = dur > 0 ? Math.min(1, action.time / dur) : 1;
  }
  for (const tr of b.graph.transitions) {
    if (tr.from !== b.graphState) continue;
    if (tr.exitTime > 0 && normalized < tr.exitTime) continue;
    const ok = tr.conditions.every((c) => evalCondition(b.graph.params[c.param], c));
    if (ok) {
      enterGraphState(b, tr.to, tr.duration);
      return; // 一帧只走一次过渡
    }
  }
}

/**
 * 为场景里的模型网格建立动画绑定：
 * meshes 为 buildSceneTree 收集的 meshNode 列表，模型实例挂在其 __modelRoot 子级
 * （与编辑器 SceneSynchronizer 同名约定）。返回 { update(dt) } 供渲染循环驱动，
 * 另附 play/stop/pause/resume（按节点 id 寻址，供脚本宿主 engine.animation 转发）。
 */
export function createAnimations(meshes, models) {
  const bindings = [];
  const byId = new Map();
  for (const entry of meshes) {
    const json = entry.json;
    if (json.source !== "model" || typeof json.model !== "string" || !json.model) continue;
    const root = entry.obj.getObjectByName("__modelRoot");
    const clips = models.get(json.model)?.clips;
    if (!root || !clips) continue;
    const b = createBinding(json, root, clips);
    applySettings(b, json);
    bindings.push(b);
    if (typeof json.id === "string" && json.id) byId.set(json.id, b);
  }
  return {
    /** 每帧推进：mixer 步进 + 图状态机评估过渡 */
    update(dt) {
      if (dt <= 0) return;
      for (const b of bindings) {
        if (b.playing) b.mixer.update(dt);
        evalGraph(b);
      }
    },
    /** 节点绑定句柄（SDK 骨骼动画门面用；模型网格节点才有，未命中 null） */
    bindingOf(nodeId) {
      return byId.get(nodeId) ?? null;
    },
    /** 模型内嵌剪辑名列表（未命中返回 null） */
    clipsOf(nodeId) {
      const b = byId.get(nodeId);
      return b ? b.clips.map((c) => c.name || "clip") : null;
    },
    /** 按节点 anim/animGraph 设置重新应用（脚本改设置后刷新；含图/单剪辑切换） */
    reapply(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      applySettings(b, b.nodeJson ?? {});
      return true;
    },
    /** 合并单剪辑播放设置（clip/autoplay/speed/loop 任意子集；图存在时图优先） */
    applyAnim(nodeId, settings) {
      const b = byId.get(nodeId);
      if (!b) return false;
      const cur = parseClipSettings(b.nodeJson?.anim);
      const s = settings && typeof settings === "object" ? settings : {};
      if (typeof s.clip === "string") cur.clip = s.clip;
      if (typeof s.autoplay === "boolean") cur.autoplay = s.autoplay;
      if (typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed >= 0) {
        cur.speed = s.speed;
      }
      if (LOOP_MODES.includes(s.loop)) cur.loop = s.loop;
      b.nodeJson.anim = { ...cur };
      applySettings(b, b.nodeJson);
      return true;
    },
    /** 创建/替换动画图（def 为 AnimGraph 形状，非法部分按 parseAnimGraph 收敛剔除） */
    applyGraph(nodeId, def) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.nodeJson.animGraph = def && typeof def === "object" ? def : null;
      applySettings(b, b.nodeJson);
      return true;
    },
    /** 移除动画图（回单剪辑语义） */
    removeGraph(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.nodeJson.animGraph = null;
      applySettings(b, b.nodeJson);
      return true;
    },
    /** 当前动作速度（写 nodeJson.anim.speed + 活动动作 timeScale） */
    setSpeed(nodeId, v) {
      const b = byId.get(nodeId);
      if (!b) return false;
      const cur = parseClipSettings(b.nodeJson?.anim);
      const s = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : cur.speed;
      b.nodeJson.anim = { ...cur, speed: s };
      const action = b.currentClip ? b.actions.get(b.currentClip) : null;
      if (action) action.timeScale = s;
      return true;
    },
    /** 当前动作循环模式（"loop"/"once"/"pingpong"） */
    setLoop(nodeId, mode) {
      const b = byId.get(nodeId);
      if (!b || !LOOP_MODES.includes(mode)) return false;
      b.nodeJson.anim = { ...parseClipSettings(b.nodeJson?.anim), loop: mode };
      const action = b.currentClip ? b.actions.get(b.currentClip) : null;
      if (action) applyClipParams(action, b.nodeJson.anim);
      return true;
    },
    /** 自动播放标记（影响 reapply/applyAnim 的重放路径） */
    setAutoplay(nodeId, v) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.nodeJson.anim = { ...parseClipSettings(b.nodeJson?.anim), autoplay: v === true };
      return true;
    },
    /** 图参数写入（活动图 params；布尔/数值收敛，条件评估每帧读取） */
    setParam(nodeId, name, value) {
      const b = byId.get(nodeId);
      if (!b || !b.graph) return false;
      if (typeof name !== "string" || !name) return false;
      if (typeof value === "boolean") {
        b.graph.params[name] = value;
        return true;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        b.graph.params[name] = value;
        return true;
      }
      return false;
    },
    /**
     * 播放（单剪辑模式 clip 缺省/未命中取首个剪辑；动画图模式 clip 作为目标
     * 状态名，缺省回入口状态）。命中返回 true。
     */
    play(nodeId, clip) {
      const b = byId.get(nodeId);
      if (!b) return false;
      if (b.graph) {
        const stateName =
          typeof clip === "string" && b.graph.states.some((s) => s.name === clip)
            ? clip
            : b.graph.entry;
        enterGraphState(b, stateName, 0.25);
        return true;
      }
      const name = resolveClipName(b, typeof clip === "string" ? clip : "");
      if (!name) return false;
      playClipAction(b, name, parseClipSettings(b.nodeJson?.anim), 0.25);
      return true;
    },
    /** 停止并清空动作（回到初始姿势） */
    stop(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.mixer.stopAllAction();
      b.currentClip = null;
      b.playing = false;
      if (b.graph) b.graphState = null;
      return true;
    },
    /** 暂停（保留进度；图状态机暂停评估） */
    pause(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.playing = false;
      return true;
    },
    /** 继续播放；无当前剪辑时按节点动画设置重新起播 */
    resume(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      if (b.currentClip) {
        b.playing = true;
        return true;
      }
      applySettings(b, b.nodeJson ?? {});
      return b.playing;
    },
  };
}
