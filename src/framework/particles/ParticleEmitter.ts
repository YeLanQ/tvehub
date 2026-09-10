// ---------------------------------------------------------------------------
// 粒子发射器：CPU 模拟（固定容量对象池）+ THREE.Points 渲染（自定义着色器逐粒子
// 尺寸/颜色/透明度，程序化软圆点精灵）。编辑器视口与播放器共用同一语义 ——
// 播放器侧镜像实现在 public/engine/core/particles.mjs，修改任一侧须同步另一侧。
//
// 模拟规则（常规粒子系统子集）：
// - 发射：emissionRate 按帧累加取整发射；startDelay 后开始；非循环系统在
//   duration 后停止发射，粒子全部消亡即 finished；
// - 形状：cone（沿本地 -Z，与灯光/相机前向一致，底圆半径 + 半角内随机方向）/
//   sphere（球面外扩）/ hemisphere（上半球）/ box（盒内随机点沿 -Z）；
// - 积分：v += g·gravityModifier·dt（模拟空间 -Y），p += v·dt；
// - 生命周期：colorOverLifetime = start→end 插值 + 末段 40% 淡出；
//   sizeOverLifetime = 线性缩到 0；
// - 模拟空间：local 粒子存节点本地坐标（随节点移动）；world 粒子存世界坐标
//   （节点移动后旧粒子留在原地），写入缓冲时按节点世界矩阵逆变换回本地。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  cloneParticleSystemSettings,
  particleStructureSignature,
  type ParticleRuntimeState,
  type ParticleSystemSettings,
} from "./types";

/** 标准重力加速度（gravityModifier=1 时的加速度，世界单位/秒²） */
export const PARTICLE_GRAVITY = 9.81;
/** 单帧最大推进步长（秒）：切标签页回来时不让粒子一次性爆发/穿越 */
const MAX_STEP = 0.1;
/** 预热快进的固定子步长（秒）与步数上限 */
const PREWARM_STEP = 1 / 30;
const PREWARM_MAX_STEPS = 900;
/** 颜色随寿命：末段淡出占寿命的比例 */
const FADE_OUT_FRACTION = 0.4;
/** 精灵贴图边长（像素） */
const SPRITE_SIZE = 64;

let spriteTexture: THREE.DataTexture | null = null;

/**
 * 软圆点精灵贴图（程序化径向渐变，中心不透明 → 边缘平滑淡出）。
 * 用 DataTexture 数值生成而非 canvas：不依赖 DOM，headless 冒烟测试也能建出。
 * 全局共享一份（所有粒子系统同一贴图，材质只改颜色/混合）。
 */
