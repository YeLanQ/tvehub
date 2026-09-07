// ---------------------------------------------------------------------------
// 音频系统（引擎模块）：驱动音源节点（AudioNode）的 Web Audio 播放。
//
// 设计要点（与 AnimationSystem 同构）：
// - 绑定按节点 id 索引：引擎在节点入图/属性变化时把「节点数据 + 场景对象」交给
//   syncNode，系统按设置差异驱动（改音量/循环/倍速不重启播放；换源/切空间化才
//   重建音源对象）；场景重建（节点对象重建）时整个重绑；
// - 两级形态：2D 全局音源（THREE.Audio，背景乐/UI 音效）与 3D 位置音源
//   （THREE.PositionalAudio，挂节点对象下随变换/距离衰减）；
// - 监听器（THREE.AudioListener）随活动渲染相机（引擎每帧接线，预览切换相机
//   时自动跟随）；音频解码缓冲按资产引用缓存（资产改写可 invalidate）；
// - 浏览器自动播放策略：AudioContext 需用户手势解锁——首次播放尝试与
//   ensureGestureResume 安装的一次性手势监听都会 resume；解锁后 autoplay
//   绑定自动起播；
// - 运行时控制（播放/暂停/停止）不落盘，只影响本会话；节点数据
//   （autoplay/loop/volume/speed/spatial…）才随场景序列化；
// - 节点层级不可见（active/visible 链断开）时自动暂停，恢复可见后续播。
//   注：three 的 Audio 暂停后用 play() 从 offset 续播（无独立 resume 接口）。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import {
  parseAudioSettings,
  type AudioRuntimeState,
  type AudioSourceSettings,
} from "./types";

/** syncNode 需要的节点形状（避免依赖具体节点类；AudioNode 结构满足） */
export interface AudioEmitterNode {
  id: string;
  audio: AudioSourceSettings;
}

type AudioChangeListener = (nodeId: string) => void;

/** 设置签名（数据 → 运行时差异应用；换源/切空间化才重建音源对象） */
function settingsSig(s: AudioSourceSettings): string {
  return [
    s.source,
    s.spatial,
    s.autoplay,
    s.loop,
    s.volume,
    s.speed,
    s.refDistance,
    s.maxDistance,
    s.rolloff,
  ].join("|");
}

/** 2D/3D 音源对象的公共形状（Audio<GainNode> 与 PositionalAudio=Audio<PannerNode> 的公共父型） */
type AudioEmitter = THREE.Audio<AudioNode>;

interface Binding {
  nodeId: string;
  /** 节点的场景对象（3D 音源挂在它下面继承变换） */
  obj: THREE.Object3D;
  objUuid: string;
  /** 最近一次应用的数据签名 */
  sig: string;
  settings: AudioSourceSettings;
  /** 音源对象（缓冲就绪并创建后非空） */
  emitter: AudioEmitter | null;
  loading: boolean;
  ready: boolean;
  error: string | null;
  playing: boolean;
  paused: boolean;
  /** 暂停处播放进度（秒；续播用） */
  offset: number;
  /** 本次绑定已起播过（autoplay 只kick一次；一次性播完不自动重播） */
  started: boolean;
  /** 手动停止（autoplay 不再自动起播；play() 清除） */
  userStopped: boolean;
  /** 因节点不可见自动暂停（恢复可见后自动续播） */
  autoPaused: boolean;
}

export class AudioSystem {
  private bindings = new Map<string, Binding>();
  private listeners = new Set<AudioChangeListener>();
  /** 音频解码缓冲缓存（key = rel；失败缓存为 null 结果，invalidate 清除后可重试） */
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** 资产相对路径 → 可请求 URL（应用层按项目根注入） */
  private urlResolver: ((rel: string) => string | null) | null = null;
  /** 监听器（惰性创建；随活动渲染相机） */
  private listener: THREE.AudioListener | null = null;
  /** 监听器当前宿主相机 */
  private listenerHost: THREE.Camera | null = null;
  /** 手势解锁监听是否已安装 */
  private gestureInstalled = false;

