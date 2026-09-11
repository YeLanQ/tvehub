// ---------------------------------------------------------------------------
// 粒子发射器：CPU 模拟（固定容量对象池）+ 实例化四边形渲染。
// 编辑器视口与播放器共用同一语义 —— 播放器侧镜像实现在
// public/engine/core/particles.mjs，修改任一侧须同步另一侧。
//
// 渲染形态（为何不用点图元）：WebGPU 的原生点图元固定 1 像素（three 文档明载
// "WebGPU only supports point primitives with 1 pixel size"），且 GL 点图元另有
// gl_PointSize 上限会裁掉大粒子。故统一用**实例化四边形**：基础几何为 ±0.5 的
// 单位四边形，逐实例属性只有 iPos(粒子中心) + iT(归一化寿命)，顶点着色器在视空间
// XY 平面展开（billboard）。后端只决定材质实现（GLSL / TSL），几何与缓冲区一致。
//
// 模拟规则（常规粒子系统子集）：
// - 发射：emissionRate 按帧累加取整发射；startDelay 后开始；非循环系统在
//   duration 后停止发射，粒子全部消亡即 finished；
// - 形状：cone（沿本地 -Z，与灯光/相机前向一致，底圆半径 + 半角内随机方向）/
//   sphere（球面外扩）/ hemisphere（上半球）/ box（盒内随机点沿 -Z）；
// - 积分：v += g·gravityModifier·dt（模拟空间 -Y），p += v·dt；
// - 模拟空间：local 粒子存节点本地坐标（随节点移动）；world 粒子存世界坐标
//   （节点移动后旧粒子留在原地），写缓冲时按节点世界矩阵逆变换回本地。
//
// 热点路径取舍（每帧 O(存活数)）：
// - 宿主世界矩阵/四元数/逆矩阵每帧只取一次，供全部粒子复用；
// - local 空间的模拟位置数组**就是**实例属性数组（零拷贝，省一次全量复制）；
// - 逐粒子只写 iPos(3) + iT(1)，颜色/尺寸插值全在着色器（含淡出），
//   比逐粒子写颜色+尺寸省 4 floats/粒子/帧；
// - 只上传存活区间（addUpdateRange）：alive << 容量时大幅减少缓冲上传量；
// - 预热按稳态解析初始化（O(容量) 一次），不逐步模拟（逐步预热在高发射率 +
//   长周期时会在主线程上卡顿）；
// - 包围球逐帧按存活粒子重算并开启视锥剔除，屏幕外的粒子系统零绘制开销。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  cloneParticleSystemSettings,
  particleStructureSignature,
  type ParticleRuntimeState,
  type ParticleSystemSettings,
} from "./types";
import {
  PARTICLE_GRAVITY,
  createGlslParticleMaterial,
  createQuadGeometry,
  getParticleSpriteTexture,
  type ParticleMaterial,
  type ParticleMaterialFactory,
} from "./particleMaterial";

/** 单帧最大推进步长（秒）：切标签页回来时不让粒子一次性爆发/穿越 */
export const MAX_STEP = 0.1;
/** 粒子实例网格子对象名（挂在节点对象下；同步器按名同步层，运行时按名寻回） */
export const PARTICLES_CHILD_NAME = "__particles";

// 复用临时对象（帧循环调用，避免每帧分配）
const _v = new THREE.Vector3();
/** 宿主世界四元数（world 模拟空间：每帧取一次，供本帧全部粒子发射复用） */
const _q = new THREE.Quaternion();
/** 宿主世界矩阵的逆（world 模拟空间：每帧取一次，供写缓冲复用） */
const _inv = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _rayInv = new THREE.Matrix4();
const _hit = new THREE.Vector3();

export class ParticleEmitter {
  /** 渲染对象（实例化四边形网格；挂到节点对象下，名 __particles） */
  readonly object: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;

  private settings: ParticleSystemSettings;
  private readonly cap: number;
  private readonly structureSig: string;
  private readonly material: ParticleMaterial;

  // —— 对象池（索引 [0, alive) 为存活粒子；死亡以尾交换回收）——
  /** 模拟位置：local 空间下**就是** iPos 属性数组（零拷贝）；world 空间为世界坐标 */
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  /** 寿命倒数（避免每帧每粒子一次除法） */
  private readonly invLife: Float32Array;
  private alive = 0;
  /** 满容量时的覆盖游标：轮转覆盖槽位（近似最旧），新粒子不被丢弃 */
  private spawnCursor = 0;

