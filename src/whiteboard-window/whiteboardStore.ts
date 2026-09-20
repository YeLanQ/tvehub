// ---------------------------------------------------------------------------
// 白板窗口 store（全局单例：窗口 label "whiteboard"，与 home 同级的全局工具
// 窗口，不绑定项目）：
// - 状态桥模式与编辑器 EditorStore 一致：state 为 readonly reactive，写路径全走
//   方法（历史/脏标记/标题同步集中在此）；
// - 快照式撤销重做：连续编辑（拖拽/滑杆/颜色拾取）经 transact/settle 折叠为一条；
// - 文档为标准 .svg 文件，存全局白板目录（Rust whiteboard_* 命令读写）；
//   打开指定文件走双通道：take_pending_whiteboard_file 冷启动拉取 +
//   tve:whiteboard-open 事件热直达；保存后广播 tve:whiteboard-saved 通知首页刷新。
// ---------------------------------------------------------------------------
import { reactive } from "vue";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/api";
import { isTauri } from "../lib/tauri-env";
import { bumpWhiteboardMeta } from "./whiteboard-meta";
import {
  buildAnimCss,
  moveElBy,
  newDoc,
  newLayer,
  parseSvg,
  roundElCoords,
  serializeDoc,
  type SvgDoc,
  type SvgEl,
  type SvgLayer,
  type SvgTool,
} from "./svg-doc";
import { toast, type ToastLevel } from "../ui-kit/composables/toast";

const HISTORY_LIMIT = 100;

interface HistoryEntry {
  label: string;
  snap: string;
}

export interface WhiteboardState {
  doc: SvgDoc;
  tool: SvgTool;
  degraded: boolean;
  loading: boolean;
  dirty: boolean;
  /** 打开的白板文件名（null = 未保存的新文档） */
  currentFile: string | null;
  /** 新文档的保存文件名（保存后固定进 currentFile） */
  saveName: string;
  selectedId: string | null;
  activeLayerId: string | null;
}

export interface WhiteboardStore {
  state: Readonly<WhiteboardState>;
  canUndo(): boolean;
  canRedo(): boolean;
  animCss(): string;
  selectedEl(): SvgEl | null;
  activeLayer(): SvgLayer | null;
  fileName(): string;
  markDegraded(): void;
  /** 启动就绪（新建空白文档；有 pending 文件时由 loadFile 覆盖） */
  markReady(): void;
  /** 打开全局白板文件（解析失败保持原文档并提示） */
  loadFile(name: string): Promise<void>;
  setTool(t: SvgTool): void;
  snap(): string;
  transact(mutate: () => void): void;
  settle(label: string): void;
  commit(label: string, mutate: () => void): void;
  undo(): void;
  redo(): void;
  selectEl(id: string | null): void;
  selectLayer(id: string): void;
  setSaveName(name: string): void;
  /** 调整画板尺寸（可撤销；内容锚定左上角不动） */
  setDocSize(w: number, h: number): void;
  addEl(el: SvgEl): void;
  /** 拖拽移动（transact 逐步调，settle 收尾） */
  moveSelectedBy(dx: number, dy: number): void;
  deleteSelected(): void;
  bringForward(elId: string): void;
  sendBackward(elId: string): void;
  addLayer(): void;
  removeLayer(id: string): void;
  renameLayer(id: string, name: string): void;
  patchLayer(id: string, patch: Partial<SvgLayer>, label: string): void;
  moveLayer(id: string, towardTop: boolean): void;
  save(): Promise<void>;
  /** 气泡提示（统一走 ui-kit 全局气泡，level 决定配色） */
  showNotice(text: string, level?: ToastLevel): void;
}

let singleton: WhiteboardStore | null = null;