  onChange(l: AudioChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(nodeId: string): void {
    for (const l of this.listeners) l(nodeId);
  }

  /** 注入音频 URL 解析器（应用层项目打开时接线；null = 断开。缓冲缓存一并清除） */
  setUrlResolver(fn: ((rel: string) => string | null) | null): void {
    this.urlResolver = fn;
    this.buffers.clear();
    // 解析器变化后旧 URL 全部失效：既有绑定按新解析器重载
    for (const b of [...this.bindings.values()]) this.reloadSource(b, b.settings);
  }

  /** 监听器随活动渲染相机（每帧接线；相机变化时才重新挂载） */
  attachListener(camera: THREE.Camera): void {
    if (this.listenerHost === camera) return;
    if (this.listener) this.listener.removeFromParent();
    if (!this.listener) this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.listenerHost = camera;
  }

  /** Web Audio 上下文（惰性创建全局共享上下文；无 AudioContext 环境返回 null）。
   *  @types/three 的 AudioContext.getContext 返回类型有误（解析到类自身），按 DOM 类型断言 */
  private context(): AudioContext | null {
    try {
      return THREE.AudioContext.getContext() as unknown as AudioContext;
    } catch {
      return null;
    }
  }

  /** 解锁音频上下文（浏览器自动播放策略：须在用户手势内调用）；解锁后 autoplay 起播 */
  resumeContext(): void {
    const ctx = this.context();
    if (!ctx || ctx.state !== "suspended") return;
    void ctx
      .resume()
      .then(() => this.applyAutoplay())
      .catch(() => {});
  }

  /** 上下文解锁后补起 autoplay 绑定（解锁前 startIfReady 均被挂起） */
  private applyAutoplay(): void {
    for (const b of [...this.bindings.values()]) {
      if (b.settings.autoplay && !b.userStopped && !b.playing) this.startIfReady(b);
    }
  }

  /**
   * 挂起/恢复整个音频上下文：编辑器后台渲染暂停（预览/脚本面板接管）时静音
   * 全部编辑器音源（进度保留），避免与网页预览面板的音频叠加；恢复渲染时
   * 解除挂起并补起 autoplay 绑定。
   */
  setSuspended(suspended: boolean): void {
    const ctx = this.context();
    if (!ctx) return;
    if (suspended && ctx.state === "running") void ctx.suspend().catch(() => {});
    else if (!suspended && ctx.state === "suspended") {
      void ctx
        .resume()
        .then(() => this.applyAutoplay())
        .catch(() => {});
    }
  }

  /** 安装一次性手势解锁（引擎 mount 时调用；指针/键盘首次交互即解锁） */
  ensureGestureResume(): void {
    if (this.gestureInstalled || typeof window === "undefined") return;
    this.gestureInstalled = true;
    const once = (): void => {
      this.resumeContext();
      window.removeEventListener("pointerdown", once, true);
      window.removeEventListener("keydown", once, true);
    };
    window.addEventListener("pointerdown", once, true);
    window.addEventListener("keydown", once, true);
  }

  /**
   * 同步节点音源（引擎在节点入图/属性变化时调用）：
   * 同一场景对象仅应用设置差异；对象重建（场景重建）时整个重绑。
   */
  syncNode(node: AudioEmitterNode, obj: THREE.Object3D): void {
    const settings = parseAudioSettings(node.audio);
    const sig = settingsSig(settings);
    const existing = this.bindings.get(node.id);
    if (existing && existing.objUuid === obj.uuid) {
      const sourceChanged = settings.source !== existing.settings.source;
      const spatialChanged = settings.spatial !== existing.settings.spatial;
      const prevAutoplay = existing.settings.autoplay;
      existing.settings = settings;
      if (sourceChanged || spatialChanged) {
        existing.sig = sig;
        this.reloadSource(existing, settings);
      } else if (existing.sig !== sig) {
        existing.sig = sig;
        this.applyParams(existing);
      }
      // 自动播放意图跟随数据（手动停止过则不抢播）
      if (settings.autoplay && !prevAutoplay) existing.userStopped = false;
      if (settings.autoplay && !existing.userStopped && !existing.playing) {
        this.startIfReady(existing);
      }
      return;
    }
    if (existing) this.disposeBinding(existing);

    const binding: Binding = {
      nodeId: node.id,
      obj,
      objUuid: obj.uuid,
      sig,
      settings,
      emitter: null,
      loading: false,
      ready: false,
      error: null,
      playing: false,
      paused: false,
      offset: 0,
      started: false,
      userStopped: false,
      autoPaused: false,
    };
    this.bindings.set(node.id, binding);
    this.reloadSource(binding, settings);
  }

  /** 载入音源资产并（重）建音源对象 */
  private reloadSource(b: Binding, settings: AudioSourceSettings): void {
    this.disposeEmitter(b);
    b.ready = false;
    b.error = null;
    b.playing = false;
    b.paused = false;
    b.autoPaused = false;
    b.started = false;
    if (!settings.source) return;
    const rel = settings.source;
    b.loading = true;
    void this.loadBuffer(rel).then((buf) => {
      // 异步返回时绑定可能已换源/销毁：过期结果直接丢弃
      if (!this.bindings.has(b.nodeId) || b.settings.source !== rel) return;
      b.loading = false;
      if (!buf) {
        b.error = "音频加载/解码失败";
        this.notify(b.nodeId);
        return;
      }
      this.createEmitter(b, buf);
      this.applyParams(b);
      this.notify(b.nodeId);
      this.startIfReady(b);
    });
  }

  /** 按空间化形态创建音源对象（3D 挂节点对象下随变换；2D 全局不挂树） */
  private createEmitter(b: Binding, buffer: AudioBuffer): void {
    const listener = this.ensureListener();
    let emitter: AudioEmitter;
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
    emitter.name = "__audioEmitter";
    emitter.setBuffer(buffer);
    b.emitter = emitter;
    b.ready = true;
  }

  /** 就绪即播（autoplay 意图 + 上下文运行中；手动停止/已起播过不重复） */
  private startIfReady(b: Binding): void {
    if (!b.ready || !b.emitter || !b.settings.autoplay || b.userStopped) return;
    if (b.started || b.playing || this.context()?.state !== "running") return;
    this.playEmitter(b, true);
  }

  /** 数据参数 → 音源对象（音量/循环/倍速/3D 衰减；不重启播放） */
  private applyParams(b: Binding): void {
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

  /** 起播（fromStart=true 从头播；false = 暂停处续播） */
  private playEmitter(b: Binding, fromStart: boolean): void {
    const e = b.emitter;
    if (!e) return;
    this.resumeContext();
    if (e.isPlaying) e.stop();
    if (!fromStart && b.offset > 0) e.offset = b.offset;
    e.play();
    b.playing = true;
    b.paused = false;
    b.autoPaused = false;
    b.started = true;
  }

  /** 解码音频资产（带缓存；失败缓存为 null 结果，invalidate 清除后可重试） */
  private loadBuffer(rel: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(rel);
    if (cached) return cached;
    const task = (async (): Promise<AudioBuffer | null> => {
      const url = this.urlResolver?.(rel) ?? null;
      if (!url) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      const ctx = this.context();
      if (!ctx) return null;
      return await new Promise<AudioBuffer>((resolve, reject) => {
        // 回调形态兼容 Safari（promise 形态在其上不可靠）
        void ctx.decodeAudioData(arr, resolve, reject);
      });
    })().catch((e) => {
      console.warn(`[audio] 音频加载失败 '${rel}': ${String(e)}`);
      return null;
    });
    this.buffers.set(rel, task);
    return task;
  }

  /** 外部（资产改写/删除）通知某音频内容已更新：清除缓冲并重载引用绑定 */
  invalidate(rel: string): void {
    if (!rel) return;
    this.buffers.delete(rel);
    for (const b of [...this.bindings.values()]) {
      if (b.settings.source === rel) this.reloadSource(b, b.settings);
    }
  }

  /** 每帧推进：节点可见性链断开 → 自动暂停；恢复 → 续播（监听器接线由引擎做） */
  update(): void {
    for (const b of [...this.bindings.values()]) {
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
        // 恢复可见：从暂停处续播（手动暂停不经此路径，autoPaused 只在隐藏时置位）
        this.playEmitter(b, false);
      }
    }
  }

  // —— 运行时控制（不落盘）——

  /** 播放（暂停态续播；停止/播完态从头播；清除手动停止标记） */
  play(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.emitter) return;
    b.userStopped = false;
    this.playEmitter(b, !b.paused);
    this.notify(nodeId);
  }

