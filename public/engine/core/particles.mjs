// 粒子发射器（播放器侧）：移植编辑器 src/framework/particles/ 的语义——
// CPU 模拟（固定容量对象池）+ **实例化四边形**渲染（基础几何 ±0.5，逐实例
// 属性仅 iPos(中心) + iT(归一化寿命)，顶点着色器视空间 billboard 展开）。
// 修改任一侧须同步另一侧（编辑器 ParticleEmitter / particleMaterial）。
//
// 渲染形态（为何不用点图元）：WebGPU 的原生点图元固定 1 像素，且 GL 点图元另有
// gl_PointSize 上限会裁掉大粒子；四边形方案在两种后端下都能给出正确尺寸。
// 本文件是 GLSL 实现（经典 WebGLRenderer；网页预览即此路径）。
//
// 模拟规则（常规粒子系统子集）：
// - 发射：emissionRate 按帧累加取整发射；startDelay 后开始；非循环系统在
//   duration 后停止发射，粒子全部消亡即 finished；
// - 形状：cone（沿本地 -Z）/ sphere / hemisphere / box；
// - 积分：v += g·gravityModifier·dt（模拟空间 -Y），p += v·dt；
// - 模拟空间：local 粒子存节点本地坐标；world 粒子存世界坐标并在写缓冲时逆变换回本地。
import * as THREE from "./three.module.min.js";

export const PARTICLE_GRAVITY = 9.81;
const MAX_STEP = 0.1;
/** 颜色随寿命：末段淡出占寿命的比例（导出供 TSL 材质实现共用同一常量） */
export const FADE_OUT_FRACTION = 0.4;
const SPRITE_SIZE = 64;

