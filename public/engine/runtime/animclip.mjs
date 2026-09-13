// ---------------------------------------------------------------------------
// 关键帧动画剪辑播放（.anim 资产 → 节点属性）：
// - 与编辑器 AnimationClipData 同一套数据语义（通道键 = 组.路径 字符串、
//   关键帧插值 linear/step/smooth、smooth 支持手动贝塞尔切线 ti/to/tm 与
//   手柄权重 wi/wo（权重非缺省时按参数化三次 Bézier 求值，与 framework
//   clip.ts 逐位一致）、
//   时长/循环/速度）；
// - 通道应用规则（与编辑器 anim-props.ts 目录镜像）：
//     position.* / rotation.*（度）/ scale.*  → 节点对象变换；
//     material.*                              → 对象材质（颜色分量为 0~1）；
//     light.*                                 → 对象子树内首个灯光（angle 度→弧度）；
//     camera.fov / camera.near / camera.far   → 渲染相机投影参数（仅渲染相机
//                                               节点的绑定生效，写入后刷新投影矩阵）；
//     ui.*（anchoredPosition/size/sortOrder/fontSize/spacing/padding）
//                                             → UI 节点数据（经 UI 系统
//                                               updateSettings 生效：布局重解析/
//                                               几何与文本重建；一帧一补丁）
// - entries 由 nodes.mjs 收集（节点 components 中 type=animationClip 且启用）；
// - 剪辑 JSON 按 rel fetch（导出产物内含 .anim 文本，assets shim 命中），
//   加载完成前该绑定静默跳过；
// - 每帧采样：仅覆盖剪辑中存在的通道，其余属性保持不变。
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;
const INTERPS = ["linear", "step", "smooth"];
const TANGENT_CLAMP = 1000000;
const DEFAULT_TANGENT_WEIGHT = 1 / 3;
const TANGENT_WEIGHT_MIN = 0.01;
const TANGENT_WEIGHT_MAX = 1.5;

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
      .map((k) => {
        const key = {
          t: num(k && k.t, NaN),
          v: num(k && k.v, NaN),
          i: INTERPS.includes(k && k.i) ? k.i : "linear",
        };
        // 手动贝塞尔切线斜率（dv/dt；与 framework clip.ts 同步语义）
        const ti = num(k && k.ti, NaN);
        if (Number.isFinite(ti)) key.ti = clamp(ti, -TANGENT_CLAMP, TANGENT_CLAMP);
        const to = num(k && k.to, NaN);
        if (Number.isFinite(to)) key.to = clamp(to, -TANGENT_CLAMP, TANGENT_CLAMP);
        if (k && k.tm === true) key.tm = true;
        // 手柄权重（仅影响 smooth 段求值的形变；与 framework clip.ts 同步语义）
        const wi = num(k && k.wi, NaN);
        if (Number.isFinite(wi)) key.wi = clamp(wi, TANGENT_WEIGHT_MIN, TANGENT_WEIGHT_MAX);
        const wo = num(k && k.wo, NaN);
        if (Number.isFinite(wo)) key.wo = clamp(wo, TANGENT_WEIGHT_MIN, TANGENT_WEIGHT_MAX);
        return key;
      })
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

/** 关键帧某侧生效切线：手动 ti/to 优先，否则自动 Catmull-Rom */
function keySlope(keys, i, side) {
  const manual = side === "ti" ? keys[i] && keys[i].ti : keys[i] && keys[i].to;
  return manual === undefined ? tangentAt(keys, i) : manual;
}

/** 关键帧某侧生效手柄权重（钳 [MIN, MAX]；缺省 = 1/3） */
function keyWeight(keys, i, side) {
  const w = side === "ti" ? keys[i] && keys[i].wi : keys[i] && keys[i].wo;
  return w === undefined || !Number.isFinite(w)
    ? DEFAULT_TANGENT_WEIGHT
    : clamp(w, TANGENT_WEIGHT_MIN, TANGENT_WEIGHT_MAX);
}

function cubicBezier(p0, c1, c2, p3, u) {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * c1 + 3 * m * u * u * c2 + u * u * u * p3;
}