  /** 暂停（保留进度，可继续） */
  pause(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.emitter || !b.playing || b.paused) return;
    b.offset = b.emitter.offset;
    b.emitter.pause();
    b.paused = true;
    b.autoPaused = false;
    this.notify(nodeId);
  }

  /** 继续（暂停处续播） */
  resume(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.emitter || !b.paused) return;
    this.playEmitter(b, false);
    this.notify(nodeId);
  }

  /** 停止（回到起点；autoplay 不再自动起播，play() 可恢复） */
  stop(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.emitter) return;
    if (b.emitter.isPlaying) b.emitter.stop();
    b.emitter.offset = 0;
    b.offset = 0;
    b.playing = false;
    b.paused = false;
    b.autoPaused = false;
    b.userStopped = true;
    this.notify(nodeId);
  }

  /** 运行时音量（不落盘；仅本会话） */
  setVolume(nodeId: string, volume: number): void {
    const b = this.bindings.get(nodeId);
    if (!b || !b.emitter) return;
    b.emitter.setVolume(Math.max(0, Math.min(1, volume)));
    this.notify(nodeId);
  }

  /** 运行时状态快照（UI 展示播放状态/就绪/错误） */
  stateFor(nodeId: string): AudioRuntimeState | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return {
      ready: b.ready,
      playing: b.playing && !b.paused && (b.emitter?.isPlaying ?? false),
      paused: b.paused,
      source: b.settings.source,
      error: b.error,
    };
  }

  /** 节点是否已建立音频绑定 */
  isBound(nodeId: string): boolean {
    return this.bindings.has(nodeId);
  }

  // —— 生命周期 ——

  /** 解除节点绑定（节点删除/场景替换时调用） */
  unbind(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    this.disposeBinding(b);
    this.bindings.delete(nodeId);
  }

  unbindAll(): void {
    for (const b of [...this.bindings.values()]) this.disposeBinding(b);
    this.bindings.clear();
  }

  private ensureListener(): THREE.AudioListener {
    if (!this.listener) {
      this.listener = new THREE.AudioListener();
      if (this.listenerHost) this.listenerHost.add(this.listener);
    }
    return this.listener;
  }

  private disposeEmitter(b: Binding): void {
    if (!b.emitter) return;
    if (b.emitter.isPlaying) b.emitter.stop();
    b.emitter.disconnect();
    b.emitter.removeFromParent();
    b.emitter = null;
  }

  private disposeBinding(b: Binding): void {
    this.disposeEmitter(b);
  }

  dispose(): void {
    this.unbindAll();
    this.buffers.clear();
    this.listeners.clear();
    if (this.listener) {
      this.listener.removeFromParent();
      this.listener = null;
      this.listenerHost = null;
    }
  }
}

/** 节点对象可见性链（含自身；active/visible 已由同步器合并进 obj.visible） */
function hostVisible(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}
