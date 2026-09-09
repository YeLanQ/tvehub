// ---------------------------------------------------------------------------
// 剪辑加载 / 保存（改动防抖自动写盘）：当前编辑的 .anim 资产 + 文档引用。
// 切剪辑时通过 ctx 复位时间轴 / 曲线 / 播放状态（子模块共享状态对象）。
// ---------------------------------------------------------------------------
import { computed, onMounted, ref, watch } from "vue";
import { parseAnimationClip, type AnimationClipData } from "../../../framework/animation/clip";
import { api } from "../../../lib/api";
import { animEditor } from "../../lib/anim-editor";
import { getProjectStore } from "../../stores/project";
import { getAssetsStore } from "../../stores/assets";
import type { AnimEditorCtx, ClipApi } from "./ctx";

export function useAnimClip(ctx: AnimEditorCtx): ClipApi {
  const projectStore = getProjectStore();
  const assetsStore = getAssetsStore();

  const clipRel = ref("");
  const doc = ref<AnimationClipData | null>(null);
  const rev = ref(0);
  const dirty = ref(false);
  const saving = ref(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loadToken = 0;

  function touch(): void {
    rev.value += 1;
    dirty.value = true;
    scheduleSave();
  }

  function flushSave(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void saveNow();
    }
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 600);
  }

  async function saveNow(): Promise<void> {
    const root = projectStore.currentPath;
    if (!root || !doc.value || !clipRel.value) return;
    saving.value = true;
    try {
      await api.writeText(root, clipRel.value, JSON.stringify(doc.value, null, 2));
      dirty.value = false;
    } catch (e) {
      console.error("保存动画剪辑失败", e);
    } finally {
      saving.value = false;
    }
  }

  async function loadClip(rel: string): Promise<void> {
    const token = ++loadToken;
    ctx.playback.stopPreview(); // 内部会 restorePreview + 归零 time
    ctx.playback.time.value = 0;
    flushSave();
    clipRel.value = rel;
    doc.value = null;
    dirty.value = false;
    // 切剪辑：选中、曲线通道与数值窗、共享时间窗全部复位
    ctx.selection.selected.value = null;
    ctx.curve.curveProp.value = "";
    ctx.curve.reset();
    ctx.timeline.tlT0.value = 0;
    ctx.timeline.zoom.value = 1;
    const laneEl = ctx.timeline.laneEl.value;
    const namesEl = ctx.timeline.namesEl.value;
    if (laneEl) laneEl.scrollTop = 0;
    if (namesEl) namesEl.scrollTop = 0;
    if (!rel) {
      rev.value += 1;
      return;
    }
    const root = projectStore.currentPath;
    if (!root) {
      rev.value += 1;
      return;
    }
    try {
      const text = await api.readText(root, rel);
      if (token !== loadToken) return;
      doc.value = parseAnimationClip(JSON.parse(text));
      ctx.curve.curveProp.value = doc.value.curves[0]?.prop ?? "";
    } catch (e) {
      console.error("加载动画剪辑失败", e);
      doc.value = null;
    }
    rev.value += 1;
  }

  // 外部打开请求（资产检查器/组件卡「在动画编辑器中打开」）
  watch(
    () => animEditor.seq,
    () => {
      if (animEditor.clipRel && animEditor.clipRel !== clipRel.value) {
        void loadClip(animEditor.clipRel);
      }
    },
  );

  // 面板（重）挂载时若已有打开中的剪辑：直接加载（seq 不再变化，watch 不触发）
  onMounted(() => {
    if (animEditor.clipRel && animEditor.clipRel !== clipRel.value) {
      void loadClip(animEditor.clipRel);
    }
  });

  const clipOptions = computed(() =>
    assetsStore.assets.filter((a) => a.kind === "anim" && !a.path.startsWith("internal/")),
  );

  function onPickClip(e: Event): void {
    void loadClip((e.target as HTMLSelectElement).value);
  }

  return {
    clipRel,
    doc,
    rev,
    dirty,
    saving,
    touch,
    flushSave,
    loadClip,
    onPickClip,
    clipOptions,
  };
}