/** smooth 段求值（权重形变的参数化三次 Bézier；与 framework clip.ts 逐行同构） */
function sampleSmoothSegment(keys, i, time) {
  const k1 = keys[i];
  const k2 = keys[i + 1];
  if (!k1) return 0;
  if (!k2) return k1.v;
  const span = Math.max(1e-6, k2.t - k1.t);
  const u0 = clamp((time - k1.t) / span, 0, 1);
  if (u0 <= 0) return k1.v;
  const s1 = keySlope(keys, i, "to");
  const s2 = keySlope(keys, i + 1, "ti");
  const w1 = keyWeight(keys, i, "to");
  const w2 = keyWeight(keys, i + 1, "ti");
  if (w1 === DEFAULT_TANGENT_WEIGHT && w2 === DEFAULT_TANGENT_WEIGHT) {
    const u2 = u0 * u0;
    const u3 = u2 * u0;
    const m1 = s1 * span;
    const m2 = s2 * span;
    return (
      (2 * u3 - 3 * u2 + 1) * k1.v +
      (u3 - 2 * u2 + u0) * m1 +
      (-2 * u3 + 3 * u2) * k2.v +
      (u3 - u2) * m2
    );
  }
  const A = 3 * w1 + 3 * w2 - 2;
  const B = 3 - 6 * w1 - 3 * w2;
  const C = 3 * w1;
  const yAt = (u) => cubicBezier(k1.v, k1.v + s1 * w1 * span, k2.v - s2 * w2 * span, k2.v, u);
  if (A === 0) {
    if (B === 0) return C === 0 ? k1.v : yAt(clamp(u0 / C, 0, 1));
    const disc = Math.max(0, C * C + 4 * B * u0);
    return yAt(clamp((-C + Math.sqrt(disc)) / (2 * B), 0, 1));
  }
  const f = (uu) => ((A * uu + B) * uu + C) * uu - u0;
  let lo = 0;
  let hi = -1;
  let prev = f(0);
  for (let s = 1; s <= 32; s++) {
    const uu = s / 32;
    const fv = f(uu);
    if (prev < 0 && fv >= 0) {
      lo = (s - 1) / 32;
      hi = uu;
      break;
    }
    prev = fv;
  }
  if (hi < 0) return yAt(1);
  for (let n = 0; n < 30; n++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return yAt((lo + hi) / 2);
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
    return sampleSmoothSegment(keys, i, t);
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

/** 按预解析路径段写属性值（"color.r" → target.color.r；段数组剪辑加载时拆好） */
function setSegs(target, segs, v) {
  let cur = target;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = cur ? cur[segs[i]] : undefined;
    if (cur == null) return;
  }
  if (cur != null) cur[segs[segs.length - 1]] = v;
}

/** 按路径段写入并自动创建中间对象（攒 UI 设置补丁用：patch.anchoredPosition.x = v） */
function setSegsCreate(target, segs, v) {
  let cur = target;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null || typeof cur[segs[i]] !== "object") cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = v;
}

/** 对象子树内首个灯光（灯光缓存未命中时逐帧重试，命中后固定） */
function findFirstLight(obj) {
  let light = null;
  obj.traverse((o) => {
    if (!light && o.isLight) light = o;
  });
  return light;
}

/**
 * 预编译通道应用项：分组判断/路径拆分/目标定位只在剪辑加载时做一次。
 * 旧实现每帧对每条通道 split(".") + 前缀切片 + 灯光子树全遍历；
 * 编译后采样循环只做曲线求值 + 属性直写（语义与逐帧解析完全一致）。
 */
function compileBinding(b) {
  const items = [];
  for (const c of b.clip.curves) {
    const dot = c.prop.indexOf(".");
    if (dot < 0) continue;
    const group = c.prop.slice(0, dot);
    const path = c.prop.slice(dot + 1);
    if (group === "position" || group === "rotation" || group === "scale") {
      items.push({ curve: c, group, prop: path });
    } else if (group === "material") {
      items.push({ curve: c, group, segs: path.split(".") });
    } else if (group === "light") {
      const segs = path.split(".");
      items.push({
        curve: c,
        group,
        segs,
        light: null,
        // 聚光角度：通道值为度（与编辑器/节点一致），three 灯光为弧度
        degrees: segs.length === 1 && segs[0] === "angle",
      });
    } else if (group === "camera") {
      items.push({ curve: c, group, segs: path.split(".") });
    } else if (group === "ui") {
      // UI 节点数据字段（anchoredPosition.x / size.y / spacing.x / padding.left…）
      items.push({ curve: c, group, segs: path.split(".") });
    }
    // 其余分组不构成应用目标（与编辑器通道目录一致）：跳过
  }
  b.compiled = items;
}

