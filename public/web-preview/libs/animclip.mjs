// ---------------------------------------------------------------------------
// 关键帧动画剪辑播放（.anim 资产 → 节点属性）：
// - 与编辑器 AnimationClipData 同一套数据语义（通道键 = 组.路径 字符串、
//   关键帧插值 linear/step/smooth、时长/循环/速度）；
// - 通道应用规则（与编辑器 anim-props.ts 目录镜像）：
//     position.* / rotation.*（度）/ scale.*  → 节点对象变换；
//     material.*                              → 对象材质（颜色分量为 0~1）；
//     light.*                                 → 对象子树内首个灯光；
// - entries 由 nodes.mjs 收集（节点 components 中 type=animationClip 且启用）；
// - 剪辑 JSON 按 rel fetch（导出产物内含 .anim 文本，assets shim 命中），
//   加载完成前该绑定静默跳过；
// - 每帧采样：仅覆盖剪辑中存在的通道，其余属性保持不变。
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;
const INTERPS = ["linear", "step", "smooth"];

function num(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseClip(v) {
  const o = v && typeof v === "object" ? v : {};
  const curves = [];
  const seen = new Set();
  for (const c of Array.isArray(o.curves) ? o.curves : []) {
    if (!c || typeof c !== "object") continue;
    const prop = c.prop;
    if (typeof prop !== "string" || !prop || seen.has(prop)) continue;
    seen.add(prop);
    const keys = (Array.isArray(c.keys) ? c.keys : [])
      .map((k) => ({
        t: num(k && k.t, NaN),
        v: num(k && k.v, NaN),
        i: INTERPS.includes(k && k.i) ? k.i : "linear",
      }))
      .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v))
      .sort((a, b) => a.t - b.t);
    curves.push({ prop, keys });
  }
  return {
    duration: clamp(num(o.duration, 3), 0.1, 3600),
    loops: o.loops !== false,
    curves,
  };
}

function tangentAt(keys, i) {
  const prev = keys[i - 1];
  const cur = keys[i];
  const next = keys[i + 1];
  if (prev && next) return (next.v - prev.v) / Math.max(1e-6, next.t - prev.t);
  if (next) return (next.v - cur.v) / Math.max(1e-6, next.t - cur.t);
  if (prev) return (cur.v - prev.v) / Math.max(1e-6, cur.t - prev.t);
  return 0;
}

function indexBefore(keys, t) {
  let lo = 0;
  let hi = keys.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

function evalCurve(curve, t) {
  const keys = curve.keys;
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  const i = indexBefore(keys, t);
  const k1 = keys[i];
  const k2 = keys[i + 1];
  if (!k2) return k1.v;
  if (k1.i === "step") return k1.v;
  const span = Math.max(1e-6, k2.t - k1.t);
  const u = (t - k1.t) / span;
  if (k1.i === "smooth") {
    const m1 = tangentAt(keys, i) * span;
    const m2 = tangentAt(keys, i + 1) * span;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * k1.v + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2.v + (u3 - u2) * m2;
  }
  return k1.v + (k2.v - k1.v) * u;
}

function sampleClip(clip, time, out) {
  out.clear();
  let t = time;
  if (clip.loops && clip.duration > 0) t = ((time % clip.duration) + clip.duration) % clip.duration;
  else t = clamp(time, 0, clip.duration);
  for (const c of clip.curves) {
    const v = evalCurve(c, t);
    if (v !== null) out.set(c.prop, v);
  }
  return out;
}

/** 按点路径写属性值（"color.r" → target.color.r） */
function setPath(target, path, v) {
  const segs = path.split(".");
  let cur = target;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = cur ? cur[segs[i]] : undefined;
    if (cur == null) return;
  }
  if (cur != null) cur[segs[segs.length - 1]] = v;
}

/** 按通道分组应用到节点对象（变换/材质/灯光） */
function applyValues(obj, values) {
  for (const [prop, v] of values) {
    const i = prop.indexOf(".");
    if (i < 0) continue;
    const group = prop.slice(0, i);
    const path = prop.slice(i + 1);
    if (group === "position" || group === "rotation" || group === "scale") {
      if (group === "position") obj.position[path] = v;
      else if (group === "rotation") obj.rotation[path] = v * D2R;
      else obj.scale[path] = Math.max(0.001, v);
    } else if (group === "material") {
      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      setPath(m, path, v);
    } else if (group === "light") {
      let light = null;
      obj.traverse((o) => {
        if (!light && o.isLight) light = o;
      });
      setPath(light, path, v);
    }
  }
}

/** 加载单个剪辑文本（fetch 相对路径，归档/内联产物经 assets shim 命中） */
async function loadClip(rel) {
  const res = await fetch(rel);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return parseClip(JSON.parse(await res.text()));
}

/** 单个绑定（组件）：播放进度 + 剪辑数据 + 采样缓存（entry.clip 为解析后的剪辑数据） */
function createBinding(entry) {
  const b = {
    obj: entry.obj,
    speed: Math.max(0.05, Number(entry.speed) || 1),
    loop: entry.loop !== false,
    time: 0,
    started: false,
    clip: entry.clip,
    values: new Map(),
  };
  return b;
}

/**
 * 创建关键帧动画剪辑播放器。
 * @param {Array<{clip: string, obj: object, autoplay: boolean, loop: boolean, speed: number}>} entries
 *        nodes.mjs 收集的 animationClip 组件绑定（clip 为 .anim 资产相对路径）
 * @returns {Promise<{update(dt: number): void}>} 渲染循环每帧驱动
 */
export async function createClipAnimations(entries) {
  const api = {
    update() {},
  };
  if (!entries || !entries.length) return api;

  const bindings = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (typeof entry.clip !== "string" || !entry.clip) return;
      try {
        const clip = await loadClip(entry.clip);
        bindings.push(createBinding({ ...entry, clip: clip }));
      } catch (e) {
        console.error("[anim] 剪辑加载失败 " + entry.clip + ": " + (e && e.message ? e.message : e));
      }
    }),
  );
  if (!bindings.length) return api;

  const values = new Map();
  api.update = function (dt) {
    for (const b of bindings) {
      if (b.autoplay === false && !b.started) continue; // 未开自动播放且从未触发
      b.started = true;
      b.time += Math.max(0, dt) * b.speed;
      sampleClip(b.clip, b.time, values);
      applyValues(b.obj, values);
    }
  };
  return api;
}