  // —— 渲染缓冲 ——
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly tAttr: THREE.InstancedBufferAttribute;

  // —— 播放状态 ——
  private time = 0;
  private acc = 0;
  private paused = false;
  /** stop() 后不再发射（存活粒子自然消亡）；play()/restart() 解除 */
  private emissionStopped = false;
  /** 待预热：建出/重启时置位，首次 update 时（宿主已挂好）按稳态解析初始化 */
  private pendingPrewarm = false;
  /** 本帧的宿主对象（world 模拟空间；update 里取一次，spawn/writeBuffers 复用） */
  private worldParent: THREE.Object3D | null = null;
  /**
   * 本发射器的包围球实例（每帧原地重写后交给 geometry）。
   * 必须每实例一份：geometry.boundingSphere 是各发射器独立持有的引用，
   * 共用同一个 Sphere 会让后更新者的范围覆盖其余发射器，视锥剔除随之出错。
   */
  private readonly bounds = new THREE.Sphere();
  /** 当前采样贴图（内置软圆点或已加载的用户贴图；冒烟测试/调试用） */
  private currentTexture: THREE.Texture;

  /**
   * @param settings 发射设置
   * @param materialFactory 材质工厂（按渲染后端注入；缺省经典 WebGL 的 GLSL 实现）
   */
  constructor(
    settings: ParticleSystemSettings,
    materialFactory: ParticleMaterialFactory = createGlslParticleMaterial,
  ) {
    this.settings = cloneParticleSystemSettings(settings);
    this.cap = Math.max(1, Math.round(settings.maxParticles));
    this.structureSig = particleStructureSignature(settings);
    const n = this.cap;

    const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const tAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    tAttr.setUsage(THREE.DynamicDrawUsage);
    this.posAttr = posAttr;
    this.tAttr = tAttr;

    const geometry = createQuadGeometry();
    geometry.setAttribute("iPos", posAttr);
    geometry.setAttribute("iT", tAttr);
    // 逐实例绘制的粒子数（等价于点图元的 drawRange）：每帧按存活数改写
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);

    this.material = materialFactory(this.settings);
    this.currentTexture = getParticleSpriteTexture();
    const mesh = new THREE.Mesh(geometry, this.material.material);
    mesh.name = PARTICLES_CHILD_NAME;
    mesh.userData.particleEmitter = this;
    // 包围球逐帧按存活粒子重算（见 updateBoundingSphere），故剔除是安全的
    mesh.frustumCulled = true;
    // 视口拾取：按粒子中心做阈值命中（基础四边形只有 ±0.5，直接走三角形求交
    // 会退化成"只能点中节点原点"，与点图元时期的手感不一致）
    mesh.raycast = (raycaster, intersects) => this.raycast(raycaster, intersects);
    this.object = mesh;

    // 模拟位置数组：local 空间与 iPos 属性数组同一份（模拟直接写渲染缓冲）
    this.pos =
      this.settings.simulationSpace === "world"
        ? new Float32Array(n * 3)
        : (posAttr.array as Float32Array);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.invLife = new Float32Array(n);