/** 粒子实例网格子对象名（与编辑器 PARTICLES_CHILD_NAME 一致） */
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
  attribute vec3 iPos;
  attribute float iT;

  uniform vec3 uStartColor;
  uniform vec3 uEndColor;
  uniform float uStartSize;
  uniform float uColorOverLifetime;
  uniform float uSizeOverLifetime;

  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    float t = clamp( iT, 0.0, 1.0 );
    vec3 rgb = mix( uStartColor, mix( uStartColor, uEndColor, t ), uColorOverLifetime );
    float fade = min( 1.0, ( 1.0 - t ) / ${FADE_OUT_FRACTION.toFixed(2)} );
    vColor = vec4( rgb, mix( 1.0, fade, uColorOverLifetime ) );

    float size = mix( uStartSize, uStartSize * ( 1.0 - t ), uSizeOverLifetime );

    vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
    mv.xy += position.xy * size;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = `
  uniform sampler2D uMap;

  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    vec4 texel = texture2D( uMap, vUv );
    float a = texel.a * vColor.a;
    if ( a <= 0.002 ) discard;
    gl_FragColor = vec4( vColor.rgb * texel.rgb, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** 基础四边形（±0.5，UV 铺满）：逐实例只有中心与寿命 */
function createQuadGeometry() {
  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
  );
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  return geom;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();

/** 单位球面均匀随机方向 */
function randomDirection(out) {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out.set(Math.cos(t) * r, Math.sin(t) * r, z);
}

/**
 * GLSL 粒子材质（经典 WebGL 后端；默认工厂）。
 * 返回句柄 { material, setSettings, setTexture, dispose }——与 TSL 实现
 * （../core/particleNodeMaterial.mjs）同一接口，发射器只依赖这个面。
 */
export function createGlslParticleMaterial(raw) {
  const s = parseParticleSettings(raw);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: getParticleSpriteTexture() },
      uStartColor: { value: new THREE.Color() },
      uEndColor: { value: new THREE.Color() },
      uStartSize: { value: s.startSize },
      uColorOverLifetime: { value: s.colorOverLifetime ? 1 : 0 },
      uSizeOverLifetime: { value: s.sizeOverLifetime ? 1 : 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: s.blending === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
  const handle = {
    material,
    currentTexture: getParticleSpriteTexture(),
    setSettings(next) {
      const u = material.uniforms;
      u.uStartColor.value.setHex(next.startColor & 0xffffff);
      u.uEndColor.value.setHex(next.endColor & 0xffffff);
      u.uStartSize.value = next.startSize;
      u.uColorOverLifetime.value = next.colorOverLifetime ? 1 : 0;
      u.uSizeOverLifetime.value = next.sizeOverLifetime ? 1 : 0;
    },
    setTexture(tex) {
      const next = tex ?? getParticleSpriteTexture();
      handle.currentTexture = next;
      const u = material.uniforms;
      if (u.uMap.value !== next) u.uMap.value = next;
    },
    dispose() {
      material.dispose();
    },
  };
  handle.setSettings(s);
  return handle;
}

/**
 * 创建粒子发射器：返回 { object, update(dt, host), setSettings, needsRebuild,
 * play, pause, stop, clear, restart, state, settings, texture, dispose }。
 * object 为实例化四边形网格（名 __particles，userData.particleEmitter 指回本句柄）。
 * materialFactory 按渲染后端注入（缺省 GLSL；WebGPU 传 TSL 工厂）。
 */
export function createParticleEmitter(raw, materialFactory) {
  let settings = parseParticleSettings(raw);
  const cap = Math.max(1, Math.round(settings.maxParticles));
  const structureSig = particleStructureSignature(settings);

  const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const tAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  tAttr.setUsage(THREE.DynamicDrawUsage);

  const geometry = createQuadGeometry();
  geometry.setAttribute("iPos", posAttr);
  geometry.setAttribute("iT", tAttr);
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);

  const matHandle = (materialFactory ?? createGlslParticleMaterial)(settings);
  const material = matHandle.material;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = PARTICLES_CHILD_NAME;
  mesh.frustumCulled = true;

  // 模拟位置：local 空间与 iPos 属性数组同一份（零拷贝）
  const pos = settings.simulationSpace === "world" ? new Float32Array(cap * 3) : posAttr.array;
  const vel = new Float32Array(cap * 3);
  const age = new Float32Array(cap);
  const invLife = new Float32Array(cap);
  let alive = 0;
  let spawnCursor = 0;

  let time = 0;
  let acc = 0;
  let paused = false;
  let emissionStopped = false;
  // 待预热：建出/重启时置位，首次 update 时（宿主已挂好）按稳态解析初始化
  let pendingPrewarm = settings.prewarm && settings.looping;
  // 本帧宿主对象（world 模拟空间；update 里取一次，spawn/writeBuffers 复用）
  let worldParent = null;
  // 本发射器独占的包围球（每帧原地重写；共用同一实例会让后更新者覆盖其余发射器）
  const bounds = new THREE.Sphere();

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
      invLife[i] = invLife[last];
    }
    alive = last;
  }

  function spawn(slot, initialAge) {
    const s = settings;
    const o = slot * 3;
    let px = 0;
    let py = 0;
    let pz = 0;
    let dx = 0;
    let dy = 0;
    let dz = -1;
    const r = s.shapeRadius;
    switch (s.shape) {
      case "sphere": {
        randomDirection(_v);
        dx = _v.x;
        dy = _v.y;
        dz = _v.z;
        px = dx * r;
        py = dy * r;
        pz = dz * r;
        break;
      }
      case "hemisphere": {
        randomDirection(_v);
        if (_v.y < 0) _v.y = -_v.y;
        dx = _v.x;
        dy = _v.y;
        dz = _v.z;
        px = dx * r;
        py = dy * r;
        pz = dz * r;
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
    if (worldParent) {
      _v.set(px, py, pz).applyMatrix4(worldParent.matrixWorld);
      px = _v.x;
      py = _v.y;
      pz = _v.z;
      _v.set(dx, dy, dz).applyQuaternion(_q).normalize();
      dx = _v.x;
      dy = _v.y;
      dz = _v.z;
    }
    const sp = s.startSpeed;
    const vx = dx * sp;
    const vy = dy * sp;
    const vz = dz * sp;
    const g = -PARTICLE_GRAVITY * s.gravityModifier;
    const t = initialAge;
    pos[o] = px + vx * t + 0.5 * g * t * t;
    pos[o + 1] = py + vy * t + 0.5 * g * t * t;
    pos[o + 2] = pz + vz * t + 0.5 * g * t * t;
    vel[o] = vx;
    vel[o + 1] = vy + g * t;
    vel[o + 2] = vz;
    age[slot] = t;
    invLife[slot] = 1 / Math.max(0.001, s.startLifetime);
  }

  /** 预热：按稳态解析初始化（O(容量) 一次），不逐步模拟 */
  function prewarm() {
    const s = settings;
    time = Math.max(time, s.startDelay);
    const want = Math.min(cap, Math.max(0, Math.round(s.emissionRate * s.startLifetime)));
    if (want <= 0) return;
    for (let i = 0; i < want; i++) spawn(i, Math.random() * s.startLifetime);
    alive = Math.max(alive, want);
  }

  function simulate(dt) {
    const s = settings;
    const g = -PARTICLE_GRAVITY * s.gravityModifier * dt;
    let i = 0;
    while (i < alive) {
      const a = age[i] + dt;
      if (a * invLife[i] >= 1) {
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
      if (alive < cap) {
        spawn(alive, Math.random() * dt);
        alive++;
      } else {
        // 满容量：轮转覆盖槽位（近似覆盖最旧），新粒子不被丢弃
        spawn(spawnCursor, Math.random() * dt);
        spawnCursor = (spawnCursor + 1) % cap;
      }
    }
  }

  function writeBuffers() {
    const s = settings;
    const n = alive;
    const pa = posAttr.array;
    const ta = tAttr.array;
    if (s.simulationSpace === "world" && worldParent) {
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        _v.set(pos[o], pos[o + 1], pos[o + 2]).applyMatrix4(_inv);
        pa[o] = _v.x;
        pa[o + 1] = _v.y;
        pa[o + 2] = _v.z;
      }
    }
    for (let i = 0; i < n; i++) {
      const t = age[i] * invLife[i];
      ta[i] = t < 1 ? t : 1;
    }
    geometry.instanceCount = n;
    if (n === 0) return;
    if (n < cap) {
      // 只上传存活区间：先清空再登记，避免多帧未绘制时范围逐帧累积
      posAttr.clearUpdateRanges();
      tAttr.clearUpdateRanges();
      posAttr.addUpdateRange(0, n * 3);
      tAttr.addUpdateRange(0, n);
    }
    posAttr.needsUpdate = true;
    tAttr.needsUpdate = true;
  }

  /** 包围球按存活粒子重算（本地空间坐标；开启视锥剔除后屏幕外系统零绘制开销） */
  function updateBoundingSphere() {
    const n = alive;
    if (n === 0) {
      bounds.center.set(0, 0, 0);
      bounds.radius = 0;
      geometry.boundingSphere = bounds;
      return;
    }
    const pa = posAttr.array;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const x = pa[o];
      const y = pa[o + 1];
      const z = pa[o + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    bounds.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const half = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    bounds.radius = half + settings.startSize * 0.75;
    // 同一实例每帧原地重写（本发射器独占；渲染期只读）
    geometry.boundingSphere = bounds;
  }

  function clear() {
    alive = 0;
    spawnCursor = 0;
    geometry.instanceCount = 0;
  }

  function restart() {
    clear();
    time = 0;
    acc = 0;
    paused = false;
    emissionStopped = false;
    pendingPrewarm = settings.prewarm && settings.looping;
  }

  const api = {
    object: mesh,
    get settings() {
      return settings;
    },
    get aliveCount() {
      return alive;
    },
    get texture() {
      return matHandle.currentTexture;
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
      matHandle.setSettings(settings);
      if (prevSpace !== settings.simulationSpace) clear();
    },
    /** 替换粒子贴图（null = 回内置软圆点） */
    setTexture(tex) {
      matHandle.setTexture(tex);
    },
    update(dt, host) {
      if (paused) return;
      const step = dt > 0 && Number.isFinite(dt) ? Math.min(dt, MAX_STEP) : 0;
      const parent = host ?? mesh.parent ?? null;
      // 宿主世界变换每帧只取一次（world 空间下本帧全部粒子发射与写缓冲共用）
      worldParent = null;
      if (settings.simulationSpace === "world" && parent) {
        parent.updateWorldMatrix(true, false);
        _inv.copy(parent.matrixWorld).invert();
        parent.getWorldQuaternion(_q);
        worldParent = parent;
      }
      if (pendingPrewarm) {
        pendingPrewarm = false;
        prewarm();
      }
      if (step > 0) simulate(step);
      writeBuffers();
      updateBoundingSphere();
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
      mesh.parent?.remove(mesh);
      geometry.dispose();
      matHandle.dispose();
      mesh.userData.particleEmitter = null;
    },
  };
  mesh.userData.particleEmitter = api;
  return api;
}
