// 模型动画播放：移植编辑器 AnimationSystem 的“节点数据 → 运行时”语义
// （单剪辑 MeshNode.anim 直控 / 动画图 MeshNode.animGraph 状态机：
// exitTime + 参数条件 → 交叉淡化过渡）。预览只回放，不含编辑器侧的
// 骨骼辅助线与 IK 可视化 helper。
//
// 蒙皮完全控制（对应 three 官网 animation/skinning 系列示例）：
// - 动作级（blending/morph）：setWeight/getWeight、fadeIn/fadeOut、crossFade（支持
//   warp 同步）、setActionSpeed/setActionLoop、playOneShot（LoopOnce+clamp 定格，
//   mixer finished 事件自动回落基础动作）、stopAction、globalSpeed（mixer 速度）、
//   onFinished/onLoop 事件订阅；
// - 加法层（additive_blending）：playAdditive/stopAdditive——惰性
//   AnimationUtils.makeClipAdditive 转换缓存后以 Additive 混合模式叠加播放；
// - 骨骼级：bonesOf/boneHierarchy 枚举、getBoneTransform/setBonePosition/
//   setBoneRotation(度)/setBoneScale 本地变换读写、resetBone/resetPose（绑定时
//   姿势快照恢复）、getBoneWorldPosition 世界坐标查询；
// - 形态键（morph）：morphsOf/setMorphWeight/getMorphWeight（morphTargetInfluences）；
// - IK（skinning_ik）：addIK/removeIK/setIKEnabled/setIKTargetPosition——CCD 求解
//   （vendor CCDIKSolver），目标以追加 Bone 的方式进入骨架（求解器从
//   skeleton.bones 取 target/effector，与官方示例一致）；每帧在 mixer 之后求解，
//   并对蒙皮网格重算包围球（官方防视锥误剔除做法）。
// 除 nodeJson.anim/animGraph（同旧语义）外全部为运行时控制，不写入场景数据。
import * as THREE from "../core/three.module.min.js";
import { CCDIKSolver } from "./loaders/CCDIKSolver.js";
import { postLog } from "../core/log";

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

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 有限数值收敛（非法回退 fallback） */
const fin = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);

/** 单个模型节点的动画绑定（mixer + 剪辑动作表 + 图运行态 + 蒙皮通道） */
function createBinding(nodeJson, root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map();
  for (const clip of clips) {
    const name = clip.name || "clip";
    if (!actions.has(name)) {
      const action = mixer.clipAction(clip);
      // 权重默认清零：混合面板以 0 为“未参与”，播放路径显式回到 1
      action.setEffectiveWeight(0);
      actions.set(name, action);
    }
  }
  // —— 蒙皮通道：骨骼 / 形态键（实例重绑时重建，快照即当时的加载姿势）——
  const skinnedMeshes = [];
  root.traverse((o) => {
    if (o.isSkinnedMesh) skinnedMeshes.push(o);
  });
  const skeleton = skinnedMeshes[0]?.skeleton ?? null;
  const bones = [];
  const boneNames = [];
  const boneByName = new Map();
  const boneNameOf = new Map();
  const restPose = new Map();
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
  const morphTable = [];
  root.traverse((o) => {
    // 形态键常见于骨骼挂接的表情网格（不一定是 SkinnedMesh），扫全部网格
    if (o.morphTargetDictionary && o.morphTargetInfluences) {
      morphTable.push({
        mesh: o,
        name: o.name || `mesh${morphTable.length}`,
        dictionary: o.morphTargetDictionary,
      });
    }
  });
  const b = {
    nodeJson,
    root,
    mixer,
    actions,
    clips,
    /** 加法层动作（clip 名 → action）与其 makeClipAdditive 转换缓存 */
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
    /** IK 求解记录（addIK 追加；target Bone 追加进 skeleton.bones 供求解器索引） */
    iks: [],
    ikSeq: 0,
    /** 骨骼/IK 目标绑定（attachObject 追加；每帧在 mixer+IK 之后跟随） */
    attachments: [],
    /** 进行中的一次性动作（finished 事件回落 base） */
    oneShot: null,
    finishedCbs: new Set(),
    loopCbs: new Set(),
    currentClip: null,
    playing: false,
    graph: null,
    graphState: null,
  };
  mixer.addEventListener("finished", (e) => {
    restoreOneShot(b, e.action);
    dispatchAnimEvent(b.finishedCbs, e.action);
  });
  mixer.addEventListener("loop", (e) => dispatchAnimEvent(b.loopCbs, e.action));
  return b;
}

/** mixer 事件分发（clip 名负载；回调异常不阻断动画推进） */
function dispatchAnimEvent(cbs, action) {
  if (!cbs.size) return;
  const payload = { clip: action.getClip()?.name ?? "" };
  for (const cb of [...cbs]) {
    try {
      cb(payload);
    } catch (err) {
      console.error("[animation] 动画事件回调异常:", err);
    }
  }
}

/** 一次性动作播完（finished）：淡出自身并淡回基础动作（官方 morph 示例模式） */
function restoreOneShot(b, action) {
  const os = b.oneShot;
  if (!os || os.action !== action) return;
  b.oneShot = null;
  action.fadeOut(os.fade);
  if (os.base && os.base !== action) os.base.fadeIn(os.fade);
}