function applyItem(b, item, v) {
  const obj = b.obj;
  if (item.group === "position") {
    obj.position[item.prop] = v;
  } else if (item.group === "rotation") {
    obj.rotation[item.prop] = v * D2R;
  } else if (item.group === "scale") {
    obj.scale[item.prop] = Math.max(0.001, v);
  } else if (item.group === "material") {
    const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    setSegs(m, item.segs, v);
  } else if (item.group === "light") {
    // 灯光目标惰性解析（组件灯光可能在剪辑加载后才挂上）；命中后固定复用
    if (item.light === null) {
      item.light = findFirstLight(obj);
      if (item.light === null) return;
    }
    setSegs(item.light, item.segs, item.degrees ? v * D2R : v);
  } else if (item.group === "camera") {
    // 相机投影参数：仅渲染相机节点的绑定有 camTarget；fov 对正交相机无意义
    const t = b.camTarget;
    if (!t) return;
    const key = item.segs.length === 1 ? item.segs[0] : "";
    if (key === "fov" && t.isOrthographicCamera) return;
    if (key === "near") v = Math.max(0.01, v);
    else if (key === "far") v = Math.max(t.near + 0.001, v);
    setSegs(t, item.segs, v);
    t.updateProjectionMatrix();
  }
}

/** 采样剪辑并把通道值直写节点（时间包裹规则与 sampleClip 一致） */
function applyClipAt(b, time) {
  const clip = b.clip;
  let t = time;
  if (clip.loops && clip.duration > 0) t = ((time % clip.duration) + clip.duration) % clip.duration;
  else t = clamp(time, 0, clip.duration);
  let uiPatch = null;
  for (const item of b.compiled) {
    const v = evalCurve(item.curve, t);
    if (v === null) continue;
    if (item.group === "ui") {
      // UI 数据字段：攒补丁，循环后经 UI 系统 updateSettings 一次性生效
      // （逐通道写同一 Vec2 的不同分量；缺省分量由 updateSettings 保留当前值）
      if (!b.uiApi) continue;
      uiPatch = uiPatch || {};
      setSegsCreate(uiPatch, item.segs, v);
      continue;
    }
    applyItem(b, item, v);
  }
  if (uiPatch) b.uiApi.updateSettings(b.nodeId, uiPatch);
}

/** 加载单个剪辑文本（fetch 相对路径，归档/内联产物经 assets shim 命中） */
async function loadClip(rel) {
  const res = await fetch(rel);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return parseClip(JSON.parse(await res.text()));
}

/** 单个绑定（组件）：播放进度 + 剪辑数据 + 预编译应用项。
 *  播放态模型：playing = 正在推进；paused = 经 pause() 暂停（resume 续播）；
 *  clip 为解析后的剪辑数据（异步加载完成前为 null，update/控件调用静默跳过）；
 *  camTarget = 渲染相机（仅当绑定节点是渲染相机节点时非空，camera.* 组写入目标）；
 *  uiApi = UI 系统（ui.* 组经 updateSettings 生效；播放器注入，编辑器预览不用）。 */
function createBinding(entry, camEnv, uiApi) {
  const nodeId = typeof entry.nodeId === "string" ? entry.nodeId : "";
  return {
    key: typeof entry.key === "string" && entry.key ? entry.key : "",
    nodeId,
    obj: entry.obj,
    camTarget: camEnv && camEnv.nodeId && camEnv.nodeId === nodeId ? camEnv.cam : null,
    uiApi,
    speed: Math.max(0.05, Number(entry.speed) || 1),
    loop: entry.loop !== false,
    autoplay: entry.autoplay !== false,
    time: 0,
    playing: false,
    paused: false,
    clipPath: typeof entry.clip === "string" ? entry.clip : "",
    clip: null,
    compiled: [],
  };
}

/** 加载绑定当前 clipPath 指向的剪辑（写入 b.clip 并预编译；失败告警并保持 null） */
async function loadInto(b) {
  if (!b.clipPath) return false;
  try {
    b.clip = await loadClip(b.clipPath);
    compileBinding(b);
    return true;
  } catch (e) {
    console.error("[anim] 剪辑加载失败 " + b.clipPath + ": " + (e && e.message ? e.message : e));
    return false;
  }
}

/** 立即采样并应用某时刻的值（seek/停止回初始姿势用） */
function sampleAt(b, time) {
  if (!b.clip) return;
  applyClipAt(b, time);
}

