// ---------------------------------------------------------------------------
// 视图模式（右侧二选一，下拉切换）：dope = 帧动画轨道；curve = 单通道曲线编辑。
// 本模块无跨模块依赖，须在 useAnimTimeline 之前构造（时间轴模块的 watch
// 创建时即求值 viewMode，读取未构造的 ctx 字段会抛错）。
// ---------------------------------------------------------------------------
import { computed, ref } from "vue";
import type { AnimEditorCtx, ViewApi } from "./ctx";

export function useAnimView(_ctx: AnimEditorCtx): ViewApi {
  const viewMode = ref<"dope" | "curve">("dope");

  function onViewModeChange(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "dope" || v === "curve") viewMode.value = v;
  }

  const viewHint = computed(() =>
    viewMode.value === "dope"
      ? "滚轮缩放时间轴 / Ctrl 滚轮平移；中键拖拽平移（横=时间窗，1× 全览时向左拖自动放大；纵=翻轨道）；右键关键帧：插值/切线/删除"
      : "与帧动画同一套鼠标方案：滚轮缩放时间轴 / Ctrl 滚轮平移 / 中键拖拽平移（纵向平移数值轴）；拖方块改时间/数值，拖切线手柄调贝塞尔；空白单击插帧；右键关键帧弹菜单",
  );

  return { viewMode, onViewModeChange, viewHint };
}