    this.pendingPrewarm = this.settings.prewarm && this.settings.looping;
  }

  /** 当前设置（只读副本语义：修改请走 setSettings） */
  get current(): ParticleSystemSettings {
    return this.settings;
  }

  /** 当前采样贴图（内置软圆点或已加载的用户贴图） */
  get texture(): THREE.Texture {
    return this.currentTexture;
  }

  /** 存活粒子数 */
  get aliveCount(): number {
    return this.alive;
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
    this.material.setSettings(this.settings);
    if (prevSpace !== next.simulationSpace) this.clear();
  }

  /**
   * 替换粒子贴图（null = 回到内置程序化软圆点）。贴图由调用方按 settings.texture
   * 异步加载后传入（编辑器 ParticleSystem / 播放器 runtime/particles.mjs），
   * 发射器不持有资产加载逻辑；贴图对象由调用方缓存与释放。
   */
  setTexture(tex: THREE.Texture | null): void {
    this.material.setTexture(tex);
    this.currentTexture = tex ?? getParticleSpriteTexture();
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
    this.spawnCursor = 0;
    this.object.geometry.instanceCount = 0;
  }

  /** 从头开始：清空粒子、时间归零、恢复发射（循环 + 预热系统在下一帧按稳态初始化） */
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

  // ===================== 每帧推进 =====================

  /**
   * 推进 dt 秒并写渲染缓冲。host 为节点对象（网格的父级）：world 模拟空间需要
   * 其世界矩阵做本地/世界互换；local 空间不读取宿主矩阵。
   */
  update(dt: number, host?: THREE.Object3D | null): void {
    if (this.paused) return;
    const step = dt > 0 && Number.isFinite(dt) ? Math.min(dt, MAX_STEP) : 0;
    const parent = host ?? this.object.parent ?? null;
    // 宿主世界变换每帧只取一次（world 空间下本帧全部粒子发射与写缓冲共用）
    this.worldParent = null;
    if (this.settings.simulationSpace === "world" && parent) {
      parent.updateWorldMatrix(true, false);
      _inv.copy(parent.matrixWorld).invert();
      parent.getWorldQuaternion(_q);
      this.worldParent = parent;
    }
    if (this.pendingPrewarm) {
      this.pendingPrewarm = false;
      this.prewarm();
    }
    if (step > 0) this.simulate(step);
    this.writeBuffers();
    this.updateBoundingSphere();
  }

  /**
   * 预热：按稳态**解析初始化**（O(容量) 一次），不逐步模拟。
   * 持续发射下存活粒子的年龄在 [0, 寿命) 均匀分布、粒数 ≈ 发射率 × 寿命，
   * 位置可由初速度与重力闭式积分直接给出 —— 等价于快进一个周期，但没有步进
   * 开销（逐步预热在高发射率 + 长周期时会在主线程上明显卡顿）。
   */
  private prewarm(): void {
    const s = this.settings;
    this.time = Math.max(this.time, s.startDelay);
    const want = Math.min(this.cap, Math.max(0, Math.round(s.emissionRate * s.startLifetime)));
    if (want <= 0) return;
    for (let i = 0; i < want; i++) {
      this.spawn(i, Math.random() * s.startLifetime);
    }
    this.alive = Math.max(this.alive, want);
  }

  /**
   * 单步推进：积分 + 老化回收 + 发射。
   * 宿主世界变换已由 update 取好（见 this.worldParent / 模块级 _q / _inv）。
   */
  private simulate(dt: number): void {
    const s = this.settings;

    // —— 已存活粒子：积分 + 老化 + 回收（尾交换保持 [0, alive) 连续） ——
    const g = -PARTICLE_GRAVITY * s.gravityModifier * dt;
    const pos = this.pos;
    const vel = this.vel;
    const age = this.age;
    const invLife = this.invLife;
    let i = 0;
    while (i < this.alive) {
      const a = age[i] + dt;
      if (a * invLife[i] >= 1) {
        this.recycle(i);
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
      if (this.alive < this.cap) {
        this.spawn(this.alive, Math.random() * dt);
        this.alive++;
      } else {
        // 满容量：轮转覆盖槽位（近似覆盖最旧），而不是丢弃新粒子 ——
        // 高发射率系统在满池时仍保持连续发射，视觉上不会"断流"
        this.spawn(this.spawnCursor, Math.random() * dt);
        this.spawnCursor = (this.spawnCursor + 1) % this.cap;
      }
    }
  }

  /** 尾交换回收第 i 个粒子（保持存活区间连续） */
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
      this.invLife[i] = this.invLife[last];
    }
    this.alive = last;
  }

  /**
   * 在指定槽位写入一个粒子：按形状取出生点与方向，并按 initialAge 闭式积分到位
   * （发射时传 [0, dt) 内随机值，使同帧粒子沿轨迹散开、低帧率不成串；预热时传
   *  [0, 寿命) 内随机值即稳态年龄分布）。world 空间经本帧缓存的宿主世界变换换算。
   */
  private spawn(slot: number, initialAge: number): void {
    const s = this.settings;
    const o = slot * 3;
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
    if (this.worldParent) {
      // 本地 → 世界：出生点经世界矩阵，方向经世界旋转（忽略缩放对方向的影响）
      _v.set(px, py, pz).applyMatrix4(this.worldParent.matrixWorld);
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
    // 闭式积分到 initialAge：常加速度下与半隐式欧拉仅差 O(dt)，视觉无差
    const g = -PARTICLE_GRAVITY * s.gravityModifier;
    const t = initialAge;
    this.pos[o] = px + vx * t + 0.5 * g * t * t;
    this.pos[o + 1] = py + vy * t + 0.5 * g * t * t;
    this.pos[o + 2] = pz + vz * t + 0.5 * g * t * t;
    this.vel[o] = vx;
    this.vel[o + 1] = vy + g * t;
    this.vel[o + 2] = vz;
    this.age[slot] = t;
    this.invLife[slot] = 1 / Math.max(0.001, s.startLifetime);
  }

  /**
   * 存活粒子 → 渲染缓冲：只写 iPos（local 空间已零拷贝在位，仅 world 空间需要
   * 逆变换回本地）与 iT（归一化寿命）。颜色/尺寸由着色器按 iT 插值。
   * 上传用 addUpdateRange 限定存活区间：alive << 容量时显著减少缓冲上传量
   * （three 默认整段上传；WebGL 与 WebGPU 后端都会消费 updateRanges 并在上传后清空）。
   */
  private writeBuffers(): void {
    const s = this.settings;
    const n = this.alive;
    const pa = this.posAttr.array as Float32Array;
    const tArray = this.tAttr.array as Float32Array;
    if (s.simulationSpace === "world" && this.worldParent) {
      // 逆矩阵已由 update 取好（每帧一次），这里只做逐粒子变换
      const pos = this.pos;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        _v.set(pos[o], pos[o + 1], pos[o + 2]).applyMatrix4(_inv);
        pa[o] = _v.x;
        pa[o + 1] = _v.y;
        pa[o + 2] = _v.z;
      }
    }
    const age = this.age;
    const invLife = this.invLife;
    for (let i = 0; i < n; i++) {
      const t = age[i] * invLife[i];
      tArray[i] = t < 1 ? t : 1;
    }
    this.object.geometry.instanceCount = n;
    if (n === 0) return;
    if (n < this.cap) {
      // 只上传存活区间：先清空再登记，避免"多帧未绘制（被剔除）"时范围逐帧累积；
      // 已死粒子的槽位在存活区间之外、不参与绘制，无需上传
      this.posAttr.clearUpdateRanges();
      this.tAttr.clearUpdateRanges();
      this.posAttr.addUpdateRange(0, n * 3);
      this.tAttr.addUpdateRange(0, n);
    }
    this.posAttr.needsUpdate = true;
    this.tAttr.needsUpdate = true;
  }

  /** 包围球按存活粒子重算（本地空间坐标；开启视锥剔除后屏幕外系统零绘制开销） */
  private updateBoundingSphere(): void {
    const n = this.alive;
    const geom = this.object.geometry;
    const sp = this.bounds;
    if (n === 0) {
      sp.center.set(0, 0, 0);
      sp.radius = 0;
      geom.boundingSphere = sp;
      return;
    }
    const pa = this.posAttr.array as Float32Array;
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
    sp.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    // 半径取半对角线 + 最大粒子半径（四边形角点可能超出粒子中心的包围盒）
    const half = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    sp.radius = half + this.settings.startSize * 0.75;
    // 同一实例每帧原地重写（本发射器独占；渲染期只读）
    geom.boundingSphere = sp;
  }

  /**
   * 视口拾取：按粒子中心做阈值命中（阈值同点图元时期的 raycaster.params.Points.threshold，
   * 默认 1 世界单位），返回最近的一枚粒子，使"点击粒子选中其节点"的手感保持。
   */
  private raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    const n = this.alive;
    if (n === 0) return;
    const threshold = raycaster.params?.Points?.threshold ?? 1;
    const thrSq = threshold * threshold;
    _rayInv.copy(this.object.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_rayInv);
    const pa = this.posAttr.array as Float32Array;
    let bestSq = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      _v.set(pa[o], pa[o + 1], pa[o + 2]);
      const d = _ray.distanceSqToPoint(_v);
      if (d <= thrSq && d < bestSq) {
        bestSq = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return;
    const o = bestIdx * 3;
    _hit.set(pa[o], pa[o + 1], pa[o + 2]).applyMatrix4(this.object.matrixWorld);
    intersects.push({
      distance: _hit.distanceTo(raycaster.ray.origin),
      point: _hit.clone(),
      object: this.object,
    });
    // 与其它物体的命中按距离重排（拾取按最近优先解析到节点）
    intersects.sort((a, b) => a.distance - b.distance);
  }

  dispose(): void {
    this.object.parent?.remove(this.object);
    this.object.geometry.dispose();
    this.material.dispose();
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