export function getParticleSpriteTexture(): THREE.DataTexture {
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

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uScale;
  uniform float uOrtho;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    // aSize 为世界直径：透视按视深换算像素，正交按取景高度固定比例
    float px = uOrtho > 0.5 ? aSize * uScale : aSize * uScale / max( -mv.z, 0.001 );
    gl_PointSize = max( px, 0.0 );
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  varying vec4 vColor;
  void main() {
    // gl_PointCoord 原点在左上，three 贴图（flipY）原点在左下：翻转 y 与 PointsMaterial 同约定，
    // 用户贴图不会上下颠倒（内置软圆点径向对称，不受影响）
    vec4 t = texture2D( uMap, vec2( gl_PointCoord.x, 1.0 - gl_PointCoord.y ) );
    float a = t.a * vColor.a;
    if ( a <= 0.002 ) discard;
    // 贴图 RGB 与粒子颜色相乘（白底透明贴图即"着色精灵"；内置软圆点 RGB 为白）
    gl_FragColor = vec4( vColor.rgb * t.rgb, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** 粒子 Points 子对象名（挂在节点对象下；同步器按名同步层，运行时按名寻回） */
export const PARTICLES_CHILD_NAME = "__particles";

// 复用临时对象（帧循环调用，避免每帧分配）
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _size2 = new THREE.Vector2();

/** 粒子材质（ShaderMaterial + 程序化精灵；混合模式按设置） */
function createParticleMaterial(blending: ParticleSystemSettings["blending"]): THREE.ShaderMaterial {
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

export class ParticleEmitter {
  /** 渲染对象（挂到节点对象下；名 __particles） */
  readonly object: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private settings: ParticleSystemSettings;
  private readonly cap: number;
  private readonly structureSig: string;

  // —— 对象池（前 alive 个为存活粒子；死亡以尾交换回收）——
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private alive = 0;

  // —— 渲染缓冲 ——
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;

  // —— 播放状态 ——
  private time = 0;
  private acc = 0;
  private paused = false;
  /** stop() 后不再发射（存活粒子自然消亡）；play()/restart() 解除 */
  private emissionStopped = false;
  /** 待预热：建出/重启时置位，首次 update 时（宿主已挂好）快进一个周期 */
  private pendingPrewarm = false;

  constructor(settings: ParticleSystemSettings) {
    this.settings = cloneParticleSystemSettings(settings);
    this.cap = Math.max(1, Math.round(settings.maxParticles));
    this.structureSig = particleStructureSignature(settings);
    const n = this.cap;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);

    const geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.posAttr);
    geometry.setAttribute("aColor", this.colorAttr);
    geometry.setAttribute("aSize", this.sizeAttr);
    geometry.setDrawRange(0, 0);
    // 粒子随时飞出初始包围盒：关掉视锥剔除，避免整片粒子突然消失
    const points = new THREE.Points(geometry, createParticleMaterial(settings.blending));
    points.frustumCulled = false;
    points.name = PARTICLES_CHILD_NAME;
    points.userData.particleEmitter = this;
    // 渲染前按相机/视口换算点尺寸比例（世界直径 → 像素）
    points.onBeforeRender = (renderer, _scene, camera) => this.updateSizeScale(renderer, camera);
    this.object = points;

    this.pendingPrewarm = settings.prewarm && settings.looping;
  }

  /** 当前设置（只读副本语义：修改请走 setSettings） */
  get current(): ParticleSystemSettings {
    return this.settings;
  }

  /** 新设置是否需要整体重建（缓冲容量/混合模式属结构参数） */
  needsRebuild(next: ParticleSystemSettings): boolean {
    return particleStructureSignature(next) !== this.structureSig;
  }

  /**
   * 原地更新参数（不重置已存活粒子；检查器拖滑块不闪断）。
   * 模拟空间切换时清空粒子（已存粒子坐标系不再对应）。
   * 结构参数变化须由调用方 needsRebuild 判断后重建，这里不处理。
   */
  setSettings(next: ParticleSystemSettings): void {
    const prevSpace = this.settings.simulationSpace;
    this.settings = cloneParticleSystemSettings(next);
    if (prevSpace !== next.simulationSpace) this.clear();
  }

  /**
   * 替换粒子贴图（null = 回到内置程序化软圆点）。贴图由调用方按 settings.texture
   * 异步加载后传入（编辑器 ParticleSystem / 播放器 runtime/particles.mjs），
   * 发射器不持有资产加载逻辑；贴图对象由调用方缓存与释放。
   */
  setTexture(tex: THREE.Texture | null): void {
    const u = this.object.material.uniforms;
    const next = tex ?? getParticleSpriteTexture();
    if (u.uMap.value === next) return;
    u.uMap.value = next;
  }

  /** 当前采样贴图（内置软圆点或已加载的用户贴图；冒烟测试/调试用） */
  get texture(): THREE.Texture {
    return this.object.material.uniforms.uMap.value as THREE.Texture;
  }

  // ===================== 播放控制 =====================

  /** 播放：暂停态续播；停止/播完态从头开始 */
  play(): void {
    if (this.paused) {
      this.paused = false;
      return;
    }
    if (this.emissionStopped || this.finished) this.restart();
  }

  /** 暂停（保留当前粒子与系统时间） */
  pause(): void {
    this.paused = true;
  }

  /** 停止发射（存活粒子自然消亡） */
  stop(): void {
    this.emissionStopped = true;
  }

  /** 清空全部粒子（不改变播放态） */
  clear(): void {
    this.alive = 0;
    this.object.geometry.setDrawRange(0, 0);
  }

  /** 从头开始：清空粒子、时间归零、恢复发射（循环 + 预热系统在下一帧快进一个周期） */
  restart(): void {
    this.clear();
    this.time = 0;
    this.acc = 0;
    this.paused = false;
    this.emissionStopped = false;
    this.pendingPrewarm = this.settings.prewarm && this.settings.looping;
  }

  /** 非循环系统：发射窗口已过且粒子全部消亡 */
  get finished(): boolean {
    const s = this.settings;
    return !s.looping && this.time >= s.startDelay + s.duration && this.alive === 0;
  }

  get state(): ParticleRuntimeState {
    return {
      playing: !this.paused && !this.finished,
      paused: this.paused,
      finished: this.finished,
      alive: this.alive,
      time: this.time,
    };
  }

  get aliveCount(): number {
    return this.alive;
  }

  // ===================== 每帧推进 =====================

  /**
   * 推进 dt 秒并写渲染缓冲。host 为节点对象（Points 的父级）：world 模拟空间需要
   * 其世界矩阵做本地/世界互换；local 空间不读取。
   */
  update(dt: number, host?: THREE.Object3D | null): void {
    if (this.paused) return;
    const step = dt > 0 && Number.isFinite(dt) ? Math.min(dt, MAX_STEP) : 0;
    const parent = host ?? this.object.parent ?? null;
    if (this.pendingPrewarm) {
      this.pendingPrewarm = false;
      this.prewarm(parent);
    }
    if (step > 0) this.simulate(step, parent);
    this.writeBuffers(parent);
  }

  /** 预热：以固定子步快进一个周期（不写缓冲，update 时统一写） */
  private prewarm(host: THREE.Object3D | null): void {
    const s = this.settings;
    const steps = Math.min(PREWARM_MAX_STEPS, Math.ceil(s.duration / PREWARM_STEP));
    for (let i = 0; i < steps; i++) this.simulate(PREWARM_STEP, host);
  }

  private simulate(dt: number, host: THREE.Object3D | null): void {
    const s = this.settings;
    const world = s.simulationSpace === "world";
    if (world && host) host.updateWorldMatrix(true, false);

    // —— 已存活粒子：积分 + 老化 + 回收 ——
    const g = -PARTICLE_GRAVITY * s.gravityModifier * dt;
    const pos = this.pos;
    const vel = this.vel;
    let i = 0;
    while (i < this.alive) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) {
        this.recycle(i);
        continue;
      }
      this.age[i] = a;
      const o = i * 3;
      vel[o + 1] += g;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      i++;
    }

    // —— 发射 ——
    this.time += dt;
    const emitting =
      !this.emissionStopped &&
      this.time >= s.startDelay &&
      (s.looping || this.time - s.startDelay < s.duration);
    if (!emitting) {
      this.acc = 0;
      return;
    }
    this.acc += s.emissionRate * dt;
    let n = Math.floor(this.acc);
    this.acc -= n;
    while (n-- > 0) {
      if (this.alive >= this.cap) {
        // 容量已满：丢弃本帧溢出，不累积到下一帧集中爆发
        this.acc = 0;
        break;
      }
      this.spawn(dt, world ? host : null);
    }
  }

  /** 尾交换回收第 i 个粒子 */
  private recycle(i: number): void {
    const last = this.alive - 1;
    if (i !== last) {
      const src = last * 3;
      const dst = i * 3;
      this.pos[dst] = this.pos[src];
      this.pos[dst + 1] = this.pos[src + 1];
      this.pos[dst + 2] = this.pos[src + 2];
      this.vel[dst] = this.vel[src];
      this.vel[dst + 1] = this.vel[src + 1];
      this.vel[dst + 2] = this.vel[src + 2];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size0[i] = this.size0[last];
    }
    this.alive = last;
  }

  /**
   * 发射一个粒子：按形状取本地出生点与方向；world 空间时经宿主世界矩阵换算。
   * 出生后随机推进 [0, dt) 内的一段（同帧发射的粒子沿轨迹散开，低帧率不成串）。
   */
  private spawn(dt: number, worldHost: THREE.Object3D | null): void {
    const s = this.settings;
    const i = this.alive++;
    const o = i * 3;
    // 本地出生点 / 方向
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
        // cone：底圆内随机出生点；方向 = 本地 -Z 绕随机方位偏转 [0, 半角]
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
      // 本地 → 世界：出生点经世界矩阵，方向经世界旋转（忽略缩放对方向的影响）
      _v.set(px, py, pz).applyMatrix4(worldHost.matrixWorld);
      px = _v.x;
      py = _v.y;
      pz = _v.z;
      worldHost.getWorldQuaternion(_q);
      _v.set(dx, dy, dz).applyQuaternion(_q).normalize();
      dx = _v.x;
      dy = _v.y;
      dz = _v.z;
    }
    const sp = s.startSpeed;
    const vx = dx * sp;
    const vy = dy * sp;
    const vz = dz * sp;
    const head = Math.random() * dt;
    this.pos[o] = px + vx * head;
    this.pos[o + 1] = py + vy * head;
    this.pos[o + 2] = pz + vz * head;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.age[i] = head;
    this.life[i] = Math.max(0.001, s.startLifetime);
    this.size0[i] = s.startSize;
  }

  /** 存活粒子 → 渲染缓冲（位置/颜色+透明度/尺寸），world 空间按宿主逆矩阵回本地 */
  private writeBuffers(host: THREE.Object3D | null): void {
    const s = this.settings;
    const n = this.alive;
    const world = s.simulationSpace === "world" && !!host;
    if (world) {
      host!.updateWorldMatrix(true, false);
      _inv.copy(host!.matrixWorld).invert();
    }
    _c0.setHex(s.startColor);
    _c1.setHex(s.endColor);
    const pa = this.posAttr.array as Float32Array;
    const ca = this.colorAttr.array as Float32Array;
    const sa = this.sizeAttr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = this.pos[o];
      let y = this.pos[o + 1];
      let z = this.pos[o + 2];
      if (world) {
        _v.set(x, y, z).applyMatrix4(_inv);
        x = _v.x;
        y = _v.y;
        z = _v.z;
      }
      pa[o] = x;
      pa[o + 1] = y;
      pa[o + 2] = z;
      const t = Math.min(1, this.age[i] / this.life[i]);
      const c = i * 4;
      if (s.colorOverLifetime) {
        ca[c] = _c0.r + (_c1.r - _c0.r) * t;
        ca[c + 1] = _c0.g + (_c1.g - _c0.g) * t;
        ca[c + 2] = _c0.b + (_c1.b - _c0.b) * t;
        ca[c + 3] = Math.min(1, (1 - t) / FADE_OUT_FRACTION);
      } else {
        ca[c] = _c0.r;
        ca[c + 1] = _c0.g;
        ca[c + 2] = _c0.b;
        ca[c + 3] = 1;
      }
      sa[i] = s.sizeOverLifetime ? this.size0[i] * (1 - t) : this.size0[i];
    }
    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.object.geometry.setDrawRange(0, n);
  }

  /** 点尺寸换算比例：透视 = 视口半高 / tan(fov/2)，正交 = 视口高 / 取景高 */
  private updateSizeScale(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const u = this.object.material.uniforms;
    renderer.getDrawingBufferSize(_size2);
    const h = _size2.y || 1;
    const ortho = camera as THREE.OrthographicCamera;
    if (ortho.isOrthographicCamera === true) {
      const span = Math.max(1e-4, (ortho.top - ortho.bottom) / Math.max(1e-4, ortho.zoom));
      u.uScale.value = h / span;
      u.uOrtho.value = 1;
      return;
    }
    const persp = camera as THREE.PerspectiveCamera;
    const fov = persp.isPerspectiveCamera === true ? persp.fov : 50;
    u.uScale.value = (h * 0.5) / Math.tan((fov * Math.PI) / 360);
    u.uOrtho.value = 0;
  }

  dispose(): void {
    this.object.parent?.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object.userData.particleEmitter = null;
  }
}

/** 单位球面均匀随机方向 */
function randomDirection(out: THREE.Vector3): void {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out.set(Math.cos(t) * r, Math.sin(t) * r, z);
}
