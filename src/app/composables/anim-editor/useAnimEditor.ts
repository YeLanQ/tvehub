// ---------------------------------------------------------------------------
// 动画编辑器组合根：按依赖顺序构造全部子模块并把它们互相注入共享上下文。
//
// 构造顺序有讲究：各模块的 watch/computed 闭包在创建时可能立即求值兄弟模块
// 的字段（如时间轴模块 watch viewMode），因此无依赖的 useAnimView 最先构造；
// 其余模块按 clip → preview → playback → tracks → timeline → selection →
// curve 排列，每个模块只依赖排在自己前面的模块（用 ctx 以引用方式取值，
// 事件触发时路径已全部就绪）。
// ---------------------------------------------------------------------------
import type { AnimEditorCtx } from "./ctx";
import { useAnimView } from "./useAnimView";
import { useAnimClip } from "./useAnimClip";
import { useAnimPreview } from "./useAnimPreview";
import { useAnimPlayback } from "./useAnimPlayback";
import { useAnimTracks } from "./useAnimTracks";
import { useAnimTimeline } from "./useAnimTimeline";
import { useAnimSelection } from "./useAnimSelection";
import { useAnimCurve } from "./useAnimCurve";

export function useAnimEditor(): AnimEditorCtx {
  const ctx = {} as AnimEditorCtx;
  // 视图模式无跨模块依赖，先构造（时间轴模块可见）
  ctx.view = useAnimView(ctx);
  ctx.clip = useAnimClip(ctx);
  ctx.preview = useAnimPreview(ctx);
  ctx.playback = useAnimPlayback(ctx);
  ctx.tracks = useAnimTracks(ctx);
  ctx.timeline = useAnimTimeline(ctx);
  ctx.selection = useAnimSelection(ctx);
  ctx.curve = useAnimCurve(ctx);
  return ctx;
}

export type { AnimEditorCtx } from "./ctx";