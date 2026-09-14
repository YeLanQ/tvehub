// 音频播放：移植编辑器 AudioSystem 的“节点数据 → 运行时”语义
// （audioNode.audio：source/autoplay/loop/volume/speed + 2D/3D 空间化）。
// 2D 用 THREE.Audio 全局播放；3D 用 THREE.PositionalAudio 挂节点对象下，
// 随监听器（渲染相机）距离/方位衰减。预览只回放，不含编辑器侧的
// 运行时手动控制（播放/暂停由 engine.audio 提供给脚本）。
import * as THREE from "../core/three.module.min.js";

const DEFAULTS = {
  autoplay: true,
  loop: true,
  volume: 1,
  speed: 1,
  spatial: "2d",
  refDistance: 1,
  maxDistance: 30,
  rolloff: 1,
};

/** 音源设置收敛（缺失/非法字段回退默认；移植 parseAudioSettings 关键分支） */
function parseAudioSettings(v) {
  const o = v && typeof v === "object" ? v : {};
  const num = (x, fb) => (typeof x === "number" && Number.isFinite(x) ? x : fb);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  return {
    source: typeof o.source === "string" ? o.source : "",
    autoplay: typeof o.autoplay === "boolean" ? o.autoplay : DEFAULTS.autoplay,
    loop: typeof o.loop === "boolean" ? o.loop : DEFAULTS.loop,
    volume: clamp(num(o.volume, DEFAULTS.volume), 0, 1),
    speed: clamp(num(o.speed, DEFAULTS.speed), 0.1, 4),
    spatial: o.spatial === "3d" ? "3d" : "2d",
    refDistance: Math.max(0.01, num(o.refDistance, DEFAULTS.refDistance)),
    maxDistance: Math.max(0.01, num(o.maxDistance, DEFAULTS.maxDistance)),
    rolloff: Math.max(0, num(o.rolloff, DEFAULTS.rolloff)),
  };
}

/** 单个音源节点的绑定（音源对象 + 设置 + 运行态） */
function createBinding(nodeJson, obj) {
  const settings = parseAudioSettings(nodeJson.audio);
  const b = {
    nodeJson,
    obj,
    settings,
    emitter: null,
    ready: false,
    playing: false,
    paused: false,
    offset: 0,
    started: false,
    userStopped: false,
    autoPaused: false,
  };
  attachSource(b);
  return b;
}

/** 按 settings.source 拉取缓冲并挂发射器（异步；就绪后 autoplay 起播）。
 *  换源重建时调用方先清空旧发射态。 */
function attachSource(b) {
  if (!b.settings.source) return;
  loadBuffer(b.settings.source)
    .then((buf) => {
      if (!buf) return;
      createEmitter(b, buf);
      applyParams(b);
      if (b.settings.autoplay && !b.userStopped) tryStart(b, true);
    })
    .catch(() => {
      /* 加载失败：该音源静音 */
    });
}

/** 卸下发射器（换源/重建用）：停止播放并从节点摘除 3D 音源对象 */
function detachEmitter(b) {
  if (!b.emitter) return;
  if (b.emitter.isPlaying) b.emitter.stop();
  if (b.emitter instanceof THREE.PositionalAudio) b.obj.remove(b.emitter);
  b.emitter = null;
  b.ready = false;
}

/** 音源对象（3D 挂节点对象下随变换；2D 全局不挂树） */
function createEmitter(b, buffer) {
  let emitter;
  if (b.settings.spatial === "3d") {
    const pa = new THREE.PositionalAudio(listener);
    pa.setRefDistance(b.settings.refDistance);
    pa.setMaxDistance(b.settings.maxDistance);
    pa.setRolloffFactor(b.settings.rolloff);
    b.obj.add(pa);
    emitter = pa;
  } else {
    emitter = new THREE.Audio(listener);
  }
  emitter.setBuffer(buffer);
  b.emitter = emitter;
  b.ready = true;
}

/** 数据参数 → 音源对象（音量/循环/倍速/3D 衰减） */
function applyParams(b) {
  const e = b.emitter;
  if (!e) return;
  e.setVolume(b.settings.volume);
  e.setLoop(b.settings.loop);
  e.setPlaybackRate(b.settings.speed);
  if (e instanceof THREE.PositionalAudio) {
    e.setRefDistance(b.settings.refDistance);
    e.setMaxDistance(b.settings.maxDistance);
    e.setRolloffFactor(b.settings.rolloff);
  }
}

/** 起播（fromStart=true 从头播；false = 暂停处续播）。成功返回 true */
function tryStart(b, fromStart) {
  const e = b.emitter;
  if (!e || !b.ready) return false;
  resumeContext();
  if (getContext().state !== "running") return false;
  if (e.isPlaying) e.stop();
  if (!fromStart && b.offset > 0) e.offset = b.offset;
  e.play();
  b.playing = true;
  b.paused = false;
  b.autoPaused = false;
  b.started = true;
  return true;
}

// —— 缓冲缓存与共享监听器（全场景一份 AudioContext） ——

const bufferCache = new Map();
let listener = null;

function getContext() {
  return THREE.AudioContext.getContext();
}