/** 动作查找：同名剪辑的加法层优先（权重/淡入淡出/单动作控制指向已创建的层） */
function findAction(b, clip) {
  if (typeof clip !== "string" || !clip) return null;
  return b.additiveActions.get(clip) ?? b.actions.get(clip) ?? null;
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
  target.setEffectiveWeight(1);
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

/** 惰性取加法层动作：makeClipAdditive 转换缓存后按 Additive 混合模式创建 */
function additiveActionOf(b, clip) {
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

/** 每帧 IK 求解（mixer 之后调用；求解过的绑定重算蒙皮包围球防误剔除） */
function updateIK(b) {
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
function resolveBone(b, name) {
  if (typeof name !== "string" || !name) return null;
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
function attachmentTargetAllowed(b, obj) {
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
function updateAttachments(b) {
  if (!b.attachments.length) return;
  for (const at of b.attachments) {
    const parent = at.obj.parent;
    if (!parent) continue;
    at.bone.updateWorldMatrix(true, false);
    _attM1.multiplyMatrices(at.bone.matrixWorld, at.offset);
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

/** IK 配置收敛：骨骼名 → skeleton 索引；限位度制 → 弧度（官方 links 语义） */
function buildIKConfig(b, def, targetIndex, effectorIndex) {
  const links = [];
  for (const l of Array.isArray(def.links) ? def.links : []) {
    if (!l || typeof l !== "object") continue;
    const bone = typeof l.bone === "string" ? b.boneByName.get(l.bone) : null;
    if (!bone) continue;
    const link = { index: b.bones.indexOf(bone), enabled: l.enabled !== false };
    const limit = (v) => {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(x))) return null;
      return new THREE.Vector3(v[0], v[1], v[2]).multiplyScalar(Math.PI / 180);
    };
    const rmin = limit(l.rotationMin);
    if (rmin) link.rotationMin = rmin;
    const rmax = limit(l.rotationMax);
    if (rmax) link.rotationMax = rmax;
    links.push(link);
  }
  const iteration = def.iteration === undefined ? 1 : Math.max(1, Math.floor(fin(def.iteration, 1)));
  return { target: targetIndex, effector: effectorIndex, links, iteration };
}

/**
 * 为场景里的模型网格建立动画绑定：
 * meshes 为 buildSceneTree 收集的 meshNode 列表，模型实例挂在其 __modelRoot 子级
 * （与编辑器 SceneSynchronizer 同名约定）。返回 { update(dt) } 供渲染循环驱动，
 * 另附蒙皮控制 API（播放控制/动作混合/加法层/骨骼/形态键/IK，按节点 id 寻址，
 * 供脚本宿主 engine 转发）。
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
    /** 每帧推进：mixer 步进 → IK 求解 → 骨骼绑定跟随 → 图状态机评估过渡 */
    update(dt) {
      if (dt <= 0) return;
      for (const b of bindings) {
        if (b.playing) b.mixer.update(dt);
        updateIK(b);
        updateAttachments(b);
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
    /** 蒙皮能力摘要（骨骼数/形态键网格数；面板与脚本判断用，未绑定 null） */
    skinInfoOf(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return null;
      return {
        boneCount: b.bones.length,
        boneNames: [...b.boneNames],
        morphMeshes: b.morphTable.length,
      };
    },

    // —— 动作级控制（官方 blending/morph 模式）——

    /** 动作权重（setEffectiveWeight；确保动作在播，权重 0 即静默层） */
    setWeight(nodeId, clip, w) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a) return false;
      a.enabled = true;
      a.setEffectiveWeight(clamp01(fin(w, 0)));
      if (!a.isRunning()) a.play();
      b.playing = true;
      return true;
    },
    /** 动作当前有效权重（含淡入淡出进行中的值） */
    getWeight(nodeId, clip) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      return a ? a.getEffectiveWeight() : null;
    },
    /** 权重 0→1 淡入（官方 fadeToAction 的进入侧） */
    fadeIn(nodeId, clip, dur) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a) return false;
      a.enabled = true;
      if (!a.isRunning()) a.play();
      a.fadeIn(Math.max(0, fin(dur, 0.25)));
      b.playing = true;
      return true;
    },
    /** 权重→0 淡出（可淡到 None；动作本身不停止） */
    fadeOut(nodeId, clip, dur) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a) return false;
      a.fadeOut(Math.max(0, fin(dur, 0.25)));
      return true;
    },
    /** 交叉淡化 from→to（warp=true 时自动对齐相位；官方 setWeight 辅助模式） */
    crossFade(nodeId, from, to, dur, warp) {
      const b = byId.get(nodeId);
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
      return true;
    },
    /** 单动作播放速度（setEffectiveTimeScale；与 globalSpeed 相乘生效） */
    setActionSpeed(nodeId, clip, scale) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a) return false;
      a.setEffectiveTimeScale(Math.max(0, fin(scale, 1)));
      return true;
    },
    /** 单动作循环模式（"loop"/"once"/"pingpong"；once 定格末帧） */
    setActionLoop(nodeId, clip, mode) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a || !LOOP_MODES.includes(mode)) return false;
      const { loop, clamp } = threeLoopOf(mode);
      a.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
      a.clampWhenFinished = clamp;
      return true;
    },
    /** 停止单个动作（与 stopAll 区分：不影响其他混合层） */
    stopAction(nodeId, clip) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a) return false;
      if (b.oneShot?.action === a) b.oneShot = null;
      a.stop();
      if (b.currentClip === clip) b.currentClip = null;
      return true;
    },
    /**
     * 一次性动作（官方 morph 表情模式）：LoopOnce+clamp 定格末帧，当前动作淡出，
     * mixer finished 后自动淡出该动作并淡回基础动作。
     */
    playOneShot(nodeId, clip, fade) {
      const b = byId.get(nodeId);
      const a = b && findAction(b, clip);
      if (!a) return false;
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
      return true;
    },
    /** 全局播放速度（mixer.timeScale；与单动作速度相乘） */
    globalSpeed(nodeId, scale) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.mixer.timeScale = Math.max(0, fin(scale, 1));
      return true;
    },
    /** 订阅动作播完事件（LoopOnce 到达末帧；负载 {clip}），返回注销函数 */
    onFinished(nodeId, cb) {
      const b = byId.get(nodeId);
      if (!b || typeof cb !== "function") return () => {};
      b.finishedCbs.add(cb);
      return () => b.finishedCbs.delete(cb);
    },
    /** 订阅动作循环事件（LoopRepeat 每圈 / PingPong 半圈；负载 {clip}） */
    onLoop(nodeId, cb) {
      const b = byId.get(nodeId);
      if (!b || typeof cb !== "function") return () => {};
      b.loopCbs.add(cb);
      return () => b.loopCbs.delete(cb);
    },

    // —— 加法层（官方 additive_blending 模式）——

    /** 以加法混合叠加播放剪辑（权重独立于基础层；未转换剪辑惰性 makeClipAdditive） */
    playAdditive(nodeId, clip, weight) {
      const b = byId.get(nodeId);
      if (!b) return false;
      const a = additiveActionOf(b, typeof clip === "string" ? clip : "");
      if (!a) return false;
      a.reset().play();
      a.setEffectiveWeight(clamp01(fin(weight, 1)));
      b.playing = true;
      return true;
    },
    /** 停止加法层动作（转换缓存保留，重复播放不再重转换） */
    stopAdditive(nodeId, clip) {
      const b = byId.get(nodeId);
      const a = b && typeof clip === "string" ? b.additiveActions.get(clip) : null;
      if (!a) return false;
      a.stop();
      return true;
    },

    // —— 骨骼级控制 ——

    /** 骨骼名列表（骨架扁平顺序；未绑定/无骨骼返回 null/[]） */
    bonesOf(nodeId) {
      const b = byId.get(nodeId);
      return b ? [...b.boneNames] : null;
    },
    /** 骨骼层级（[{name,parent,children}]；parent 为骨骼名或 null） */
    boneHierarchy(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return null;
      return b.bones.map((bone) => {
        const parent = bone.parent?.isBone ? (b.boneNameOf.get(bone.parent) ?? null) : null;
        const children = [];
        for (const child of bone.children) {
          if (child.isBone) children.push(b.boneNameOf.get(child) ?? null);
        }
        return { name: b.boneNameOf.get(bone) ?? "", parent, children: children.filter(Boolean) };
      });
    },
    /** 骨骼本地变换快照（rotation 为度制欧拉；未命中 null） */
    getBoneTransform(nodeId, name) {
      const b = byId.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (!bone) return null;
      const deg = THREE.MathUtils.radToDeg;
      const v3 = (v) => ({ x: v.x, y: v.y, z: v.z });
      return {
        position: v3(bone.position),
        rotation: { x: deg(bone.rotation.x), y: deg(bone.rotation.y), z: deg(bone.rotation.z) },
        scale: v3(bone.scale),
      };
    },
    /** 骨骼本地位移（注意：动作播放中 mixer 每帧覆写被驱动骨骼） */
    setBonePosition(nodeId, name, x, y, z) {
      const b = byId.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (!bone) return false;
      bone.position.set(fin(x, 0), fin(y, 0), fin(z, 0));
      return true;
    },
    /** 骨骼本地旋转（度制欧拉，与节点 transform 同度制） */
    setBoneRotation(nodeId, name, x, y, z) {
      const b = byId.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (!bone) return false;
      const rad = THREE.MathUtils.degToRad;
      bone.rotation.set(rad(fin(x, 0)), rad(fin(y, 0)), rad(fin(z, 0)));
      return true;
    },
    /** 骨骼本地缩放 */
    setBoneScale(nodeId, name, x, y, z) {
      const b = byId.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (!bone) return false;
      bone.scale.set(fin(x, 1), fin(y, 1), fin(z, 1));
      return true;
    },
    /** 复位单个骨骼到绑定姿势 */
    resetBone(nodeId, name) {
      const b = byId.get(nodeId);
      const bone = b?.boneByName.get(name);
      const snap = bone && b.restPose.get(bone);
      if (!bone || !snap) return false;
      bone.position.copy(snap.position);
      bone.quaternion.copy(snap.quaternion);
      bone.scale.copy(snap.scale);
      return true;
    },
    /** 复位全部骨骼到绑定姿势（快照恢复，等价加载时姿势） */
    resetPose(nodeId) {
      const b = byId.get(nodeId);
      if (!b || !b.restPose.size) return false;
      for (const [bone, snap] of b.restPose) {
        bone.position.copy(snap.position);
        bone.quaternion.copy(snap.quaternion);
        bone.scale.copy(snap.scale);
      }
      return true;
    },
    /** 骨骼世界坐标（attach 物体/瞄准参考；未命中 null。名字可传 IK id/IK 名） */
    getBoneWorldPosition(nodeId, name) {
      const b = byId.get(nodeId);
      const bone = b && resolveBone(b, name);
      if (!b || !bone) return null;
      bone.updateWorldMatrix(true, false);
      const p = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
      return { x: p.x, y: p.y, z: p.z };
    },

    // —— 骨骼/IK 目标绑定（物体跟随骨骼；官方 ik 示例挂点语义）——

    /**
     * 把场景对象绑到骨骼/IK 目标上每帧跟随（targetObj 须在模型子树之外）。
     * opts = { keepOffset?: boolean（缺省 true：保持 attach 时刻的相对位姿）,
     *          syncRotation?: boolean（缺省 true）, syncScale?: boolean（缺省 false） }。
     * bone 传骨骼名、IK id 或 IK name。成功返回 true。
     */
    attachObject(nodeId, targetObj, bone, opts) {
      const b = byId.get(nodeId);
      if (!b || !targetObj || !targetObj.isObject3D) return false;
      const boneObj = resolveBone(b, bone);
      if (!boneObj || !attachmentTargetAllowed(b, targetObj)) return false;
      const o = opts && typeof opts === "object" ? opts : {};
      const at = {
        obj: targetObj,
        bone: boneObj,
        boneName: bone,
        syncRotation: o.syncRotation !== false,
        syncScale: o.syncScale === true,
        keepOffset: o.keepOffset !== false,
        offset: new THREE.Matrix4(),
      };
      if (at.keepOffset) {
        // attach 时刻的相对位姿：boneWorld⁻¹ × objWorld（骨骼带动下保持刚性相对关系）
        boneObj.updateWorldMatrix(true, false);
        targetObj.updateWorldMatrix(true, false);
        at.offset.copy(boneObj.matrixWorld).invert().multiply(targetObj.matrixWorld);
      }
      // 同一目标重复 attach = 改绑（先解除旧绑定）
      const prev = b.attachments.findIndex((at) => at.obj === targetObj);
      if (prev >= 0) b.attachments.splice(prev, 1);
      b.attachments.push(at);
      return true;
    },
    /** 解除对象绑定（未绑定返回 false） */
    detachObject(nodeId, targetObj) {
      const b = byId.get(nodeId);
      if (!b) return false;
      const i = b.attachments.findIndex((at) => at.obj === targetObj);
      if (i < 0) return false;
      b.attachments.splice(i, 1);
      return true;
    },
    /** 绑定清单（[{node, bone, syncRotation, syncScale, keepOffset}]） */
    attachmentsOf(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return null;
      return b.attachments.map((at) => ({
        node: at.obj.userData?.nodeId ?? at.obj.name ?? "",
        bone: at.boneName,
        syncRotation: at.syncRotation,
        syncScale: at.syncScale,
        keepOffset: at.keepOffset,
      }));
    },

    // —— 形态键（官方 morph 表情滑块语义）——

    /** 形态键清单（[{mesh, targets}]；未绑定 null） */
    morphsOf(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return null;
      return b.morphTable.map((m) => ({ mesh: m.name, targets: Object.keys(m.dictionary) }));
    },
    /** 形态键权重写入（0..1；mesh 空则取首个含该目标的网格） */
    setMorphWeight(nodeId, mesh, target, v) {
      const b = byId.get(nodeId);
      if (!b || typeof target !== "string" || !target) return false;
      const entry =
        (mesh ? b.morphTable.find((m) => m.name === mesh) : null) ??
        b.morphTable.find((m) => target in m.dictionary);
      if (!entry || !(target in entry.dictionary)) return false;
      entry.mesh.morphTargetInfluences[entry.dictionary[target]] = clamp01(fin(v, 0));
      return true;
    },
    /** 形态键权重读取（未命中 null） */
    getMorphWeight(nodeId, mesh, target) {
      const b = byId.get(nodeId);
      if (!b || typeof target !== "string" || !target) return null;
      const entry =
        (mesh ? b.morphTable.find((m) => m.name === mesh) : null) ??
        b.morphTable.find((m) => target in m.dictionary);
      if (!entry || !(target in entry.dictionary)) return null;
      return entry.mesh.morphTargetInfluences[entry.dictionary[target]] ?? null;
    },

    // —— IK（官方 skinning_ik，CCD 求解）——

    /**
     * 注册 IK 链：def = { name?, effector: 骨骼名, links: [{bone, rotationMin?,
     * rotationMax?}], iteration? }（限位为度制欧拉数组）。目标点由引擎创建并作为
     * Bone 追加进骨架（求解器从 skeleton.bones 取 target/effector），挂模型根下
     * （局部空间）。成功返回 IK id（"ik1"…），失败返回 false。
     */
    addIK(nodeId, def) {
      const b = byId.get(nodeId);
      if (!b || !b.skeleton || !def || typeof def !== "object") return false;
      const effectorName = typeof def.effector === "string" ? def.effector : "";
      const effector = effectorName ? b.boneByName.get(effectorName) : null;
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
      const config = buildIKConfig(
        b,
        def,
        b.skeleton.bones.length - 1,
        b.bones.indexOf(effector),
      );
      const solver = new CCDIKSolver(mesh, [config]);
      const rec = {
        id,
        name: typeof def.name === "string" && def.name ? def.name : id,
        solver,
        targetBone,
        effector: effectorName,
        enabled: true,
      };
      b.iks.push(rec);
      return id;
    },
    /** 移除 IK（solver 不再更新；目标 Bone 保留在骨架中维持索引稳定） */
    removeIK(nodeId, id) {
      const b = byId.get(nodeId);
      if (!b) return false;
      const i = b.iks.findIndex((r) => r.id === id);
      if (i < 0) return false;
      b.iks.splice(i, 1);
      return true;
    },
    /** IK 启停（官方示例 GUI checkbox 语义） */
    setIKEnabled(nodeId, id, v) {
      const b = byId.get(nodeId);
      const rec = b && b.iks.find((r) => r.id === id);
      if (!rec) return false;
      rec.enabled = v === true;
      return true;
    },
    /** 目标点位置（模型根局部空间） */
    setIKTargetPosition(nodeId, id, x, y, z) {
      const b = byId.get(nodeId);
      const rec = b && b.iks.find((r) => r.id === id);
      if (!rec) return false;
      rec.targetBone.position.set(fin(x, 0), fin(y, 0), fin(z, 0));
      return true;
    },
    getIKTargetPosition(nodeId, id) {
      const b = byId.get(nodeId);
      const rec = b && b.iks.find((r) => r.id === id);
      if (!rec) return null;
      const p = rec.targetBone.position;
      return { x: p.x, y: p.y, z: p.z };
    },
    /** IK 清单（[{id,name,effector,enabled}]） */
    iksOf(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return null;
      return b.iks.map((r) => ({ id: r.id, name: r.name, effector: r.effector, enabled: r.enabled }));
    },

    // —— 旧有语义：设置重应用 / 单剪辑 / 图 / 播放控制 ——

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
    /** 停止并清空动作（含加法层/一次性动作；回到初始姿势） */
    stop(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.mixer.stopAllAction();
      b.currentClip = null;
      b.playing = false;
      b.oneShot = null;
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
// ---------------------------------------------------------------------------
// Worker 模式：骨骼动画 + IK 在独立线程运行（与物理 Worker 同一设计模式）。
// 主线程维护轻量绑定（真实骨骼 + 附件 + 形态键），每帧应用 Worker 回写的
// 骨骼变换；命令转发到 Worker，同步 API 从镜像状态读取（一帧延迟可接受）。
// ---------------------------------------------------------------------------

/** 序列化单个 AnimationClip 为纯数据（track 的 TypedArray 可结构化克隆） */
function serializeClip(clip) {
  return {
    name: clip.name,
    duration: clip.duration,
    tracks: clip.tracks.map((t) => ({
      name: t.name,
      times: t.times.slice(),
      values: t.values.slice(),
      interpolation: t.interpolation,
      valueSize: t.valueSize,
    })),
    blendMode: clip.blendMode,
  };
}

/** 序列化模型节点场景树（骨骼层级 + 形态键字典）供 Worker 重建代理 */
function serializeMeshEntry(entry) {
  const root = entry.obj.getObjectByName("__modelRoot");
  if (!root) return null;
  const skinnedMeshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinnedMeshes.push(o); });
  const skeleton = skinnedMeshes[0]?.skeleton ?? null;
  const bones = [];
  if (skeleton) {
    const boneIndexMap = new Map();
    for (let i = 0; i < skeleton.bones.length; i++) boneIndexMap.set(skeleton.bones[i], i);
    for (const bone of skeleton.bones) {
      const parentBone = bone.parent?.isBone ? bone.parent : null;
      const parentIndex = parentBone && boneIndexMap.has(parentBone) ? boneIndexMap.get(parentBone) : -1;
      bones.push({
        name: bone.name || `bone${bones.length}`,
        parentIndex,
        position: [bone.position.x, bone.position.y, bone.position.z],
        quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
        scale: [bone.scale.x, bone.scale.y, bone.scale.z],
      });
    }
  }
  const morphMeshes = [];
  root.traverse((o) => {
    if (o.morphTargetDictionary && o.morphTargetInfluences) {
      morphMeshes.push({
        name: o.name || `mesh${morphMeshes.length}`,
        dictionary: { ...o.morphTargetDictionary },
        influenceCount: o.morphTargetInfluences.length,
      });
    }
  });
  return { json: entry.json, modelRoot: { bones, morphMeshes } };
}

