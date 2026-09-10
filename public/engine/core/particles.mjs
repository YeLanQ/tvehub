// 粒子发射器（播放器侧）：移植编辑器 src/framework/particles/ParticleEmitter.ts 的
// 语义——CPU 模拟（固定容量对象池）+ THREE.Points 渲染（自定义着色器逐粒子
// 尺寸/颜色/透明度，程序化软圆点精灵）。修改任一侧须同步另一侧。
//
// 模拟规则（常规粒子系统子集）：
// - 发射：emissionRate 按帧累加取整发射；startDelay 后开始；非循环系统在
//   duration 后停止发射，粒子全部消亡即 finished；
// - 形状：cone（沿本地 -Z，与灯光/相机前向一致）/ sphere / hemisphere / box；
// - 积分：v += g·gravityModifier·dt（模拟空间 -Y），p += v·dt；
// - 生命周期：colorOverLifetime = start→end 插值 + 末段 40% 淡出；
//   sizeOverLifetime = 线性缩到 0；
// - 模拟空间：local 粒子存节点本地坐标；world 粒子存世界坐标，写缓冲时按节点
//   世界矩阵逆变换回本地。
import * as THREE from "./three.module.min.js";

export const PARTICLE_GRAVITY = 9.81;
const MAX_STEP = 0.1;
const PREWARM_STEP = 1 / 30;
const PREWARM_MAX_STEPS = 900;
const FADE_OUT_FRACTION = 0.4;
const SPRITE_SIZE = 64;

/** 粒子 Points 子对象名（与编辑器 PARTICLES_CHILD_NAME 一致；SDK 按名寻回） */
export const PARTICLES_CHILD_NAME = "__particles";

const DEFAULTS = {
  duration: 5,
  looping: true,
  prewarm: false,
  startDelay: 0,
  startLifetime: 2,
  startSpeed: 3,
  startSize: 0.3,
  startColor: 0xffb060,
  endColor: 0xff3020,
  gravityModifier: 0,
  emissionRate: 20,
  maxParticles: 500,
  shape: "cone",
  shapeRadius: 0.5,
  shapeAngle: 25,
  simulationSpace: "local",
  colorOverLifetime: true,
  sizeOverLifetime: true,
  blending: "additive",
  texture: "",
};

/** 取值域（与编辑器 PARTICLE_LIMITS 同一份边界） */
const LIMITS = {
  duration: [0.05, 600],
  startDelay: [0, 60],
  startLifetime: [0.05, 120],
  startSpeed: [0, 200],
  startSize: [0.01, 100],
  gravityModifier: [-20, 20],
  emissionRate: [0, 5000],
  maxParticles: [1, 20000],
  shapeRadius: [0, 500],
  shapeAngle: [0, 89],
};

