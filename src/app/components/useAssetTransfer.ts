// useAssetTransfer —— 资产面板的拖放传输 composable：
// 1) 面板内部拖拽（mousedown/mousemove/mouseup 移动资产到目录）；
// 2) 外部系统文件窗口级拖放导入（onDragDropEvent，自管理监听生命周期）。
// 依赖经参数注入（当前目录/选中/回调），不持有面板 Vue 状态与 store。

import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logStore } from "../stores/log";
import { isProtectedAsset } from "../lib/asset-guards";
import type { ChildEntry } from "../lib/asset-browser";

interface DragStart {
  x: number;
  y: number;
  paths: string[];
}

export interface UseAssetTransferDeps {
  currentDir: Ref<string>;
  selectedPaths: Ref<string[]>;
  /** src / 内置只读目录不允许导入 */
  importAllowedDir: (dir: string) => boolean;
  getProjectPath: () => string | null;
  moveTo: (root: string, rel: string, destDir: string) => Promise<string | null>;
  importPaths: (root: string, destDir: string, paths: string[]) => Promise<boolean>;
  /** 点击行为（拖拽结束后有短暂抑制，避免误点） */
  onClickItem: (e: MouseEvent, item: ChildEntry) => void;
}

export function useAssetTransfer(deps: UseAssetTransferDeps) {
  const dragPaths = ref<string[] | null>(null);
  let dragStart: DragStart | null = null;
  let dragActive = false;
  let suppressClickUntil = 0;

  const hoverPath = ref<string | null>(null);
  const dragGhost = ref<{ x: number; y: number; label: string } | null>(null);

  function onItemMouseDown(e: MouseEvent, item: ChildEntry) {
    if (e.button !== 0) return;
    if (isProtectedAsset(item.path)) return; // 内置资源与项目固定目录（assets/src）只读，不能拖拽移动
    const draggingAll = deps.selectedPaths.value.includes(item.path);
    dragStart = {
      x: e.clientX,
      y: e.clientY,
      paths:
        draggingAll && deps.selectedPaths.value.length > 0
          ? [...deps.selectedPaths.value]
          : [item.path],
    };
    dragActive = false;
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
  }

  function findDropTarget(x: number, y: number, paths: string[] | null): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || el.classList.contains("asset-drag-ghost")) return null;
    const dirEl = el.closest<HTMLElement>("[data-drop-dir]");
    if (dirEl) {
      const p = dirEl.getAttribute("data-drop-dir");
      if (p) {
        if (paths && paths.includes(p)) return null;
        return p;
      }
    }
    if (el.closest(".am-content")) return deps.currentDir.value;
    return null;
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!dragStart) return;
    if (!dragActive) {
      if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < 4) return;
      dragActive = true;
      dragPaths.value = dragStart.paths;
    }
    dragGhost.value = { x: e.clientX, y: e.clientY, label: dragStart.paths[0] };
    hoverPath.value = findDropTarget(e.clientX, e.clientY, dragStart.paths);
  }

  function onWindowMouseUp(e: MouseEvent) {
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("mouseup", onWindowMouseUp);
    const s = dragStart;
    dragStart = null;
    const wasActive = dragActive;
    dragActive = false;
    if (!wasActive) return;
    suppressClickUntil = Date.now() + 150;
    dragPaths.value = null;
    dragGhost.value = null;
    hoverPath.value = null;
    if (s) {
      const target = findDropTarget(e.clientX, e.clientY, s.paths);
      if (target && !s.paths.includes(target)) void moveAssetsToDir(s.paths, target);
    }
  }

  /** 拖拽结束后的短窗口内忽略普通点击（避免拖完误触发选择/进入目录） */
  function onItemClickGuard(e: MouseEvent, item: ChildEntry) {
    if (Date.now() < suppressClickUntil) return;
    deps.onClickItem(e, item);
  }

  async function moveAssetsToDir(paths: string[], destDir: string) {
    const root = deps.getProjectPath();
    if (!root) return;
    dragPaths.value = null;
    for (const p of paths) await deps.moveTo(root, p, destDir);
  }

  // ---------- 外部系统文件拖放导入（Tauri 窗口级事件；面板内落点才导入当前目录） ----------
  const panelEl = ref<HTMLElement | null>(null);
  const dragOver = ref(false);
  let unlistenDrop: (() => void) | null = null;

  async function setupExternalDrop(): Promise<void> {
    try {
      const win = getCurrentWindow();
      unlistenDrop = await win.onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          if (panelEl.value) {
            const r = panelEl.value.getBoundingClientRect();
            const sf = window.devicePixelRatio || 1;
            const x = p.position.x / sf;
            const y = p.position.y / sf;
            dragOver.value = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          }
        } else if (p.type === "drop") {
          const inside = dragOver.value;
          dragOver.value = false;
          if (!inside || !p.paths || p.paths.length === 0) return;
          const root = deps.getProjectPath();
          const dir = deps.currentDir.value;
          if (!root) return;
          if (!deps.importAllowedDir(dir)) {
            logStore.log("warn", "该目录不允许拖放导入（src/内置只读）");
            return;
          }
          void deps.importPaths(root, dir, p.paths);
        } else {
          // leave / cancel
          dragOver.value = false;
        }
      });
    } catch (e) {
      logStore.log("warn", `外部拖放监听不可用: ${e}`);
    }
  }

  onMounted(() => {
    void setupExternalDrop();
  });
  onUnmounted(() => {
    unlistenDrop?.();
    unlistenDrop = null;
  });

  return {
    dragPaths,
    hoverPath,
    dragGhost,
    dragOver,
    panelEl,
    onItemMouseDown,
    onItemClickGuard,
    moveAssetsToDir,
  };
}