/** 轻量绑定结构（无 mixer/actions：仅骨骼/形态键/IK 目标/附件管理） */
function createBindingStructure(nodeJson, root) {
  const skinnedMeshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinnedMeshes.push(o); });
  const skeleton = skinnedMeshes[0]?.skeleton ?? null;
  const bones = [];
  const boneNames = [];
  const boneByName = new Map();
  const boneNameOf = new Map();
  const restPose = new Map();
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
  const morphTable = [];
  root.traverse((o) => {
    if (o.morphTargetDictionary && o.morphTargetInfluences) {
      morphTable.push({
        mesh: o,
        name: o.name || `mesh${morphTable.length}`,
        dictionary: o.morphTargetDictionary,
      });
    }
  });
  return {
    nodeJson, root,
    skinnedMeshes, skeleton,
    bones, boneNames, boneByName, boneNameOf, restPose, morphTable,
    iks: [], ikSeq: 0, attachments: [],
    finishedCbs: new Set(), loopCbs: new Set(),
  };
}

/**
 * 创建骨骼动画 Worker 代理（与 createAnimations 同接口）。
 * 在多文件导出模式下使用 Worker 线程；单页模式或 Worker 失败回退到 createAnimations。
 * @param meshes buildSceneTree 收集的 meshNode 列表
 * @param models 模型 Map（name → { clips }）
 * @param workerUrl Worker 脚本 URL（缺省/null → 回退主线程）
 * @returns {Promise<AnimationsApi>} 与 createAnimations 同接口的动画 API
 */
