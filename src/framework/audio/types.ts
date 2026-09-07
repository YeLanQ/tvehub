// ---------------------------------------------------------------------------
// 音频系统数据类型（framework 层，不依赖 app/api 与 three）。
//
// 音源节点（AudioNode.audio）持有可 JSON 序列化的播放设置：音频资产引用 +
// 自动播放/循环/音量/倍速 + 2D/3D 空间化。读取时经 parseAudioSettings 统一
// 收敛（缺失/越界字段回退默认），保证旧场景兼容。
// ---------------------------------------------------------------------------

/** 支持的音频资产扩展名（小写；资产识别/导入目录路由共用） */
export const AUDIO_EXTS = ["mp3", "wav", "ogg", "m4a", "aac", "flac"] as const;

/** 是否音频资产相对路径（按扩展名判断） */
export function isAudioAssetRel(rel: string): boolean {
  const i = rel.lastIndexOf(".");
  if (i < 0) return false;
  return (AUDIO_EXTS as readonly string[]).includes(rel.slice(i + 1).toLowerCase());
}

/** 空间化模式：2D（全局背景/音效，不随距离衰减）| 3D（位置音源，随距离/方向衰减） */
export type AudioSpatialMode = "2d" | "3d";

/** 音源播放设置（AudioNode.audio 的形状） */
export interface AudioSourceSettings {
  /** 音频资产引用（空串 = 未绑定；internal/… 或项目 assets/…） */
  source: string;
  /** 自动播放（上下文就绪/节点入图后起播） */
  autoplay: boolean;
  /** 循环播放 */
  loop: boolean;
  /** 音量 0..1 */
  volume: number;
  /** 播放倍速（0.1..4） */
  speed: number;
  /** 空间化：2d = 全局；3d = 位置音源（refDistance/maxDistance/rolloff 生效） */
  spatial: AudioSpatialMode;
  /** 3D：全音量参考距离（世界单位） */
  refDistance: number;
  /** 3D：衰减到 0 的最大距离 */
  maxDistance: number;
  /** 3D：衰减速率（1 = 线性；越大衰减越快） */
  rolloff: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSourceSettings = {
  source: "",
  autoplay: true,
  loop: true,
  volume: 1,
  speed: 1,
  spatial: "2d",
  refDistance: 1,
  maxDistance: 30,
  rolloff: 1,
};

/** 运行时状态快照（UI 展示用） */
export interface AudioRuntimeState {
  /** 音源是否就绪（音频解码完成可播） */
  ready: boolean;
  playing: boolean;
  paused: boolean;
  /** 当前绑定的音频资产引用 */
  source: string;
  /** 加载失败原因（失败时非空） */
  error: string | null;
}

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 任意来源 → 收敛的音源播放设置（缺失/非法字段回退默认） */
export function parseAudioSettings(v: unknown): AudioSourceSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const spatial = o.spatial === "3d" ? "3d" : "2d";
  return {
    source: str(o.source),
    autoplay: typeof o.autoplay === "boolean" ? o.autoplay : DEFAULT_AUDIO_SETTINGS.autoplay,
    loop: typeof o.loop === "boolean" ? o.loop : DEFAULT_AUDIO_SETTINGS.loop,
    volume: clamp(num(o.volume, DEFAULT_AUDIO_SETTINGS.volume), 0, 1),
    speed: clamp(num(o.speed, DEFAULT_AUDIO_SETTINGS.speed), 0.1, 4),
    spatial,
    refDistance: Math.max(0.01, num(o.refDistance, DEFAULT_AUDIO_SETTINGS.refDistance)),
    maxDistance: Math.max(0.01, num(o.maxDistance, DEFAULT_AUDIO_SETTINGS.maxDistance)),
    rolloff: Math.max(0, num(o.rolloff, DEFAULT_AUDIO_SETTINGS.rolloff)),
  };
}

/** 深拷贝音源设置（节点克隆/编辑工作副本） */
export function cloneAudioSettings(s: AudioSourceSettings): AudioSourceSettings {
  return { ...s };
}