/**
 * 创建关键帧动画剪辑播放器。
 * @param {Array<{key?: string, nodeId?: string, clip: string, obj: object,
 *                autoplay: boolean, loop: boolean, speed: number}>} entries
 *        nodes.mjs 收集的 animationClip 组件绑定（clip 为 .anim 资产相对路径；
 *        key = 组件 id，缺省回退节点 id，SDK 门面按 key 寻址）
 * @param {{renderCamera?: {nodeId: string, cam: object}, ui?: {updateSettings: Function}}} [env]
 *        播放器环境：renderCamera = 渲染相机与其节点 id（camera.* 通道的写入
 *        目标；节点 id 匹配的绑定才生效，其余绑定的 camera.* 通道跳过）；
 *        ui = UI 系统（ui.* 通道经其 updateSettings 落地，缺省时 ui.* 跳过）
 * @returns {Promise<{update(dt: number): void} & ClipAnimApi>} 渲染循环每帧驱动
 *          + 运行时控件 API（SDK AnimationClip 门面 / 动态创建组件用）
 */
export async function createClipAnimations(entries, env) {
  const api = {
    update() {},
  };
  if (!entries || !entries.length) return api;

  const renderCamera = env && env.renderCamera ? env.renderCamera : null;
  const camEnv =
    renderCamera && renderCamera.cam && renderCamera.nodeId
      ? { nodeId: renderCamera.nodeId, cam: renderCamera.cam }
      : null;
  const uiApi =
    env && env.ui && typeof env.ui.updateSettings === "function" ? env.ui : null;

  const bindings = [];
  const byKey = new Map();
  function register(b) {
    bindings.push(b);
    if (b.key && !byKey.has(b.key)) byKey.set(b.key, b);
  }
  await Promise.all(
    entries.map(async (entry) => {
      const b = createBinding(entry, camEnv, uiApi);
      if (!b.key) b.key = typeof entry.nodeId === "string" ? entry.nodeId : "";
      if (!(await loadInto(b))) return;
      b.playing = b.autoplay; // 加载完成后按 autoplay 起播（禁用时停在初始姿势）
      register(b);
    }),
  );

  api.update = function (dt) {
    for (const b of bindings) {
      if (!b.playing || !b.clip) continue;
      b.time += Math.max(0, dt) * b.speed;
      applyClipAt(b, b.time);
    }
  };

  // —— 运行时控件 API（key 寻址；门面直接改写 b.speed/loop/autoplay 字段） ——
  api.bindingOf = (key) => byKey.get(String(key ?? "")) ?? null;
  api.play = (b) => {
    if (!b) return false;
    b.time = 0;
    b.paused = false;
    b.playing = true; // clip 未就绪时置位，加载完成后自动起播
    return true;
  };
  api.pause = (b) => {
    if (!b || !b.playing) return false;
    b.playing = false;
    b.paused = true;
    return true;
  };
  api.resume = (b) => {
    if (!b || !b.paused) return false;
    b.playing = true;
    b.paused = false;
    return true;
  };
  api.stop = (b) => {
    if (!b) return false;
    b.playing = false;
    b.paused = false;
    b.time = 0;
    sampleAt(b, 0); // 回初始姿势
    return true;
  };
  api.setTime = (b, t) => {
    if (!b) return false;
    const v = Number(t);
    b.time = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    sampleAt(b, b.time);
    return true;
  };
  api.setSpeed = (b, s) => {
    if (!b) return false;
    const v = Number(s);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) b.speed = Math.max(0.05, v);
    return true;
  };
  api.setLoop = (b, v) => {
    if (!b) return false;
    b.loop = v === true;
    return true;
  };
  api.setAutoplay = (b, v) => {
    if (!b) return false;
    b.autoplay = v === true;
    return true;
  };
  api.changeClip = async (b, rel) => {
    if (!b || typeof rel !== "string" || !rel) return false;
    const wasPlaying = b.playing;
    b.playing = false;
    b.paused = false;
    b.time = 0;
    b.clip = null;
    b.clipPath = rel;
    const ok = await loadInto(b);
    b.playing = ok && wasPlaying;
    return ok;
  };
  /** 运行时新增组件绑定（SDK addComponent；异步加载后按 autoplay 起播） */
  api.add = (entry) => {
    const b = createBinding(entry, camEnv, uiApi);
    register(b);
    void loadInto(b).then((ok) => {
      if (ok) b.playing = b.autoplay;
    });
    return b;
  };
  return api;
}

// smoke 对照钩子（scripts/smoke-components.ts 校验与 framework clip.ts 同语义；
// 浏览器运行时与导出产物均未使用）
export const __test = { parseClip, sampleClip };