export async function createAnimationsWorker(meshes, models, workerUrl) {
  if (!workerUrl) return createAnimations(meshes, models);

  // 筛选模型节点 + 序列化场景数据
  const modelEntries = [];
  for (const entry of meshes) {
    const json = entry.json;
    if (json.source !== "model" || typeof json.model !== "string" || !json.model) continue;
    const root = entry.obj.getObjectByName("__modelRoot");
    if (!root) continue;
    const clips = models.get(json.model)?.clips;
    if (!clips) continue;
    modelEntries.push(entry);
  }
  if (!modelEntries.length) return createAnimations(meshes, models);

  const serializedMeshes = modelEntries.map(serializeMeshEntry).filter(Boolean);
  const serializedModels = [];
  const seenModels = new Set();
  for (const entry of modelEntries) {
    const name = entry.json.model;
    if (seenModels.has(name)) continue;
    seenModels.add(name);
    const model = models.get(name);
    if (model?.clips) {
      serializedModels.push({ name, clips: model.clips.map(serializeClip) });
    }
  }

  // 创建 Worker + 发送 init
  let worker;
  try {
    worker = new Worker(workerUrl, { type: "module" });
    worker.postMessage({
      type: "init",
      meshEntries: serializedMeshes,
      modelMap: serializedModels,
    });
  } catch {
    return createAnimations(meshes, models);
  }

  // 等待 Worker ready
  const ready = await new Promise((resolve) => {
    worker.onmessage = (e) => {
      if (e.data.type === "ready") resolve(e.data);
      else if (e.data.type === "error") resolve(null);
    };
    worker.onerror = () => resolve(null);
  });
  if (!ready) {
    worker.terminate();
    return createAnimations(meshes, models);
  }

  // 主线程轻量绑定（真实骨骼，供变换回写 + 附件 + 形态键 + 同步读取）
  const mainBindings = new Map();
  const bindingLayouts = ready.bindingLayouts || [];
  for (const layout of bindingLayouts) {
    const entry = modelEntries.find((e) => e.json.id === layout.nodeId);
    if (!entry) continue;
    const root = entry.obj.getObjectByName("__modelRoot");
    if (!root) continue;
    const b = createBindingStructure(entry.json, root);
    mainBindings.set(layout.nodeId, b);
  }

  // 双缓冲：pending = Worker 上一帧返回的骨骼变换 + 形态键 + 状态
  let pending = null;
  let workerBusy = false;
  let mirrorState = new Map(); // nodeId → { weights, iks, ikTargets }

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "stepped") {
      pending = msg;
      workerBusy = false;
    }
  };

  // 命令转发辅助
  const send = (method, ...args) => {
    try { worker.postMessage({ type: "command", method, args }); } catch { /* Worker 已终止 */ }
  };

  postLog("info", "[动画] Worker 模式已启动（骨骼动画 + IK 在独立线程）");

  return {
    /** 每帧：应用 Worker 回写的骨骼变换 → 附件跟随 → 事件分发 → 发 dt 给 Worker */
    update(dt) {
      if (dt <= 0) return;
      // 1) 应用上一帧 Worker 返回的变换
      if (pending) {
        const { transforms, morphs, state, events } = pending;
        // 骨骼变换
        let tOff = 0;
        for (const layout of bindingLayouts) {
          const b = mainBindings.get(layout.nodeId);
          if (!b) { tOff += layout.boneCount * 7; continue; }
          for (let i = 0; i < layout.boneCount; i++) {
            const bone = b.bones[i];
            if (!bone) { tOff += 7; continue; }
            bone.position.set(transforms[tOff], transforms[tOff + 1], transforms[tOff + 2]);
            bone.quaternion.set(transforms[tOff + 3], transforms[tOff + 4], transforms[tOff + 5], transforms[tOff + 6]);
            tOff += 7;
          }
        }
        // 形态键权重
        let mOff = 0;
        for (const layout of bindingLayouts) {
          const b = mainBindings.get(layout.nodeId);
          if (!b) {
            for (const mm of layout.morphMeshes || []) mOff += mm.influenceCount;
            continue;
          }
          for (const mm of layout.morphMeshes || []) {
            const entry = b.morphTable.find((m) => m.name === mm.name);
            if (entry?.mesh?.morphTargetInfluences) {
              const inf = entry.mesh.morphTargetInfluences;
              for (let i = 0; i < mm.influenceCount; i++) inf[i] = morphs[mOff + i];
            }
            mOff += mm.influenceCount;
          }
        }
        // 状态镜像（供同步 API 读取）
        if (state) {
          for (const [nodeId, s] of Object.entries(state)) {
            mirrorState.set(nodeId, s);
            // 同步 IK 目标骨骼位置（供 getBoneWorldPosition）
            const b = mainBindings.get(nodeId);
            if (b && s.ikTargets) {
              for (const r of b.iks) {
                const pos = s.ikTargets[r.id];
                if (pos) r.targetBone.position.set(pos.x, pos.y, pos.z);
              }
            }
          }
        }
        // 事件分发
        if (events?.length) {
          for (const ev of events) {
            const b = mainBindings.get(ev.nodeId);
            if (!b) continue;
            const cbs = ev.type === "finished" ? b.finishedCbs : b.loopCbs;
            for (const cb of [...cbs]) {
              try { cb({ clip: ev.clip }); } catch (err) { console.error("[animation] 事件回调异常:", err); }
            }
          }
        }
        pending = null;
      }
      // 2) 附件跟随 + IK 后包围球重算（主线程，需真实对象）
      for (const [, b] of mainBindings) {
        updateAttachments(b);
        // IK 在 Worker 侧运行；有启用 IK 时重算蒙皮包围球防视锥误剔除
        const ms = mirrorState.get(b.nodeId ?? "");
        if (ms?.iks?.some((ik) => ik.enabled)) {
          for (const mesh of b.skinnedMeshes) mesh.computeBoundingSphere();
        }
      }
      // 3) 发 dt 给 Worker（非忙时）
      if (!workerBusy) {
        try {
          worker.postMessage({ type: "step", dt });
          workerBusy = true;
        } catch { /* Worker 已终止 */ }
      }
    },

    bindingOf(nodeId) { return mainBindings.get(nodeId) ?? null; },
    clipsOf(nodeId) {
      const b = mainBindings.get(nodeId);
      if (!b) return null;
      const entry = modelEntries.find((e) => e.json.id === nodeId);
      if (!entry) return null;
      const clips = models.get(entry.json.model)?.clips;
      return clips ? clips.map((c) => c.name || "clip") : null;
    },
    skinInfoOf(nodeId) {
      const b = mainBindings.get(nodeId);
      if (!b) return null;
      return { boneCount: b.bones.length, boneNames: [...b.boneNames], morphMeshes: b.morphTable.length };
    },

    // —— 动作级控制（转发 Worker）——
    setWeight(nodeId, clip, w) { send("setWeight", nodeId, clip, w); return true; },
    getWeight(nodeId, clip) {
      const s = mirrorState.get(nodeId);
      return s?.weights?.[clip] ?? null;
    },
    fadeIn(nodeId, clip, dur) { send("fadeIn", nodeId, clip, dur); return true; },
    fadeOut(nodeId, clip, dur) { send("fadeOut", nodeId, clip, dur); return true; },
    crossFade(nodeId, from, to, dur, warp) { send("crossFade", nodeId, from, to, dur, warp); return true; },
    setActionSpeed(nodeId, clip, scale) { send("setActionSpeed", nodeId, clip, scale); return true; },
    setActionLoop(nodeId, clip, mode) { send("setActionLoop", nodeId, clip, mode); return true; },
    stopAction(nodeId, clip) { send("stopAction", nodeId, clip); return true; },
    playOneShot(nodeId, clip, fade) { send("playOneShot", nodeId, clip, fade); return true; },
    globalSpeed(nodeId, scale) { send("globalSpeed", nodeId, scale); return true; },
    onFinished(nodeId, cb) {
      const b = mainBindings.get(nodeId);
      if (!b || typeof cb !== "function") return () => {};
      b.finishedCbs.add(cb);
      return () => b.finishedCbs.delete(cb);
    },
    onLoop(nodeId, cb) {
      const b = mainBindings.get(nodeId);
      if (!b || typeof cb !== "function") return () => {};
      b.loopCbs.add(cb);
      return () => b.loopCbs.delete(cb);
    },

    // —— 加法层（转发 Worker）——
    playAdditive(nodeId, clip, weight) { send("playAdditive", nodeId, clip, weight); return true; },
    stopAdditive(nodeId, clip) { send("stopAdditive", nodeId, clip); return true; },

    // —— 骨骼级控制 ——
    bonesOf(nodeId) {
      const b = mainBindings.get(nodeId);
      return b ? [...b.boneNames] : null;
    },
    boneHierarchy(nodeId) {
      const b = mainBindings.get(nodeId);
      if (!b) return null;
      return b.bones.map((bone) => {
        const parent = bone.parent?.isBone ? (b.boneNameOf.get(bone.parent) ?? null) : null;
        const children = [];
        for (const child of bone.children) {
          if (child.isBone) children.push(b.boneNameOf.get(child) ?? null);
        }
        return { name: b.boneNameOf.get(bone) ?? "", parent, children: children.filter(Boolean) };
      });
    },
    getBoneTransform(nodeId, name) {
      const b = mainBindings.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (!bone) return null;
      const deg = THREE.MathUtils.radToDeg;
      return {
        position: { x: bone.position.x, y: bone.position.y, z: bone.position.z },
        rotation: { x: deg(bone.rotation.x), y: deg(bone.rotation.y), z: deg(bone.rotation.z) },
        scale: { x: bone.scale.x, y: bone.scale.y, z: bone.scale.z },
      };
    },
    setBonePosition(nodeId, name, x, y, z) {
      send("setBonePosition", nodeId, name, x, y, z);
      const b = mainBindings.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (bone) bone.position.set(fin(x, 0), fin(y, 0), fin(z, 0));
      return true;
    },
    setBoneRotation(nodeId, name, x, y, z) {
      send("setBoneRotation", nodeId, name, x, y, z);
      const b = mainBindings.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (bone) {
        const rad = THREE.MathUtils.degToRad;
        bone.rotation.set(rad(fin(x, 0)), rad(fin(y, 0)), rad(fin(z, 0)));
      }
      return true;
    },
    setBoneScale(nodeId, name, x, y, z) {
      send("setBoneScale", nodeId, name, x, y, z);
      const b = mainBindings.get(nodeId);
      const bone = b?.boneByName.get(name);
      if (bone) bone.scale.set(fin(x, 1), fin(y, 1), fin(z, 1));
      return true;
    },
    resetBone(nodeId, name) {
      send("resetBone", nodeId, name);
      const b = mainBindings.get(nodeId);
      const bone = b?.boneByName.get(name);
      const snap = bone && b.restPose.get(bone);
      if (bone && snap) {
        bone.position.copy(snap.position);
        bone.quaternion.copy(snap.quaternion);
        bone.scale.copy(snap.scale);
      }
      return true;
    },
    resetPose(nodeId) {
      send("resetPose", nodeId);
      const b = mainBindings.get(nodeId);
      if (b) for (const [bone, snap] of b.restPose) {
        bone.position.copy(snap.position);
        bone.quaternion.copy(snap.quaternion);
        bone.scale.copy(snap.scale);
      }
      return true;
    },
    getBoneWorldPosition(nodeId, name) {
      const b = mainBindings.get(nodeId);
      if (!b) return null;
      const bone = resolveBone(b, name);
      if (!bone) return null;
      bone.updateWorldMatrix(true, false);
      return {
        x: bone.matrixWorld.elements[12],
        y: bone.matrixWorld.elements[13],
        z: bone.matrixWorld.elements[14],
      };
    },

    // —— 附件（主线程，需真实对象）——
    attachObject(nodeId, targetObj, bone, opts) {
      const b = mainBindings.get(nodeId);
      if (!b || !targetObj || !targetObj.isObject3D) return false;
      const boneObj = resolveBone(b, bone);
      if (!boneObj || !attachmentTargetAllowed(b, targetObj)) return false;
      const o = opts && typeof opts === "object" ? opts : {};
      const at = {
        obj: targetObj, bone: boneObj, boneName: bone,
        syncRotation: o.syncRotation !== false,
        syncScale: o.syncScale === true,
        keepOffset: o.keepOffset !== false,
        offset: new THREE.Matrix4(),
      };
      if (at.keepOffset) {
        boneObj.updateWorldMatrix(true, false);
        targetObj.updateWorldMatrix(true, false);
        at.offset.copy(boneObj.matrixWorld).invert().multiply(targetObj.matrixWorld);
      }
      const prev = b.attachments.findIndex((a) => a.obj === targetObj);
      if (prev >= 0) b.attachments.splice(prev, 1);
      b.attachments.push(at);
      return true;
    },
    detachObject(nodeId, targetObj) {
      const b = mainBindings.get(nodeId);
      if (!b) return false;
      const i = b.attachments.findIndex((a) => a.obj === targetObj);
      if (i < 0) return false;
      b.attachments.splice(i, 1);
      return true;
    },
    attachmentsOf(nodeId) {
      const b = mainBindings.get(nodeId);
      if (!b) return null;
      return b.attachments.map((at) => ({
        node: at.obj.userData?.nodeId ?? at.obj.name ?? "",
        bone: at.boneName,
        syncRotation: at.syncRotation,
        syncScale: at.syncScale,
        keepOffset: at.keepOffset,
      }));
    },

    // —— 形态键（主线程直接写真实网格 + 转发 Worker 保持代理同步）——
    morphsOf(nodeId) {
      const b = mainBindings.get(nodeId);
      if (!b) return null;
      return b.morphTable.map((m) => ({ mesh: m.name, targets: Object.keys(m.dictionary) }));
    },
    setMorphWeight(nodeId, mesh, target, v) {
      const b = mainBindings.get(nodeId);
      if (!b || typeof target !== "string" || !target) return false;
      const entry =
        (mesh ? b.morphTable.find((m) => m.name === mesh) : null) ??
        b.morphTable.find((m) => target in m.dictionary);
      if (!entry || !(target in entry.dictionary)) return false;
      entry.mesh.morphTargetInfluences[entry.dictionary[target]] = clamp01(fin(v, 0));
      send("setMorphWeight", nodeId, mesh, target, v);
      return true;
    },
    getMorphWeight(nodeId, mesh, target) {
      const b = mainBindings.get(nodeId);
      if (!b || typeof target !== "string" || !target) return null;
      const entry =
        (mesh ? b.morphTable.find((m) => m.name === mesh) : null) ??
        b.morphTable.find((m) => target in m.dictionary);
      if (!entry || !(target in entry.dictionary)) return null;
      return entry.mesh.morphTargetInfluences[entry.dictionary[target]] ?? null;
    },

    // —— IK（主线程建真实目标骨骼供 getBoneWorldPosition；求解在 Worker）——
    addIK(nodeId, def) {
      const b = mainBindings.get(nodeId);
      if (!b || !b.skeleton || !def || typeof def !== "object") return false;
      const effectorName = typeof def.effector === "string" ? def.effector : "";
      const effector = effectorName ? b.boneByName.get(effectorName) : null;
      if (!effector) return false;
      b.ikSeq += 1;
      const id = `ik${b.ikSeq}`;
      const targetBone = new THREE.Bone();
      targetBone.name = `__ikTarget_${id}`;
      b.root.add(targetBone);
      b.skeleton.bones.push(targetBone);
      b.skeleton.boneInverses.push(new THREE.Matrix4());
      b.iks.push({
        id,
        name: typeof def.name === "string" && def.name ? def.name : id,
        solver: null,
        targetBone,
        effector: effectorName,
        enabled: true,
      });
      send("addIK", nodeId, def);
      return id;
    },
    removeIK(nodeId, id) {
      send("removeIK", nodeId, id);
      const b = mainBindings.get(nodeId);
      if (b) {
        const i = b.iks.findIndex((r) => r.id === id);
        if (i >= 0) b.iks.splice(i, 1);
      }
      return true;
    },
    setIKEnabled(nodeId, id, v) {
      send("setIKEnabled", nodeId, id, v);
      const b = mainBindings.get(nodeId);
      const rec = b && b.iks.find((r) => r.id === id);
      if (rec) rec.enabled = v === true;
      return true;
    },
    setIKTargetPosition(nodeId, id, x, y, z) {
      send("setIKTargetPosition", nodeId, id, x, y, z);
      const b = mainBindings.get(nodeId);
      const rec = b && b.iks.find((r) => r.id === id);
      if (rec) rec.targetBone.position.set(fin(x, 0), fin(y, 0), fin(z, 0));
      return true;
    },
    getIKTargetPosition(nodeId, id) {
      const s = mirrorState.get(nodeId);
      return s?.ikTargets?.[id] ?? null;
    },
    iksOf(nodeId) {
      const s = mirrorState.get(nodeId);
      return s?.iks ?? null;
    },

    // —— 设置重应用 / 播放控制（转发 Worker）——
    reapply(nodeId) { send("reapply", nodeId); return true; },
    applyAnim(nodeId, settings) { send("applyAnim", nodeId, settings); return true; },
    applyGraph(nodeId, def) { send("applyGraph", nodeId, def); return true; },
    removeGraph(nodeId) { send("removeGraph", nodeId); return true; },
    setSpeed(nodeId, v) { send("setSpeed", nodeId, v); return true; },
    setLoop(nodeId, mode) { send("setLoop", nodeId, mode); return true; },
    setAutoplay(nodeId, v) { send("setAutoplay", nodeId, v); return true; },
    setParam(nodeId, name, value) { send("setParam", nodeId, name, value); return true; },
    play(nodeId, clip) { send("play", nodeId, clip); return true; },
    stop(nodeId) { send("stop", nodeId); return true; },
    pause(nodeId) { send("pause", nodeId); return true; },
    resume(nodeId) { send("resume", nodeId); return true; },

    dispose() {
      try { worker.postMessage({ type: "dispose" }); } catch {}
      worker.terminate();
    },
  };
}
