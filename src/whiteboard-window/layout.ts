// ---------------------------------------------------------------------------
// 白板窗口布局持久化（ui-state KV，全局键，不随项目）：
// 浮动面板位置/收起态/激活页签跨打开恢复。窗口内共享一份 reactive 布局对象：
// 启动时拉取一次，组件直接改它，变更后经 saveWhiteboardLayout 防抖写回。
// ---------------------------------------------------------------------------
import { reactive } from "vue";
import { uiStateGet, uiStateSet } from "../lib/ui-state";

export type WhiteboardSideTab = "layers" | "props";

export interface WhiteboardLayout {
  /** 浮动面板位置（画布内 px；null = 默认右上锚定） */
  panelX: number | null;
  panelY: number | null;
  panelCollapsed: boolean;
  sideTab: WhiteboardSideTab;
  /** 线条工具（直线/铅笔/钢笔）的线条粗细 */
  toolWidth: number;
}

const KEY = "tve:whiteboard:layout";

export const whiteboardLayout = reactive<WhiteboardLayout>({
  panelX: null,
  panelY: null,
  panelCollapsed: false,
  sideTab: "layers",
  toolWidth: 2,
});

let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 拉取持久化布局（窗口启动调用一次；浏览器开发环境保持默认值） */
export async function loadWhiteboardLayout(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await uiStateGet<Partial<WhiteboardLayout>>(KEY);
    if (saved) {
      Object.assign(whiteboardLayout, saved);
      // 兼容历史值：动画页签已移除
      if (whiteboardLayout.sideTab !== "layers" && whiteboardLayout.sideTab !== "props") {
        whiteboardLayout.sideTab = "layers";
      }
    }
  } catch {
    /* ignore */
  }
}

/** 变更落盘（防抖合并连续变更，如拖动面板） */
export function saveWhiteboardLayout(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void uiStateSet(KEY, { ...whiteboardLayout }).catch(() => {});
  }, 400);
}
