// ---------------------------------------------------------------------------
// 脚本图窗口停靠布局（编辑器 docks-layout 的图窗口版）：
// 面板注册表为图窗口三面板（层级/检查器/资产），布局经后端 UI 状态 KV 持久化（键与编辑器隔离），
// 互不串布局；拖拽停靠/浮动/尺寸约束逻辑与编辑器完全一致。
// ---------------------------------------------------------------------------

import { reactive, watch } from "vue";
import { uiStateGet, uiStateSet } from "../lib/ui-state";

export type GraphDockPanelId = "hierarchy" | "inspector" | "assets" | "variables" | "customNodes";
export type GraphDockZoneId = "left" | "right" | "bottom";

export interface GraphFloatingDock {
  id: number;
  panel: GraphDockPanelId;
  x: number;
  y: number;
  w: number;
  h: number;
  origin: GraphDockZoneId;
  active: GraphDockPanelId;
}

export interface GraphDockLayout {
  zones: Record<GraphDockZoneId, GraphDockPanelId[]>;
  active: Record<GraphDockZoneId, GraphDockPanelId>;
  floating: GraphFloatingDock[];
  sizes: { left: number; right: number; bottom: number };
}

export const GRAPH_ALL_PANELS: GraphDockPanelId[] = ["hierarchy", "inspector", "variables", "customNodes", "assets"];
export const GRAPH_ALL_ZONES: GraphDockZoneId[] = ["left", "right", "bottom"];

export const GRAPH_DOCK_PANEL_LABEL: Record<GraphDockPanelId, string> = {
  hierarchy: "层级",
  inspector: "检查器",
  variables: "变量",
  customNodes: "自定义",
  assets: "资产",
};

function defaults(): GraphDockLayout {
  return {
    zones: { left: ["hierarchy"], right: ["inspector", "variables", "customNodes"], bottom: ["assets"] },
    active: { left: "hierarchy", right: "inspector", bottom: "assets" },
    floating: [],
    sizes: { left: 270, right: 300, bottom: 240 },
  };
}

function clampNum(v: unknown, min: number, max: number, def: number): number {
  return typeof v === "number" && isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function isPanel(p: unknown): p is GraphDockPanelId {
  return typeof p === "string" && (GRAPH_ALL_PANELS as string[]).includes(p);
}

function normalize(l: Partial<GraphDockLayout> | null): GraphDockLayout {
  const d = defaults();
  if (!l) return d;
  const placed = new Set<GraphDockPanelId>();
  const zones: Record<GraphDockZoneId, GraphDockPanelId[]> = { left: [], right: [], bottom: [] };
  for (const z of GRAPH_ALL_ZONES) {
    const list = l.zones?.[z];
    if (Array.isArray(list)) {
      for (const p of list) {
        if (isPanel(p) && !placed.has(p)) {
          zones[z].push(p);
          placed.add(p);
        }
      }
    }
  }
  const floating: GraphFloatingDock[] = [];
  const seenFloat = new Set<string>();
  for (const f of l.floating ?? []) {
    if (!f || !isPanel(f.panel) || placed.has(f.panel) || seenFloat.has(f.panel)) continue;
    seenFloat.add(f.panel);
    floating.push({
      id: f.id,
      panel: f.panel,
      x: clampNum(f.x, 0, 100000, 120),
      y: clampNum(f.y, 0, 100000, 80),
      w: clampNum(f.w, 220, 900, 320),
      h: clampNum(f.h, 140, 700, 260),
      origin: GRAPH_ALL_ZONES.includes(f.origin) ? f.origin : "left",
      active: f.panel,
    });
  }
  floating.forEach((f) => placed.add(f.panel));
  for (const p of GRAPH_ALL_PANELS) {
    if (!placed.has(p)) {
      zones.left.push(p);
      placed.add(p);
    }
  }
  const active = { ...d.active };
  for (const z of GRAPH_ALL_ZONES) {
    const a = l.active?.[z];
    active[z] = zones[z].includes(a as GraphDockPanelId) ? (a as GraphDockPanelId) : zones[z][0];
  }
  return {
    zones,
    active,
    floating,
    sizes: {
      left: clampNum(l.sizes?.left, 180, 560, d.sizes.left),
      right: clampNum(l.sizes?.right, 200, 560, d.sizes.right),
      bottom: clampNum(l.sizes?.bottom, 96, 480, d.sizes.bottom),
    },
  };
}

const DOCK_KEY = "tve:graph:dock-layout:v1";

export const graphDocks = reactive<GraphDockLayout>(defaults());

/** 把已保存布局应用到响应式状态（原位变更，保持页签/浮动的引用稳定） */
function applyLayout(l: Partial<GraphDockLayout> | null): void {
  const n = normalize(l);
  for (const z of GRAPH_ALL_ZONES) {
    const list = graphDocks.zones[z];
    list.splice(0, list.length, ...n.zones[z]);
    graphDocks.active[z] = n.active[z];
  }
  graphDocks.floating = n.floating;
  graphDocks.sizes = { ...n.sizes };
}

/** 启动时从后端 UI 状态装载（异步；就绪前使用缺省布局，蒙版期间应用无感） */
export async function initGraphDocks(): Promise<void> {
  const saved = await uiStateGet<Partial<GraphDockLayout> | null>(DOCK_KEY);
  if (saved) applyLayout(saved);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => JSON.stringify(graphDocks),
  () => {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void uiStateSet(DOCK_KEY, graphDocks);
    }, 300);
  },
);

// 布局操作（与编辑器 docks-layout 同语义）
export function graphPanelZone(panel: GraphDockPanelId): GraphDockZoneId | null {
  for (const z of GRAPH_ALL_ZONES) {
    if (graphDocks.zones[z].includes(panel)) return z;
  }
  return null;
}

export function activate(zone: GraphDockZoneId, panel: GraphDockPanelId) {
  if (graphDocks.zones[zone].includes(panel)) graphDocks.active[zone] = panel;
}

export function removePanel(panel: GraphDockPanelId): GraphDockZoneId | null {
  const from = graphPanelZone(panel);
  if (from) {
    const list = graphDocks.zones[from];
    const i = list.indexOf(panel);
    if (i >= 0) list.splice(i, 1);
    if (graphDocks.active[from] === panel) graphDocks.active[from] = list[0];
  }
  const fi = graphDocks.floating.findIndex((f) => f.panel === panel);
  if (fi >= 0) graphDocks.floating.splice(fi, 1);
  return from;
}

export function dockTo(panel: GraphDockPanelId, zone: GraphDockZoneId, index?: number) {
  const list = graphDocks.zones[zone];
  if (list.includes(panel)) {
    const i = list.indexOf(panel);
    list.splice(i, 1);
    const target = Math.min(index ?? list.length, list.length);
    list.splice(target, 0, panel);
    graphDocks.active[zone] = panel;
    return;
  }
  removePanel(panel);
  const target = Math.min(index ?? list.length, list.length);
  list.splice(target, 0, panel);
  graphDocks.active[zone] = panel;
}

let floatId = 1;
export function floatPanel(panel: GraphDockPanelId, x: number, y: number, origin: GraphDockZoneId) {
  const existed = graphDocks.floating.find((f) => f.panel === panel);
  removePanel(panel);
  graphDocks.floating.push({
    id: existed?.id ?? floatId++,
    panel,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    w: existed?.w ?? 320,
    h: existed?.h ?? 260,
    origin,
    active: panel,
  });
}

export function closeFloating(panel: GraphDockPanelId) {
  const f = graphDocks.floating.find((x) => x.panel === panel);
  if (!f) return;
  dockTo(panel, f.origin);
}
