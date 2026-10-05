// ---------------------------------------------------------------------------
// 内置组件门面：RigidBody / Collider / AudioSource / AnimationClip / SkeletalAnimation
// RigidBody 直接经 state.host.physics 调用（不导入 engine-api，避免循环依赖）。
// ---------------------------------------------------------------------------
import { state, numOr } from "./state";
import type { AnimGraph, ClipBinding, ComponentJson } from "./state";
import { BuiltinComponent, LOOP_MODES, CONDITION_OPS } from "./component-base";
import type { AudioSettings } from "./component-base";
import type { Entity } from "./entity";

/** 碰撞体 JSON 段（编辑器序列化；门面只读） */
type ColliderJsonView = {
  shape?: string;
  isSensor?: boolean;
  friction?: number;
  restitution?: number;
};

/** collider JSON 段读取（模块级助手：不改变门面类的运行时成员形状） */
function colliderJsonOf(json: ComponentJson | null): ColliderJsonView | null {
  const c = json?.collider;
  // 断言安全：collider 段由编辑器序列化产出，形状固定为 {shape,isSensor,friction,restitution}
  return c && typeof c === "object" ? (c as ColliderJsonView) : null;
}

/** 刚体组件门面（只读信息 + 物理控制方法；运行时不可创建，编辑器挂载生效） */
class RigidBody extends BuiltinComponent {
  get mode(): string {
    return state.host?.physics?.bodyInfo(this.entity.id)?.mode ?? "dynamic";
  }
  get gravityScale(): number {
    return state.host?.physics?.bodyInfo(this.entity.id)?.gravityScale ?? 1;
  }
  get colliderCount(): number {
    return state.host?.physics?.bodyInfo(this.entity.id)?.colliderCount ?? 0;
  }
  setGravityScale(s: unknown): void {
    state.host?.physics?.setGravityScale(this.entity.id, numOr(s, 1));
  }
  setLinearVelocity(x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.setLinearVelocity(this.entity.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  }
  getLinearVelocity() {
    return state.host?.physics?.getLinearVelocity(this.entity.id) ?? null;
  }
  applyImpulse(x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.applyImpulse(this.entity.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  }
  wakeUp(): void {
    state.host?.physics?.wakeUp(this.entity.id);
  }
}

/** 碰撞体组件门面（只读信息；形状/表面材质编辑在检查器进行，运行时不可变） */
class Collider extends BuiltinComponent {
  get shape(): string {
    return colliderJsonOf(this.__json)?.shape ?? "box";
  }
  get isSensor(): boolean {
    return colliderJsonOf(this.__json)?.isSensor === true;
  }
  get friction(): number {
    return numOr(colliderJsonOf(this.__json)?.friction, 0.6);
  }
  get restitution(): number {
    return numOr(colliderJsonOf(this.__json)?.restitution, 0.1);
  }
  get count(): number {
    return state.host?.physics?.bodyInfo(this.entity.id)?.colliderCount ?? 0;
  }
}

/** 音源组件门面：播放控制按组件 id 寻址；设置写入经运行时后端合并生效 */
class AudioSource extends BuiltinComponent {
  __key(): string {
    return this.__json && typeof this.__json.id === "string" ? this.__json.id : this.entity.id;
  }
  __settings(): AudioSettings | null {
    // 断言安全：audio 段由 audioSettingsFrom 产出/场景 JSON 收敛
    return this.__json && typeof this.__json.audio === "object"
      ? (this.__json.audio as AudioSettings)
      : null;
  }
  __update(patch: Record<string, unknown>): void {
    state.host?.audios?.updateSettings(this.__key(), patch);
  }
  get source(): string {
    return this.__settings()?.source ?? "";
  }
  set source(v: string) {
    if (typeof v === "string") this.__update({ source: v });
  }
  get autoplay(): boolean {
    return this.__settings()?.autoplay !== false;
  }
  set autoplay(v: boolean) {
    this.__update({ autoplay: v === true });
  }
  get loop(): boolean {
    return this.__settings()?.loop !== false;
  }
  set loop(v: boolean) {
    this.__update({ loop: v === true });
  }
  get volume(): number {
    return numOr(this.__settings()?.volume, 1);
  }
  set volume(v: number) {
    const n = Number(v);
    if (Number.isFinite(n)) this.__update({ volume: Math.min(1, Math.max(0, n)) });
  }
  get speed(): number {
    return numOr(this.__settings()?.speed, 1);
  }
  set speed(v: number) {
    const n = Number(v);
    if (Number.isFinite(n)) this.__update({ speed: Math.min(4, Math.max(0.1, n)) });
  }
  get spatial(): string {
    return this.__settings()?.spatial === "3d" ? "3d" : "2d";
  }
  set spatial(v: string) {
    this.__update({ spatial: v === "3d" ? "3d" : "2d" });
  }
  get playing(): boolean {
    return state.host?.audios?.infoOf(this.__key())?.playing ?? false;
  }
  get paused(): boolean {
    return state.host?.audios?.infoOf(this.__key())?.paused ?? false;
  }
  get ready(): boolean {
    return state.host?.audios?.infoOf(this.__key())?.ready ?? false;
  }
  play(): void {
    state.host?.audios?.play(this.__key());
  }
  stop(): void {
    state.host?.audios?.stop(this.__key());
  }
  pause(): void {
    state.host?.audios?.pause(this.__key());
  }
  resume(): void {
    state.host?.audios?.resume(this.__key());
  }
  setVolume(v: number): void {
    state.host?.audios?.setVolume(this.__key(), v);
  }
}

/** 关键帧动画剪辑组件门面（.anim 资产绑定 + 播放控制/进度/倍速） */
class AnimationClip extends BuiltinComponent {
  __key(): string {
    return this.__json && typeof this.__json.id === "string" ? this.__json.id : this.entity.id;
  }
  __b(): ClipBinding | null {
    return state.host?.clipAnims?.bindingOf(this.__key()) ?? null;
  }
  get clip(): string {
    return this.__b()?.clipPath ?? "";
  }
  set clip(rel: string) {
    void state.host?.clipAnims?.changeClip(this.__b(), rel);
  }
  get duration(): number {
    return this.__b()?.clip?.duration ?? 0;
  }
  get time(): number {
    return this.__b()?.time ?? 0;
  }
  set time(v: number) {
    state.host?.clipAnims?.setTime(this.__b(), v);
  }
  get speed(): number {
    return this.__b()?.speed ?? 1;
  }
  set speed(v: number) {
    state.host?.clipAnims?.setSpeed(this.__b(), v);
  }
  get loop(): boolean {
    return this.__b()?.loop ?? true;
  }
  set loop(v: boolean) {
    state.host?.clipAnims?.setLoop(this.__b(), v === true);
  }
  get autoplay(): boolean {
    return this.__b()?.autoplay ?? true;
  }
  set autoplay(v: boolean) {
    state.host?.clipAnims?.setAutoplay(this.__b(), v === true);
  }
  get playing(): boolean {
    return this.__b()?.playing ?? false;
  }
  get paused(): boolean {
    return this.__b()?.paused ?? false;
  }
  play(): void {
    state.host?.clipAnims?.play(this.__b());
  }
  pause(): void {
    state.host?.clipAnims?.pause(this.__b());
  }
  resume(): void {
    state.host?.clipAnims?.resume(this.__b());
  }
  stop(): void {
    state.host?.clipAnims?.stop(this.__b());
  }
}

/** 骨骼动画（模型内嵌动画）门面 */
class SkeletalAnimation extends BuiltinComponent {
  __b() {
    return state.host?.animations?.bindingOf(this.entity.id) ?? null;
  }
  get clips(): string[] {
    return state.host?.animations?.clipsOf(this.entity.id) ?? [];
  }
  get currentClip(): string | null {
    return this.__b()?.currentClip ?? null;
  }
  get playing(): boolean {
    return this.__b()?.playing ?? false;
  }
  get clip(): string {
    return this.currentClip ?? "";
  }
  set clip(name: string) {
    this.play(name);
  }
  get speed(): number {
    return numOr(this.__b()?.nodeJson?.anim?.speed, 1);
  }
  set speed(v: number) {
    state.host?.animations?.setSpeed(this.entity.id, v);
  }
  get loop(): string {
    const v = this.__b()?.nodeJson?.anim?.loop;
    // 断言安全：includes 命中即 v 为 loop/once/pingpong 之一；未命中回默认 "loop"
    return LOOP_MODES.includes(v as string) ? (v as string) : "loop";
  }
  set loop(v: string) {
    state.host?.animations?.setLoop(this.entity.id, v);
  }
  get autoplay(): boolean {
    return this.__b()?.nodeJson?.anim?.autoplay !== false;
  }
  set autoplay(v: boolean) {
    state.host?.animations?.setAutoplay(this.entity.id, v === true);
  }
  get hasGraph(): boolean {
    return !!this.__b()?.graph;
  }
  get graph(): AnimGraph | null {
    return this.__b()?.graph ?? null;
  }
  play(clipOrState?: string): void {
    state.host?.animations?.play(
      this.entity.id,
      typeof clipOrState === "string" && clipOrState ? clipOrState : undefined,
    );
  }
  pause(): void {
    state.host?.animations?.pause(this.entity.id);
  }
  resume(): void {
    state.host?.animations?.resume(this.entity.id);
  }
  stop(): void {
    state.host?.animations?.stop(this.entity.id);
  }
  getParam(name: string): number | boolean | null {
    const g = this.graph;
    if (!g || typeof name !== "string" || !(name in g.params)) return null;
    return g.params[name];
  }
  setParam(name: string, value: number | boolean): void {
    state.host?.animations?.setParam(this.entity.id, name, value);
  }
  ensureGraph(def: unknown): boolean {
    return state.host?.animations?.applyGraph(this.entity.id, def) === true;
  }
  removeGraph(): void {
    state.host?.animations?.removeGraph(this.entity.id);
  }
  addState(opts: { name?: unknown; clip?: unknown; speed?: unknown; loop?: string } | null | undefined): boolean {
    const g = this.graph;
    if (!g || !opts || typeof opts !== "object") return false;
    const name = typeof opts.name === "string" ? opts.name.trim() : "";
    if (!name || g.states.some((s) => s.name === name)) return false;
    g.states.push({
      name,
      clip: typeof opts.clip === "string" ? opts.clip : "",
      speed:
        typeof opts.speed === "number" && Number.isFinite(opts.speed) && opts.speed >= 0
          ? opts.speed
          : 1,
      // 断言安全：非字符串 loop 使 includes 恒为 false，回默认 "loop"
      loop: LOOP_MODES.includes(opts.loop as string) ? opts.loop : "loop",
    });
    return true;
  }
  removeState(name: unknown): boolean {
    const g = this.graph;
    if (!g || typeof name !== "string") return false;
    const i = g.states.findIndex((s) => s.name === name);
    if (i < 0) return false;
    g.states.splice(i, 1);
    g.transitions = g.transitions.filter((t) => t.from !== name && t.to !== name);
    return true;
  }
  addTransition(opts: {
    id?: unknown;
    from?: unknown;
    to?: unknown;
    duration?: unknown;
    exitTime?: unknown;
    conditions?: unknown;
  } | null | undefined): boolean {
    const g = this.graph;
    if (!g || !opts || typeof opts !== "object") return false;
    const from = typeof opts.from === "string" ? opts.from : "";
    const to = typeof opts.to === "string" ? opts.to : "";
    if (
      !from ||
      !to ||
      from === to ||
      !g.states.some((s) => s.name === from) ||
      !g.states.some((s) => s.name === to)
    ) {
      return false;
    }
    let id = typeof opts.id === "string" && opts.id && !g.transitions.some((t) => t.id === opts.id)
      ? opts.id
      : "";
    if (!id) {
      let n = g.transitions.length + 1;
      while (g.transitions.some((t) => t.id === `t${n}`)) n += 1;
      id = `t${n}`;
    }
    const num = (v: unknown, fb: number): number =>
      typeof v === "number" && Number.isFinite(v) ? v : fb;
    g.transitions.push({
      id,
      from,
      to,
      duration: Math.max(0, num(opts.duration, 0.25)),
      exitTime: Math.max(0, Math.min(1, num(opts.exitTime, 0))),
      conditions: (Array.isArray(opts.conditions) ? opts.conditions : [])
        // 谓词声明 op 为 string 供 includes/收敛签名使用；非法值由 includes 兜底回 "=="
        .filter((c): c is { param: string; op: string; value: unknown } =>
          !!c && typeof c === "object" && typeof c.param === "string" && c.param)
        .map((c) => ({
          param: c.param,
          op: CONDITION_OPS.includes(c.op) ? c.op : "==",
          value: num(c.value, 0),
        })),
    });
    return true;
  }
  removeTransition(id: unknown): boolean {
    const g = this.graph;
    if (!g || typeof id !== "string") return false;
    const i = g.transitions.findIndex((t) => t.id === id);
    if (i < 0) return false;
    g.transitions.splice(i, 1);
    return true;
  }

  // —— 蒙皮完全控制（对应 three 官网 animation/skinning 系列示例）——

  /** 蒙皮能力摘要（{boneCount, boneNames, morphMeshes}；未绑定模型 null） */
  get skinInfo() {
    return state.host?.animations?.skinInfoOf(this.entity.id) ?? null;
  }

  // —— 动作级控制（blending/morph：权重混合/淡入淡出/一次性动作/全局速度/事件）——

  /** 动作权重（确保动作在播；0 即静默层。与 play/stop 的 currentClip 语义独立） */
  setWeight(clip: string, w: number): boolean {
    return state.host?.animations?.setWeight(this.entity.id, clip, w) === true;
  }
  /** 动作当前有效权重（淡入淡出进行中的实时值） */
  getWeight(clip: string): number | null {
    return state.host?.animations?.getWeight(this.entity.id, clip) ?? null;
  }
  fadeIn(clip: string, dur = 0.25): boolean {
    return state.host?.animations?.fadeIn(this.entity.id, clip, dur) === true;
  }
  fadeOut(clip: string, dur = 0.25): boolean {
    return state.host?.animations?.fadeOut(this.entity.id, clip, dur) === true;
  }
  /** 交叉淡化 from→to（warp=true 自动对齐相位） */
  crossFade(from: string, to: string, dur = 0.25, warp = false): boolean {
    return state.host?.animations?.crossFade(this.entity.id, from, to, dur, warp) === true;
  }
  /** 单动作播放速度（与 globalSpeed 相乘生效） */
  setActionSpeed(clip: string, scale: number): boolean {
    return state.host?.animations?.setActionSpeed(this.entity.id, clip, scale) === true;
  }
  /** 单动作循环模式（"loop"/"once"/"pingpong"；once 定格末帧） */
  setActionLoop(clip: string, mode: string): boolean {
    return state.host?.animations?.setActionLoop(this.entity.id, clip, mode) === true;
  }
  /** 停止单个动作（不影响其他混合层） */
  stopAction(clip: string): boolean {
    return state.host?.animations?.stopAction(this.entity.id, clip) === true;
  }
  /** 一次性动作：定格末帧后自动淡回基础动作（表情/挥手等） */
  playOneShot(clip: string, fade = 0.25): boolean {
    return state.host?.animations?.playOneShot(this.entity.id, clip, fade) === true;
  }
  /** 全局播放速度（mixer 速度） */
  globalSpeed(scale: number): boolean {
    return state.host?.animations?.globalSpeed(this.entity.id, scale) === true;
  }
  /** 订阅动作播完事件（负载 {clip}），返回注销函数 */
  onFinished(cb: (e: { clip: string }) => void): () => void {
    return state.host?.animations?.onFinished(this.entity.id, cb) ?? (() => {});
  }
  /** 订阅动作循环事件（负载 {clip}），返回注销函数 */
  onLoop(cb: (e: { clip: string }) => void): () => void {
    return state.host?.animations?.onLoop(this.entity.id, cb) ?? (() => {});
  }

  // —— 加法层（additive_blending：独立权重叠加在基础动作之上）——

  playAdditive(clip: string, weight = 1): boolean {
    return state.host?.animations?.playAdditive(this.entity.id, clip, weight) === true;
  }
  stopAdditive(clip: string): boolean {
    return state.host?.animations?.stopAdditive(this.entity.id, clip) === true;
  }

  // —— 骨骼级控制（本地变换读写/复位/世界坐标）——

  /** 骨骼名列表（无骨骼返回 []） */
  get bones(): string[] {
    return state.host?.animations?.bonesOf(this.entity.id) ?? [];
  }
  /** 骨骼层级（[{name,parent,children}]） */
  get boneHierarchy() {
    return state.host?.animations?.boneHierarchy(this.entity.id) ?? [];
  }
  /** 骨骼本地变换快照（rotation 为度制欧拉；未命中 null） */
  getBoneTransform(name: string) {
    return state.host?.animations?.getBoneTransform(this.entity.id, name) ?? null;
  }
  setBonePosition(name: string, x: number, y: number, z: number): boolean {
    return state.host?.animations?.setBonePosition(this.entity.id, name, x, y, z) === true;
  }
  setBoneRotation(name: string, x: number, y: number, z: number): boolean {
    return state.host?.animations?.setBoneRotation(this.entity.id, name, x, y, z) === true;
  }
  setBoneScale(name: string, x: number, y: number, z: number): boolean {
    return state.host?.animations?.setBoneScale(this.entity.id, name, x, y, z) === true;
  }
  resetBone(name: string): boolean {
    return state.host?.animations?.resetBone(this.entity.id, name) === true;
  }
  /** 复位全部骨骼到绑定姿势 */
  resetPose(): boolean {
    return state.host?.animations?.resetPose(this.entity.id) === true;
  }
  /** 骨骼世界坐标（attach 物体/瞄准参考；未命中 null） */
  getBoneWorldPosition(name: string) {
    return state.host?.animations?.getBoneWorldPosition(this.entity.id, name) ?? null;
  }

  // —— 形态键（morph：表情/姿态权重）——

  /** 形态键清单（[{mesh, targets}]） */
  get morphs() {
    return state.host?.animations?.morphsOf(this.entity.id) ?? [];
  }
  setMorphWeight(mesh: string, target: string, v: number): boolean {
    return state.host?.animations?.setMorphWeight(this.entity.id, mesh, target, v) === true;
  }
  getMorphWeight(mesh: string, target: string): number | null {
    return state.host?.animations?.getMorphWeight(this.entity.id, mesh, target) ?? null;
  }

  // —— IK（skinning_ik：CCD 求解，目标点/关节限位）——

  /**
   * 注册 IK 链：{ name?, effector: 骨骼名, links: [{bone, rotationMin?,
   * rotationMax?}], iteration? }（限位为度制欧拉数组）。返回 IK id，失败 null。
   */
  addIK(def: unknown): string | null {
    const id = state.host?.animations?.addIK(this.entity.id, def);
    return typeof id === "string" ? id : null;
  }
  removeIK(id: string): boolean {
    return state.host?.animations?.removeIK(this.entity.id, id) === true;
  }
  setIKEnabled(id: string, v: boolean): boolean {
    return state.host?.animations?.setIKEnabled(this.entity.id, id, v) === true;
  }
  setIKTargetPosition(id: string, x: number, y: number, z: number): boolean {
    return state.host?.animations?.setIKTargetPosition(this.entity.id, id, x, y, z) === true;
  }
  getIKTargetPosition(id: string) {
    return state.host?.animations?.getIKTargetPosition(this.entity.id, id) ?? null;
  }
  /** IK 清单（[{id,name,effector,enabled}]） */
  get iks() {
    return state.host?.animations?.iksOf(this.entity.id) ?? [];
  }

  // —— 骨骼/IK 目标绑定（物体跟随骨骼；官方 ik 示例挂点语义）——

  /**
   * 把场景节点绑到骨骼/IK 目标上每帧跟随。
   * target 为 Entity 或节点 id（须在模型子树之外）；bone 传骨骼名、IK id 或
   * IK name；opts = { keepOffset?, syncRotation?, syncScale? }。
   */
  attachToBone(target: Entity | string, bone: string, opts: unknown): boolean {
    const targetId = target && typeof target === "object" ? target.id : target;
    const entry = typeof targetId === "string"
      ? (state.host?.registry ?? []).find((r) => r.json && r.json.id === targetId)
      : null;
    if (!entry) return false;
    return state.host?.animations?.attachObject(this.entity.id, entry.obj, bone, opts) === true;
  }
  /** 解除节点绑定（target 为 Entity 或节点 id） */
  detach(target: Entity | string): boolean {
    const targetId = target && typeof target === "object" ? target.id : target;
    if (typeof targetId !== "string" || !targetId) return false;
    const entry = (state.host?.registry ?? []).find((r) => r.json && r.json.id === targetId);
    if (!entry) return false;
    return state.host?.animations?.detachObject(this.entity.id, entry.obj) === true;
  }
  /** 绑定清单（[{node, bone, syncRotation, syncScale, keepOffset}]） */
  get attachments() {
    return state.host?.animations?.attachmentsOf(this.entity.id) ?? [];
  }
}

export { RigidBody, Collider, AudioSource, AnimationClip, SkeletalAnimation };
