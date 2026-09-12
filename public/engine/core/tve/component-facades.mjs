// ---------------------------------------------------------------------------
// 内置组件门面：RigidBody / Collider / AudioSource / AnimationClip / SkeletalAnimation
// RigidBody 直接经 state.host.physics 调用（不导入 engine-api，避免循环依赖）。
// ---------------------------------------------------------------------------
import { postLog } from "../log.mjs";
import { state, numOr } from "./state.mjs";
import { BuiltinComponent, LOOP_MODES, CONDITION_OPS } from "./component-base.mjs";

/** 刚体组件门面（只读信息 + 物理控制方法；运行时不可创建，编辑器挂载生效） */
class RigidBody extends BuiltinComponent {
  get mode() {
    return state.host?.physics?.bodyInfo(this.entity.id)?.mode ?? "dynamic";
  }
  get gravityScale() {
    return state.host?.physics?.bodyInfo(this.entity.id)?.gravityScale ?? 1;
  }
  get colliderCount() {
    return state.host?.physics?.bodyInfo(this.entity.id)?.colliderCount ?? 0;
  }
  setGravityScale(s) {
    state.host?.physics?.setGravityScale(this.entity.id, numOr(s, 1));
  }
  setLinearVelocity(x, y, z) {
    state.host?.physics?.setLinearVelocity(this.entity.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  }
  getLinearVelocity() {
    return state.host?.physics?.getLinearVelocity(this.entity.id) ?? null;
  }
  applyImpulse(x, y, z) {
    state.host?.physics?.applyImpulse(this.entity.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  }
  wakeUp() {
    state.host?.physics?.wakeUp(this.entity.id);
  }
}

/** 碰撞体组件门面（只读信息；形状/表面材质编辑在检查器进行，运行时不可变） */
class Collider extends BuiltinComponent {
  get shape() {
    return this.__json?.collider?.shape ?? "box";
  }
  get isSensor() {
    return this.__json?.collider?.isSensor === true;
  }
  get friction() {
    return numOr(this.__json?.collider?.friction, 0.6);
  }
  get restitution() {
    return numOr(this.__json?.collider?.restitution, 0.1);
  }
  get count() {
    return state.host?.physics?.bodyInfo(this.entity.id)?.colliderCount ?? 0;
  }
}

/** 音源组件门面：播放控制按组件 id 寻址；设置写入经运行时后端合并生效 */
class AudioSource extends BuiltinComponent {
  __key() {
    return this.__json && typeof this.__json.id === "string" ? this.__json.id : this.entity.id;
  }
  __settings() {
    return this.__json && typeof this.__json.audio === "object" ? this.__json.audio : null;
  }
  __update(patch) {
    state.host?.audios?.updateSettings(this.__key(), patch);
  }
  get source() {
    return this.__settings()?.source ?? "";
  }
  set source(v) {
    if (typeof v === "string") this.__update({ source: v });
  }
  get autoplay() {
    return this.__settings()?.autoplay !== false;
  }
  set autoplay(v) {
    this.__update({ autoplay: v === true });
  }
  get loop() {
    return this.__settings()?.loop !== false;
  }
  set loop(v) {
    this.__update({ loop: v === true });
  }
  get volume() {
    return numOr(this.__settings()?.volume, 1);
  }
  set volume(v) {
    const n = Number(v);
    if (Number.isFinite(n)) this.__update({ volume: Math.min(1, Math.max(0, n)) });
  }
  get speed() {
    return numOr(this.__settings()?.speed, 1);
  }
  set speed(v) {
    const n = Number(v);
    if (Number.isFinite(n)) this.__update({ speed: Math.min(4, Math.max(0.1, n)) });
  }
  get spatial() {
    return this.__settings()?.spatial === "3d" ? "3d" : "2d";
  }
  set spatial(v) {
    this.__update({ spatial: v === "3d" ? "3d" : "2d" });
  }
  get playing() {
    return state.host?.audios?.infoOf(this.__key())?.playing ?? false;
  }
  get paused() {
    return state.host?.audios?.infoOf(this.__key())?.paused ?? false;
  }
  get ready() {
    return state.host?.audios?.infoOf(this.__key())?.ready ?? false;
  }
  play() {
    state.host?.audios?.play(this.__key());
  }
  stop() {
    state.host?.audios?.stop(this.__key());
  }
  pause() {
    state.host?.audios?.pause(this.__key());
  }
  resume() {
    state.host?.audios?.resume(this.__key());
  }
  setVolume(v) {
    state.host?.audios?.setVolume(this.__key(), v);
  }
}

/** 关键帧动画剪辑组件门面（.anim 资产绑定 + 播放控制/进度/倍速） */
class AnimationClip extends BuiltinComponent {
  __key() {
    return this.__json && typeof this.__json.id === "string" ? this.__json.id : this.entity.id;
  }
  __b() {
    return state.host?.clipAnims?.bindingOf(this.__key()) ?? null;
  }
  get clip() {
    return this.__b()?.clipPath ?? "";
  }
  set clip(rel) {
    void state.host?.clipAnims?.changeClip(this.__b(), rel);
  }
  get duration() {
    return this.__b()?.clip?.duration ?? 0;
  }
  get time() {
    return this.__b()?.time ?? 0;
  }
  set time(v) {
    state.host?.clipAnims?.setTime(this.__b(), v);
  }
  get speed() {
    return this.__b()?.speed ?? 1;
  }
  set speed(v) {
    state.host?.clipAnims?.setSpeed(this.__b(), v);
  }
  get loop() {
    return this.__b()?.loop ?? true;
  }
  set loop(v) {
    state.host?.clipAnims?.setLoop(this.__b(), v === true);
  }
  get autoplay() {
    return this.__b()?.autoplay ?? true;
  }
  set autoplay(v) {
    state.host?.clipAnims?.setAutoplay(this.__b(), v === true);
  }
  get playing() {
    return this.__b()?.playing ?? false;
  }
  get paused() {
    return this.__b()?.paused ?? false;
  }
  play() {
    state.host?.clipAnims?.play(this.__b());
  }
  pause() {
    state.host?.clipAnims?.pause(this.__b());
  }
  resume() {
    state.host?.clipAnims?.resume(this.__b());
  }
  stop() {
    state.host?.clipAnims?.stop(this.__b());
  }
}

/** 骨骼动画（模型内嵌动画）门面 */
class SkeletalAnimation extends BuiltinComponent {
  __b() {
    return state.host?.animations?.bindingOf(this.entity.id) ?? null;
  }
  get clips() {
    return state.host?.animations?.clipsOf(this.entity.id) ?? [];
  }
  get currentClip() {
    return this.__b()?.currentClip ?? null;
  }
  get playing() {
    return this.__b()?.playing ?? false;
  }
  get clip() {
    return this.currentClip ?? "";
  }
  set clip(name) {
    this.play(name);
  }
  get speed() {
    return numOr(this.__b()?.nodeJson?.anim?.speed, 1);
  }
  set speed(v) {
    state.host?.animations?.setSpeed(this.entity.id, v);
  }
  get loop() {
    const v = this.__b()?.nodeJson?.anim?.loop;
    return LOOP_MODES.includes(v) ? v : "loop";
  }
  set loop(v) {
    state.host?.animations?.setLoop(this.entity.id, v);
  }
  get autoplay() {
    return this.__b()?.nodeJson?.anim?.autoplay !== false;
  }
  set autoplay(v) {
    state.host?.animations?.setAutoplay(this.entity.id, v === true);
  }
  get hasGraph() {
    return !!this.__b()?.graph;
  }
  get graph() {
    return this.__b()?.graph ?? null;
  }
  play(clipOrState) {
    state.host?.animations?.play(
      this.entity.id,
      typeof clipOrState === "string" && clipOrState ? clipOrState : undefined,
    );
  }
  pause() {
    state.host?.animations?.pause(this.entity.id);
  }
  resume() {
    state.host?.animations?.resume(this.entity.id);
  }
  stop() {
    state.host?.animations?.stop(this.entity.id);
  }
  getParam(name) {
    const g = this.graph;
    if (!g || typeof name !== "string" || !(name in g.params)) return null;
    return g.params[name];
  }
  setParam(name, value) {
    state.host?.animations?.setParam(this.entity.id, name, value);
  }
  ensureGraph(def) {
    return state.host?.animations?.applyGraph(this.entity.id, def) === true;
  }
  removeGraph() {
    state.host?.animations?.removeGraph(this.entity.id);
  }
  addState(opts) {
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
      loop: LOOP_MODES.includes(opts.loop) ? opts.loop : "loop",
    });
    return true;
  }
  removeState(name) {
    const g = this.graph;
    if (!g || typeof name !== "string") return false;
    const i = g.states.findIndex((s) => s.name === name);
    if (i < 0) return false;
    g.states.splice(i, 1);
    g.transitions = g.transitions.filter((t) => t.from !== name && t.to !== name);
    return true;
  }
  addTransition(opts) {
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
    const num = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
    g.transitions.push({
      id,
      from,
      to,
      duration: Math.max(0, num(opts.duration, 0.25)),
      exitTime: Math.max(0, Math.min(1, num(opts.exitTime, 0))),
      conditions: (Array.isArray(opts.conditions) ? opts.conditions : [])
        .filter((c) => !!c && typeof c === "object" && typeof c.param === "string" && c.param)
        .map((c) => ({
          param: c.param,
          op: CONDITION_OPS.includes(c.op) ? c.op : "==",
          value: num(c.value, 0),
        })),
    });
    return true;
  }
  removeTransition(id) {
    const g = this.graph;
    if (!g || typeof id !== "string") return false;
    const i = g.transitions.findIndex((t) => t.id === id);
    if (i < 0) return false;
    g.transitions.splice(i, 1);
    return true;
  }
}

export { RigidBody, Collider, AudioSource, AnimationClip, SkeletalAnimation };