function resumeContext() {
  const ctx = getContext();
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/** 解码音频资产（相对路径 fetch，归档/内联产物经 assets shim 命中；失败 reject） */
function loadBuffer(rel) {
  const cached = bufferCache.get(rel);
  if (cached) return cached;
  const task = (async () => {
    const res = await fetch(rel);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    const ctx = getContext();
    return await new Promise((resolve, reject) => {
      void ctx.decodeAudioData(arr, resolve, reject);
    });
  })();
  bufferCache.set(rel, task);
  task.catch(() => {});
  return task;
}

/** 节点对象可见性链（含自身；active/visible 已合并进 obj.visible） */
function hostVisible(obj) {
  let cur = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

/**
 * 为场景里的音源节点建立音频绑定：
 * audios 为 buildSceneTree 收集的 audioNode 列表（{ json, obj }），cam 为渲染相机
 * （挂载 AudioListener，监听位姿随相机每帧推进）。返回 { update() } 供渲染循环
 * 驱动（可见性自动暂停 + 上下文解锁后 autoplay 起播），另附 play/stop/pause/
 * resume/setVolume（按节点 id 寻址，供脚本宿主 engine.audio 转发）。
 */
export function createAudios(audios, cam) {
  listener = new THREE.AudioListener();
  cam.add(listener);
  // 浏览器自动播放策略：首次用户交互解锁 AudioContext（ctx resume 后 autoplay 生效）
  const unlock = () => {
    resumeContext();
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);

  const bindings = [];
  const byId = new Map();
  for (const entry of audios) {
    const b = createBinding(entry.json, entry.obj);
    bindings.push(b);
    if (typeof entry.json.id === "string" && entry.json.id) byId.set(entry.json.id, b);
  }
  // 音源组件条目（nodes.mjs 附带 nodeId）：节点 id 命中首个音源，
  // 兼容 SDK engine.audio 按实体寻址（组件 id 仍可精确寻址）
  for (const entry of audios) {
    const nodeId = entry.nodeId;
    if (typeof nodeId !== "string" || !nodeId || byId.has(nodeId)) continue;
    const b = byId.get(entry.json.id);
    if (b) byId.set(nodeId, b);
  }

  return {
    /** 每帧推进：可见性链断开 → 自动暂停；恢复 → 续播；autoplay 未起播过的自动开始 */
    update() {
      for (const b of bindings) {
        const e = b.emitter;
        if (e) {
          if (e.isPlaying) b.offset = e.offset;
          else if (!b.paused && b.playing) b.playing = false; // 一次性播放自然结束
        }
        const visible = hostVisible(b.obj);
        if (!visible && b.playing && !b.paused) {
          e?.pause();
          b.paused = true;
          b.autoPaused = true;
        } else if (visible && b.autoPaused) {
          // 恢复可见：从暂停处续播（手动暂停不经此路径）
          tryStart(b, false);
        }
        // 上下文解锁/缓冲就绪后补起 autoplay（started 保证一次性播完不重播）
        if (b.settings.autoplay && !b.userStopped && !b.started && !b.playing) {
          tryStart(b, true);
        }
      }
    },
    /** 播放（暂停态续播；停止/播完态从头播） */
    play(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      b.userStopped = false;
      return tryStart(b, !b.paused);
    },
    /** 停止并回到起点（autoplay 不再自动起播，play() 可恢复） */
    stop(nodeId) {
      const b = byId.get(nodeId);
      if (!b) return false;
      if (b.emitter?.isPlaying) b.emitter.stop();
      if (b.emitter) b.emitter.offset = 0;
      b.offset = 0;
      b.playing = false;
      b.paused = false;
      b.autoPaused = false;
      b.userStopped = true;
      return true;
    },
    /** 暂停（保留进度） */
    pause(nodeId) {
      const b = byId.get(nodeId);
      if (!b || !b.emitter || !b.playing || b.paused) return false;
      b.offset = b.emitter.offset;
      b.emitter.pause();
      b.paused = true;
      b.autoPaused = false;
      return true;
    },
    /** 继续播放（暂停处续播） */
    resume(nodeId) {
      const b = byId.get(nodeId);
      if (!b || !b.paused) return false;
      return tryStart(b, false);
    },
    /** 运行时音量（0~1） */
    setVolume(nodeId, volume) {
      const b = byId.get(nodeId);
      if (!b || !b.emitter) return false;
      b.emitter.setVolume(Math.max(0, Math.min(1, Number(volume) || 0)));
      return true;
    },
    /** 运行时新增音源绑定（SDK AudioSource 门面 addComponent；json = {id, audio}，
     *  nodeId 为宿主节点 id 别名，节点寻址命中首个音源） */
    addSource(json, obj, nodeId) {
      if (!json || typeof json.id !== "string" || !json.id) return false;
      const b = createBinding(json, obj);
      bindings.push(b);
      byId.set(json.id, b);
      if (typeof nodeId === "string" && nodeId && !byId.has(nodeId)) byId.set(nodeId, b);
      return true;
    },
    /** 运行时合并音源设置（settings 子集；source/spatial 变更重建发射器） */
    updateSettings(key, patch) {
      const b = byId.get(key);
      if (!b) return false;
      const merged = parseAudioSettings({
        ...b.settings,
        ...(patch && typeof patch === "object" ? patch : {}),
      });
      const rebuild =
        merged.source !== b.settings.source || merged.spatial !== b.settings.spatial;
      b.settings = merged;
      if (!rebuild) {
        applyParams(b);
        return true;
      }
      detachEmitter(b);
      b.playing = false;
      b.paused = false;
      b.offset = 0;
      b.started = false;
      b.autoPaused = false;
      attachSource(b);
      return true;
    },
    /** 音源运行态（SDK 门面 playing/paused/ready；未命中返回 null） */
    infoOf(key) {
      const b = byId.get(key);
      return b ? { playing: !!b.emitter?.isPlaying, paused: b.paused, ready: b.ready } : null;
    },
  };
}
