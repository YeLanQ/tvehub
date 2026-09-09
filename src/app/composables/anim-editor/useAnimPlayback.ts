// ---------------------------------------------------------------------------
// 播放 / 录制：单 rAF 驱动（播放推进 + 录制 auto-key 捕获）。停止时还原节点
// 姿势、归零时间；录制开启时以当前值为基线，通道值变化即写关键帧。
// ---------------------------------------------------------------------------
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import { upsertKey, type AnimProp } from "../../../framework/animation/clip";
import { propDefOf } from "../../lib/anim-props";
import { getEditorStore } from "../../stores/editor";
import type { AnimEditorCtx, PlaybackApi } from "./ctx";

export function useAnimPlayback(ctx: AnimEditorCtx): PlaybackApi {
  const { engine } = getEditorStore();

  const time = ref(0);
  const playing = ref(false);
  const recording = ref(false);
  let raf = 0;
  let lastTs = 0;
  let captured = new Map<AnimProp, number>();

  function currentValues(node: Node): Map<AnimProp, number> {
    const out = new Map<AnimProp, number>();
    const d = ctx.clip.doc.value;
    if (!d) return out;
    for (const c of d.curves) {
      const def = propDefOf(c.prop);
      if (def) out.set(c.prop, def.read(node, engine));
    }
    return out;
  }

  function captureFromNode(node: Node | null): void {
    const d = ctx.clip.doc.value;
    if (!d || !node) return;
    for (const [prop, v] of currentValues(node)) {
      if (captured.has(prop) && Math.abs((captured.get(prop) as number) - v) < 1e-4) continue;
      const curve = d.curves.find((c) => c.prop === prop);
      if (!curve) continue;
      upsertKey(curve, time.value, v);
      captured.set(prop, v);
      ctx.clip.touch();
    }
  }

  function beginCaptureBaseline(): void {
    captured = ctx.preview.targetNode.value ? currentValues(ctx.preview.targetNode.value) : new Map();
  }

  function frame(ts: number): void {
    raf = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    const d = ctx.clip.doc.value;
    if (!d) return;
    if (playing.value) {
      time.value += dt;
      if (d.loops) time.value %= d.duration;
      else if (time.value >= d.duration) {
        time.value = d.duration;
        playing.value = false;
        stopPreview(); // 播放到末尾：还原节点并归零播放头（随后 previewAt 重新采样起点）
      }
      ctx.preview.previewAt(time.value);
    }
    if (recording.value) captureFromNode(ctx.preview.targetNode.value);
  }

  function togglePlaying(): void {
    playing.value = !playing.value;
    if (playing.value) {
      if (time.value >= (ctx.clip.doc.value?.duration ?? 0)) time.value = 0;
      recording.value = false;
    } else {
      ctx.preview.restorePreview();
    }
    lastTs = 0;
  }

  /** 停止并还原：播放/录制全停、还原姿势、归零时间 */
  function stopPreview(): void {
    playing.value = false;
    recording.value = false;
    ctx.preview.restorePreview();
    time.value = 0;
  }

  function toggleRecording(): void {
    if (!ctx.clip.doc.value) return;
    recording.value = !recording.value;
    playing.value = false;
    ctx.preview.restorePreview();
    if (recording.value) beginCaptureBaseline();
  }

  onMounted(() => {
    raf = requestAnimationFrame(frame);
  });
  onBeforeUnmount(() => {
    cancelAnimationFrame(raf);
    ctx.preview.restorePreview();
  });

  return { time, playing, recording, togglePlaying, toggleRecording, stopPreview };
}