function num(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function bool(v, fb) {
  return typeof v === "boolean" ? v : fb;
}
function clampTo(v, key) {
  const [lo, hi] = LIMITS[key];
  return Math.max(lo, Math.min(hi, v));
}
function hexColor(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? (Math.round(v) & 0xffffff) >>> 0 : fb;
}

/** 粒子设置收敛（缺失/非法字段回退默认；移植 parseParticleSystemSettings） */
export function parseParticleSettings(v) {
  const o = v && typeof v === "object" ? v : {};
  const d = DEFAULTS;
  const shape =
    o.shape === "sphere" || o.shape === "hemisphere" || o.shape === "box" || o.shape === "cone"
      ? o.shape
      : d.shape;
  return {
    duration: clampTo(num(o.duration, d.duration), "duration"),
    looping: bool(o.looping, d.looping),
    prewarm: bool(o.prewarm, d.prewarm),
    startDelay: clampTo(num(o.startDelay, d.startDelay), "startDelay"),
    startLifetime: clampTo(num(o.startLifetime, d.startLifetime), "startLifetime"),
    startSpeed: clampTo(num(o.startSpeed, d.startSpeed), "startSpeed"),
    startSize: clampTo(num(o.startSize, d.startSize), "startSize"),
    startColor: hexColor(o.startColor, d.startColor),
    endColor: hexColor(o.endColor, d.endColor),
    gravityModifier: clampTo(num(o.gravityModifier, d.gravityModifier), "gravityModifier"),
    emissionRate: clampTo(num(o.emissionRate, d.emissionRate), "emissionRate"),
    maxParticles: Math.round(clampTo(num(o.maxParticles, d.maxParticles), "maxParticles")),
    shape,
    shapeRadius: clampTo(num(o.shapeRadius, d.shapeRadius), "shapeRadius"),
    shapeAngle: clampTo(num(o.shapeAngle, d.shapeAngle), "shapeAngle"),
    simulationSpace: o.simulationSpace === "world" ? "world" : "local",
    colorOverLifetime: bool(o.colorOverLifetime, d.colorOverLifetime),
    sizeOverLifetime: bool(o.sizeOverLifetime, d.sizeOverLifetime),
    blending: o.blending === "normal" ? "normal" : "additive",
    // 粒子贴图（图片资产相对路径；空串 = 内置软圆点）；加载由 runtime/particles.mjs 负责
    texture: typeof o.texture === "string" ? o.texture : "",
  };
}

/** 结构签名：变化时须重建渲染对象（缓冲容量 / 混合模式） */
export function particleStructureSignature(s) {
  return `${s.maxParticles}|${s.blending}`;
}

let spriteTexture = null;

/** 软圆点精灵贴图（程序化径向渐变 DataTexture；全局共享） */
export function getParticleSpriteTexture() {
  if (spriteTexture) return spriteTexture;
  const n = SPRITE_SIZE;
  const data = new Uint8Array(n * n * 4);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.min(1, Math.hypot(dx, dy));
      const t = 1 - r;
      const a = t * t * (3 - 2 * t);
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  spriteTexture = tex;
  return tex;
}

const VERTEX_SHADER = `
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uScale;
  uniform float uOrtho;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    float px = uOrtho > 0.5 ? aSize * uScale : aSize * uScale / max( -mv.z, 0.001 );
    gl_PointSize = max( px, 0.0 );
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  varying vec4 vColor;
  void main() {
    // gl_PointCoord 原点在左上，three 贴图原点在左下：翻转 y 与 PointsMaterial 同约定
    vec4 t = texture2D( uMap, vec2( gl_PointCoord.x, 1.0 - gl_PointCoord.y ) );
    float a = t.a * vColor.a;
    if ( a <= 0.002 ) discard;
    // 贴图 RGB 与粒子颜色相乘（内置软圆点 RGB 为白，等价于只取 alpha）
    gl_FragColor = vec4( vColor.rgb * t.rgb, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _size2 = new THREE.Vector2();

function createParticleMaterial(blending) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: getParticleSpriteTexture() },
      uScale: { value: 300 },
      uOrtho: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: blending === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

/** 单位球面均匀随机方向 */
function randomDirection(out) {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out.set(Math.cos(t) * r, Math.sin(t) * r, z);
}

/**
 * 创建粒子发射器：返回 { object, update(dt, host), setSettings, needsRebuild,
 * play, pause, stop, clear, restart, state, settings, dispose }。
 * object 为 THREE.Points（名 __particles，userData.particleEmitter 指回本句柄）。
 */
export function createParticleEmitter(raw) {
  let settings = parseParticleSettings(raw);
  const cap = Math.max(1, Math.round(settings.maxParticles));
  const structureSig = particleStructureSignature(settings);

  const pos = new Float32Array(cap * 3);
  const vel = new Float32Array(cap * 3);
  const age = new Float32Array(cap);
  const life = new Float32Array(cap);
  const size0 = new Float32Array(cap);
  let alive = 0;

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
  const colorAttr = new THREE.BufferAttribute(new Float32Array(cap * 4), 4);
  const sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aColor", colorAttr);
  geometry.setAttribute("aSize", sizeAttr);
  geometry.setDrawRange(0, 0);
  const points = new THREE.Points(geometry, createParticleMaterial(settings.blending));
  points.frustumCulled = false;
  points.name = PARTICLES_CHILD_NAME;

  let time = 0;
  let acc = 0;
  let paused = false;
  let emissionStopped = false;
  // 待预热：建出/重启时置位，首次 update 时（宿主已挂好）快进一个周期
  let pendingPrewarm = settings.prewarm && settings.looping;

  function finished() {
    return !settings.looping && time >= settings.startDelay + settings.duration && alive === 0;
  }

  function recycle(i) {
    const last = alive - 1;
    if (i !== last) {
      const src = last * 3;
      const dst = i * 3;
      pos[dst] = pos[src];
      pos[dst + 1] = pos[src + 1];
      pos[dst + 2] = pos[src + 2];
      vel[dst] = vel[src];
      vel[dst + 1] = vel[src + 1];
      vel[dst + 2] = vel[src + 2];
      age[i] = age[last];
      life[i] = life[last];
      size0[i] = size0[last];
    }
    alive = last;
  }

  function spawn(dt, worldHost) {
    const s = settings;
    const i = alive++;
    const o = i * 3;
    let px = 0, py = 0, pz = 0;
    let dx = 0, dy = 0, dz = -1;
    const r = s.shapeRadius;
    switch (s.shape) {
      case "sphere": {
        randomDirection(_v);
        dx = _v.x; dy = _v.y; dz = _v.z;
        px = dx * r; py = dy * r; pz = dz * r;
        break;
      }
      case "hemisphere": {
        randomDirection(_v);
        if (_v.y < 0) _v.y = -_v.y;
        dx = _v.x; dy = _v.y; dz = _v.z;
        px = dx * r; py = dy * r; pz = dz * r;
        break;
      }
      case "box": {
        px = (Math.random() * 2 - 1) * r;
        py = (Math.random() * 2 - 1) * r;
        pz = (Math.random() * 2 - 1) * r;
        break;
      }
      default: {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * r;
        px = Math.cos(ang) * rad;
        py = Math.sin(ang) * rad;
        pz = 0;
        const tilt = Math.random() * ((s.shapeAngle * Math.PI) / 180);
        const azimuth = Math.random() * Math.PI * 2;
        const st = Math.sin(tilt);
        dx = Math.cos(azimuth) * st;
        dy = Math.sin(azimuth) * st;
        dz = -Math.cos(tilt);
        break;
      }
    }
    if (worldHost) {
      _v.set(px, py, pz).applyMatrix4(worldHost.matrixWorld);
      px = _v.x; py = _v.y; pz = _v.z;
      worldHost.getWorldQuaternion(_q);
      _v.set(dx, dy, dz).applyQuaternion(_q).normalize();
      dx = _v.x; dy = _v.y; dz = _v.z;
    }
    const sp = s.startSpeed;
    const vx = dx * sp, vy = dy * sp, vz = dz * sp;
    const head = Math.random() * dt;
    pos[o] = px + vx * head;
    pos[o + 1] = py + vy * head;
    pos[o + 2] = pz + vz * head;
    vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
    age[i] = head;
    life[i] = Math.max(0.001, s.startLifetime);
    size0[i] = s.startSize;
  }

  function simulate(dt, host) {
    const s = settings;
    const world = s.simulationSpace === "world";
    if (world && host) host.updateWorldMatrix(true, false);
    const g = -PARTICLE_GRAVITY * s.gravityModifier * dt;
    let i = 0;
    while (i < alive) {
      const a = age[i] + dt;
      if (a >= life[i]) {
        recycle(i);
        continue;
      }
      age[i] = a;
      const o = i * 3;
      vel[o + 1] += g;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      i++;
    }
    time += dt;
    const emitting =
      !emissionStopped &&
      time >= s.startDelay &&
      (s.looping || time - s.startDelay < s.duration);
    if (!emitting) {
      acc = 0;
      return;
    }
    acc += s.emissionRate * dt;
    let n = Math.floor(acc);
    acc -= n;
    while (n-- > 0) {
      if (alive >= cap) {
        acc = 0;
        break;
      }
      spawn(dt, world ? host : null);
    }
  }

  function writeBuffers(host) {
    const s = settings;
    const n = alive;
    const world = s.simulationSpace === "world" && !!host;
    if (world) {
      host.updateWorldMatrix(true, false);
      _inv.copy(host.matrixWorld).invert();
    }
    _c0.setHex(s.startColor);
    _c1.setHex(s.endColor);
    const pa = posAttr.array;
    const ca = colorAttr.array;
    const sa = sizeAttr.array;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = pos[o], y = pos[o + 1], z = pos[o + 2];
      if (world) {
        _v.set(x, y, z).applyMatrix4(_inv);
        x = _v.x; y = _v.y; z = _v.z;
      }
      pa[o] = x; pa[o + 1] = y; pa[o + 2] = z;
      const t = Math.min(1, age[i] / life[i]);
      const c = i * 4;
      if (s.colorOverLifetime) {
        ca[c] = _c0.r + (_c1.r - _c0.r) * t;
        ca[c + 1] = _c0.g + (_c1.g - _c0.g) * t;
        ca[c + 2] = _c0.b + (_c1.b - _c0.b) * t;
        ca[c + 3] = Math.min(1, (1 - t) / FADE_OUT_FRACTION);
      } else {
        ca[c] = _c0.r; ca[c + 1] = _c0.g; ca[c + 2] = _c0.b; ca[c + 3] = 1;
      }
      sa[i] = s.sizeOverLifetime ? size0[i] * (1 - t) : size0[i];
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    geometry.setDrawRange(0, n);
  }

  function prewarm(host) {
    const steps = Math.min(PREWARM_MAX_STEPS, Math.ceil(settings.duration / PREWARM_STEP));
    for (let i = 0; i < steps; i++) simulate(PREWARM_STEP, host);
  }

  function clear() {
    alive = 0;
    geometry.setDrawRange(0, 0);
  }

  function restart() {
    clear();
    time = 0;
    acc = 0;
    paused = false;
    emissionStopped = false;
    pendingPrewarm = settings.prewarm && settings.looping;
  }

  /** 点尺寸换算比例：透视 = 视口半高 / tan(fov/2)，正交 = 视口高 / 取景高 */
  points.onBeforeRender = (renderer, _scene, camera) => {
    const u = points.material.uniforms;
    renderer.getDrawingBufferSize(_size2);
    const h = _size2.y || 1;
    if (camera.isOrthographicCamera === true) {
      const span = Math.max(1e-4, (camera.top - camera.bottom) / Math.max(1e-4, camera.zoom));
      u.uScale.value = h / span;
      u.uOrtho.value = 1;
      return;
    }
    const fov = camera.isPerspectiveCamera === true ? camera.fov : 50;
    u.uScale.value = (h * 0.5) / Math.tan((fov * Math.PI) / 360);
    u.uOrtho.value = 0;
  };

  const api = {
    object: points,
    get settings() {
      return settings;
    },
    get aliveCount() {
      return alive;
    },
    get state() {
      const fin = finished();
      return { playing: !paused && !fin, paused, finished: fin, alive, time };
    },
    needsRebuild(next) {
      return particleStructureSignature(parseParticleSettings(next)) !== structureSig;
    },
    /** 原地更新参数（不重置存活粒子；模拟空间切换时清空） */
    setSettings(next) {
      const prevSpace = settings.simulationSpace;
      settings = parseParticleSettings(next);
      if (prevSpace !== settings.simulationSpace) clear();
    },
    /** 替换粒子贴图（null = 回内置软圆点）；贴图由调用方按 settings.texture 异步加载后传入 */
    setTexture(tex) {
      const u = points.material.uniforms;
      const next = tex ?? getParticleSpriteTexture();
      if (u.uMap.value !== next) u.uMap.value = next;
    },
    /** 当前采样贴图 */
    get texture() {
      return points.material.uniforms.uMap.value;
    },
    update(dt, host) {
      if (paused) return;
      const step = dt > 0 && Number.isFinite(dt) ? Math.min(dt, MAX_STEP) : 0;
      const parent = host ?? points.parent ?? null;
      if (pendingPrewarm) {
        pendingPrewarm = false;
        prewarm(parent);
      }
      if (step > 0) simulate(step, parent);
      writeBuffers(parent);
    },
    play() {
      if (paused) {
        paused = false;
        return;
      }
      if (emissionStopped || finished()) restart();
    },
    pause() {
      paused = true;
    },
    stop() {
      emissionStopped = true;
    },
    clear,
    restart,
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      points.material.dispose();
      points.userData.particleEmitter = null;
    },
  };
  points.userData.particleEmitter = api;
  return api;
}
