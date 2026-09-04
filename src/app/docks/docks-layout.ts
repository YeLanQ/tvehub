import { reactive, watch } from "vue";

export type DockPanelId = "hierarchy" | "inspector" | "console" | "assets";
export type DockZoneId = "left" | "right" | "bottom";

export interface FloatingDock {
  id: number;
  panel: DockPanelId;
  x: number;
  y: number;
  w: number;
  h: number;
  origin: DockZoneId;
  active: DockPanelId;
}

export interface DockLayout {
  zones: Record<DockZoneId, DockPanelId[]>;
  active: Record<DockZoneId, DockPanelId>;
  floating: FloatingDock[];
  sizes: { left: number; right: number; bottom: number };
}

export const ALL_PANELS: DockPanelId[] = ["hierarchy", "inspector", "console", "assets"];
export const ALL_ZONES: DockZoneId[] = ["left", "right", "bottom"];

export const DOCK_PANEL_LABEL: Record<DockPanelId, string> = {
  hierarchy: "层级",
  inspector: "属性",
  console: "控制台",
  assets: "资产",
};

const LAYOUT_KEY = "three-visual-editor:dock-layout:v2";

function defaults(): DockLayout {
  return {
    zones: { left: ["hierarchy"], right: ["inspector"], bottom: ["console", "assets"] },
    active: { left: "hierarchy", right: "inspector", bottom: "console" },
    floating: [],
    sizes: { left: 270, right: 300, bottom: 180 },
  };
}

function clampNum(v: unknown, min: number, max: number, def: number): number {
  return typeof v === "number" && isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function isPanel(p: unknown): p is DockPanelId {
  return typeof p === "string" && (ALL_PANELS as string[]).includes(p);
}

function normalize(l: Partial<DockLayout> | null): DockLayout {
  const d = defaults();
  if (!l) return d;
  const placed = new Set<DockPanelId>();
  const zones: Record<DockZoneId, DockPanelId[]> = { left: [], right: [], bottom: [] };
  for (const z of ALL_ZONES) {
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
  const floating: FloatingDock[] = [];
  const seenFloat = new Set<string>();
  for (const f of (l.floating ?? [])) {
    if (!f || !isPanel(f.panel) || placed.has(f.panel) || seenFloat.has(f.panel)) continue;
    seenFloat.add(f.panel);
    floating.push({
      id: f.id,
      panel: f.panel,
      x: clampNum(f.x, 0, 100000, 120),
      y: clampNum(f.y, 0, 100000, 80),
      w: clampNum(f.w, 220, 900, 320),
      h: clampNum(f.h, 140, 700, 260),
      origin: ALL_ZONES.includes(f.origin) ? f.origin : "left",
      active: f.panel,
    });
  }
  floating.forEach((f) => placed.add(f.panel));
  for (const p of ALL_PANELS) {
    if (!placed.has(p)) {
      zones.left.push(p);
      placed.add(p);
    }
  }
  const active = { ...d.active };
  for (const z of ALL_ZONES) {
    const a = l.active?.[z];
    active[z] = zones[z].includes(a as DockPanelId) ? (a as DockPanelId) : zones[z][0];
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

function load(): DockLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return defaults();
}

export const docks = reactive<DockLayout>(load());

watch(
  () => JSON.stringify(docks),
  () => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(docks));
    } catch {
      /* ignore */
    }
  },
);

// 布局操作
export function panelZone(panel: DockPanelId): DockZoneId | null {
  for (const z of ALL_ZONES) {
    if (docks.zones[z].includes(panel)) return z;
  }
  return null;
}

export function activate(zone: DockZoneId, panel: DockPanelId) {
  if (docks.zones[zone].includes(panel)) docks.active[zone] = panel;
}

export function removePanel(panel: DockPanelId): DockZoneId | null {
  const from = panelZone(panel);
  if (from) {
    const list = docks.zones[from];
    const i = list.indexOf(panel);
    if (i >= 0) list.splice(i, 1);
    if (docks.active[from] === panel) docks.active[from] = list[0];
  }
  const fi = docks.floating.findIndex((f) => f.panel === panel);
  if (fi >= 0) docks.floating.splice(fi, 1);
  return from;
}

export function dockTo(panel: DockPanelId, zone: DockZoneId, index?: number) {
  const list = docks.zones[zone];
  if (list.includes(panel)) {
    const i = list.indexOf(panel);
    list.splice(i, 1);
    const target = Math.min(index ?? list.length, list.length);
    list.splice(target, 0, panel);
    docks.active[zone] = panel;
    return;
  }
  removePanel(panel);
  const target = Math.min(index ?? list.length, list.length);
  list.splice(target, 0, panel);
  docks.active[zone] = panel;
}

let floatId = 1;
export function floatPanel(panel: DockPanelId, x: number, y: number, origin: DockZoneId) {
  const existed = docks.floating.find((f) => f.panel === panel);
  removePanel(panel);
  docks.floating.push({
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

export function closeFloating(panel: DockPanelId) {
  const f = docks.floating.find((x) => x.panel === panel);
  if (!f) return;
  dockTo(panel, f.origin);
}