export function getWhiteboardStore(): WhiteboardStore {
  if (singleton) return singleton;

  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  /** 进行中批量的起始快照（拖拽/连续输入期间置位，settle 时入栈） */
  let pendingSnap: string | null = null;

  const initialDoc = newDoc(1280, 720);
  const state = reactive<WhiteboardState>({
    doc: initialDoc,
    tool: "select",
    degraded: false,
    loading: false,
    dirty: false,
    currentFile: null,
    saveName: "未命名.svg",
    selectedId: null,
    activeLayerId: initialDoc.layers[initialDoc.layers.length - 1]?.id ?? null,
  });

  function currentFileName(): string {
    return state.currentFile ?? state.saveName ?? "未命名.svg";
  }

  function syncTitle(): void {
    if (!isTauri()) return;
    void getCurrentWindow()
      .setTitle(`TvE 白板 – ${currentFileName()}${state.dirty ? " •" : ""}`)
      .catch(() => {});
  }

  function pushUndo(label: string, snap: string): void {
    undoStack.push({ label, snap });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncTitle();
  }

  function showNotice(text: string, level: ToastLevel = "info"): void {
    toast(level, text);
  }

  function clearHistory(): void {
    undoStack.length = 0;
    redoStack.length = 0;
    pendingSnap = null;
  }

  const store: WhiteboardStore = {
    state,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    animCss: () => buildAnimCss(state.doc),
    selectedEl: () => state.doc.els.find((e) => e.id === state.selectedId) ?? null,
    activeLayer: () => state.doc.layers.find((l) => l.id === state.activeLayerId) ?? null,
    fileName: currentFileName,

    markDegraded() {
      state.degraded = true;
    },

    markReady() {
      state.loading = false;
      syncTitle();
    },

    async loadFile(name) {
      if (!isTauri()) {
        showNotice("浏览器预览无法读取白板文件", "warn");
        return;
      }
      state.loading = true;
      try {
        const text = await api.whiteboardRead(name);
        const { doc, warning } = parseSvg(text);
        state.doc = doc;
        state.currentFile = name;
        state.dirty = false;
        state.selectedId = null;
        state.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
        clearHistory();
        if (warning) showNotice(warning, "warn");
      } catch (e) {
        showNotice(`打开白板失败：${e}`, "err");
      } finally {
        state.loading = false;
      }
      syncTitle();
    },

    setTool(t) {
      state.tool = t;
    },

    snap: () => JSON.stringify(state.doc),

    /** 批量编辑的一步（连续调用折叠为一条历史；首次调用捕获起始快照） */
    transact(mutate) {
      if (pendingSnap === null) pendingSnap = JSON.stringify(state.doc);
      mutate();
      state.dirty = true;
    },

    /** 结束批量（拖拽松开 / 输入框 change），以起始快照入栈 */
    settle(label) {
      if (pendingSnap === null) return;
      pushUndo(label, pendingSnap);
      pendingSnap = null;
    },

    /** 一次性变更：起始快照 → 变更 → 直接入栈 */
    commit(label, mutate) {
      const snap = JSON.stringify(state.doc);
      mutate();
      state.dirty = true;
      pushUndo(label, snap);
    },

    undo() {
      if (pendingSnap !== null) store.settle("变更");
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push({ label: entry.label, snap: JSON.stringify(state.doc) });
      state.doc = JSON.parse(entry.snap) as SvgDoc;
      state.dirty = true;
      if (!state.doc.els.some((e) => e.id === state.selectedId)) {
        state.selectedId = null;
      }
      if (!state.doc.layers.some((l) => l.id === state.activeLayerId)) {
        state.activeLayerId = state.doc.layers[state.doc.layers.length - 1]?.id ?? null;
      }
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      undoStack.push({ label: entry.label, snap: JSON.stringify(state.doc) });
      state.doc = JSON.parse(entry.snap) as SvgDoc;
      state.dirty = true;
      if (!state.doc.els.some((e) => e.id === state.selectedId)) {
        state.selectedId = null;
      }
    },

    selectEl(id) {
      state.selectedId = id;
      const el = id ? state.doc.els.find((e) => e.id === id) : null;
      if (el) state.activeLayerId = el.layerId;
    },

    selectLayer(id) {
      state.activeLayerId = id;
    },


    setSaveName(name) {
      state.saveName = name;
      syncTitle();
    },

    setDocSize(w, h) {
      const width = Math.max(1, Math.min(8192, Math.round(w)));
      const height = Math.max(1, Math.min(8192, Math.round(h)));
      if (width === state.doc.w && height === state.doc.h) return;
      store.commit("调整画板尺寸", () => {
        state.doc.w = width;
        state.doc.h = height;
      });
    },


    addEl(el) {
      store.commit("添加元素", () => {
        state.doc.els.push(el);
        state.selectedId = el.id;
        state.activeLayerId = el.layerId;
      });
    },

    moveSelectedBy(dx, dy) {
      const el = state.doc.els.find((e) => e.id === state.selectedId);
      if (!el) return;
      store.transact(() => {
        moveElBy(el, dx, dy);
        roundElCoords(el);
      });
    },

    deleteSelected() {
      const el = store.selectedEl();
      if (!el) return;
      const layer = state.doc.layers.find((l) => l.id === el.layerId);
      if (layer?.locked) {
        showNotice("所在图层已锁定，无法删除", "warn");
        return;
      }
      store.commit("删除元素", () => {
        state.doc.els = state.doc.els.filter((e) => e.id !== el.id);
        state.selectedId = null;
      });
    },

    bringForward(elId) {
      const el = state.doc.els.find((e) => e.id === elId);
      if (!el) return;
      // 仅在同图层子序列内前移（不跨图层改变遮挡关系）
      const sameLayer = state.doc.els.filter((e) => e.layerId === el.layerId);
      const idxInLayer = sameLayer.findIndex((e) => e.id === elId);
      if (idxInLayer < 0 || idxInLayer >= sameLayer.length - 1) return;
      store.commit("调整顺序", () => {
        const cur = sameLayer[idxInLayer];
        const next = sameLayer[idxInLayer + 1];
        const gi = state.doc.els.indexOf(cur);
        const gj = state.doc.els.indexOf(next);
        state.doc.els[gi] = next;
        state.doc.els[gj] = cur;
      });
    },

    sendBackward(elId) {
      const el = state.doc.els.find((e) => e.id === elId);
      if (!el) return;
      const sameLayer = state.doc.els.filter((e) => e.layerId === el.layerId);
      const idxInLayer = sameLayer.findIndex((e) => e.id === elId);
      if (idxInLayer <= 0) return;
      store.commit("调整顺序", () => {
        const cur = sameLayer[idxInLayer];
        const prev = sameLayer[idxInLayer - 1];
        const gi = state.doc.els.indexOf(cur);
        const gj = state.doc.els.indexOf(prev);
        state.doc.els[gi] = prev;
        state.doc.els[gj] = cur;
      });
    },

    addLayer() {
      store.commit("新建图层", () => {
        const layer = newLayer(`图层 ${state.doc.layers.length + 1}`);
        state.doc.layers.push(layer);
        state.activeLayerId = layer.id;
      });
    },

    removeLayer(id) {
      if (state.doc.layers.length <= 1) {
        showNotice("至少保留一个图层", "warn");
        return;
      }
      store.commit("删除图层", () => {
        state.doc.layers = state.doc.layers.filter((l) => l.id !== id);
        state.doc.els = state.doc.els.filter((e) => e.layerId !== id);
        if (state.activeLayerId === id) {
          state.activeLayerId = state.doc.layers[state.doc.layers.length - 1]?.id ?? null;
        }
        if (state.selectedId && !state.doc.els.some((e) => e.id === state.selectedId)) {
          state.selectedId = null;
        }
      });
    },

    renameLayer(id, name) {
      const layer = state.doc.layers.find((l) => l.id === id);
      if (!layer || layer.name === name) return;
      store.commit("重命名图层", () => {
        layer.name = name;
      });
    },

    patchLayer(id, patch, label) {
      store.commit(label, () => {
        const layer = state.doc.layers.find((l) => l.id === id);
        if (layer) Object.assign(layer, patch);
      });
    },

    moveLayer(id, towardTop) {
      const idx = state.doc.layers.findIndex((l) => l.id === id);
      if (idx < 0) return;
      const target = idx + (towardTop ? 1 : -1);
      if (target < 0 || target >= state.doc.layers.length) return;
      store.commit(towardTop ? "图层上移" : "图层下移", () => {
        const layers = state.doc.layers;
        const tmp = layers[idx];
        layers[idx] = layers[target];
        layers[target] = tmp;
      });
    },




    async save() {
      if (!isTauri()) {
        showNotice("浏览器预览无法保存白板", "warn");
        return;
      }
      const raw = currentFileName().trim();
      if (!raw) {
        showNotice("文件名无效", "warn");
        return;
      }
      const name = raw.toLowerCase().endsWith(".svg") ? raw : `${raw}.svg`;
      try {
        await api.whiteboardWrite(name, serializeDoc(state.doc, true));
        state.currentFile = name;
        state.saveName = name;
        state.dirty = false;
        // 元数据时间戳（首页时间轴排序依据）
        await bumpWhiteboardMeta(name).catch(() => {});
        void emit("tve:whiteboard-saved", { name }).catch(() => {});
        showNotice(`已保存 ${name}`, "ok");
      } catch (e) {
        showNotice(`保存失败：${e}`, "err");
      }
      syncTitle();
    },

    showNotice,
  };

  singleton = store;
  return store;
}
