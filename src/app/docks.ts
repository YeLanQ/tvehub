import { reactive, watch } from "vue";

/**
 * 编辑器停靠布局（Unity 风格）：
 * 层级 / 属性 / 控制台 / 资产 四个面板可跨区域拖拽停靠（左侧 / 右侧 / 底部三个停靠区，
 * 支持同一区域内多个标签页与重排），拖到空白处成为浮动窗口；布局持久化到 localStorage。
 * 中央区域（3D 视口）不是可停靠面板，始终保持。
 */
export type DockPanelId = "hierarchy" | "inspector" | "console" | "assets";
export type DockZoneId = "left" | "right" | "bottom";

export interface FloatingDock {
  id: number;
  panel: DockPanelId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 浮动前的停靠区：关闭浮动窗口时返回该区 */
  origin: DockZoneId;
}

export interface DockLayout {
  /** 各停靠区的面板标签顺序 */
  zones: Record<DockZoneId, DockPanelId[]>;
  /** 各停靠区当前激活标签 */
  active: Record<DockZoneId, DockPanelId>;
  floating: FloatingDock[];
  /** 停靠区尺寸：left/right 宽度（px），bottom 高度（px） */
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

/** 校验/规范化持久化布局：面板去重、补齐缺失面板、尺寸夹取 */
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
    });
  }
  floating.forEach((f) => placed.add(f.panel));
  // 未放置的面板放回默认区域
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

// ---------------------------------------------------------------------------
// 布局操作
// ---------------------------------------------------------------------------
export function panelZone(panel: DockPanelId): DockZoneId | null {
  for (const z of ALL_ZONES) {
    if (docks.zones[z].includes(panel)) return z;
  }
  return null;
}

/** 激活停靠区内的标签 */
export function activate(zone: DockZoneId, panel: DockPanelId) {
  if (docks.zones[zone].includes(panel)) docks.active[zone] = panel;
}

/** 移除面板当前所在位置（区域/浮动），返回其来源区域 */
function removePanel(panel: DockPanelId): DockZoneId | null {
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

/** 把面板停靠到某区域（index 为插入位置，缺省末尾），并激活 */
export function dockTo(panel: DockPanelId, zone: DockZoneId, index?: number) {
  const list = docks.zones[zone];
  if (list.includes(panel)) {
    // 区域内重排
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
/** 把面板浮出为独立窗口（x/y 为窗口左上角） */
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
  });
}

/** 关闭浮动窗口：回到来源停靠区 */
export function closeFloating(panel: DockPanelId) {
  const f = docks.floating.find((x) => x.panel === panel);
  if (!f) return;
  dockTo(panel, f.origin);
}

// ---------------------------------------------------------------------------
// 标签拖拽（Unity 风格停靠）
// ---------------------------------------------------------------------------
export interface DockDropTarget {
  kind: "zone";
  zone: DockZoneId;
  /** 插入位置（标签条上的索引） */
  index: number;
}

export const dockDnd = reactive({
  active: false,
  /** 是否已产生实际位移（>=4px）：决定捕获层/幽灵是否显示、以及点击与拖拽的区分 */
  moved: false,
  panel: null as DockPanelId | null,
  /** 拖拽起点：停靠区标签 / 浮动窗口标题 */
  origin: null as DockZoneId | "floating" | null,
  clientX: 0,
  clientY: 0,
  /** 按下时的起始坐标（判断是否为拖拽：位移过小视为点击） */
  startX: 0,
  startY: 0,
  target: null as DockDropTarget | null,
});

/** 停靠区 DOM 元素注册表（拖拽期间计算落点矩形用） */
const zoneEls = new Map<DockZoneId, HTMLElement>();
export function registerZoneEl(zone: DockZoneId, el: HTMLElement | null) {
  if (el) zoneEls.set(zone, el);
  else zoneEls.delete(zone);
}

/** 查询某区域标签条上，x 坐标对应的插入位置索引 */
function tabIndexAt(zone: DockZoneId, x: number): number {
  const el = zoneEls.get(zone);
  if (!el) return 0;
  const tabs = Array.from(el.querySelectorAll<HTMLElement>("[data-dock-tab]"));
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

function computeTarget(x: number, y: number): DockDropTarget | null {
  for (const z of ALL_ZONES) {
    const el = zoneEls.get(z);
    if (!el || el.offsetParent === null) continue; // 隐藏/未挂载跳过
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { kind: "zone", zone: z, index: tabIndexAt(z, x) };
    }
  }
  return null;
}

/** 开始标签拖拽（origin：来源停靠区或 "floating" 浮动窗口） */
export function beginTabDrag(
  panel: DockPanelId,
  origin: DockZoneId | "floating",
  clientX: number,
  clientY: number,
) {
  if (dockDnd.active) return;
  dockDnd.active = true;
  dockDnd.moved = false;
  dockDnd.panel = panel;
  dockDnd.origin = origin;
  dockDnd.clientX = clientX;
  dockDnd.clientY = clientY;
  dockDnd.startX = clientX;
  dockDnd.startY = clientY;
  dockDnd.target = computeTarget(clientX, clientY);
  document.body.classList.add("dock-dragging");

  const onMove = (e: MouseEvent) => {
    dockDnd.clientX = e.clientX;
    dockDnd.clientY = e.clientY;
    if (!dockDnd.moved && Math.hypot(e.clientX - dockDnd.startX, e.clientY - dockDnd.startY) >= 4) {
      dockDnd.moved = true;
    }
    dockDnd.target = computeTarget(e.clientX, e.clientY);
  };
  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    document.body.classList.remove("dock-dragging");
  };
  const onUp = (e: MouseEvent) => {
    finishDrag(e.clientX, e.clientY);
    cleanup();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      resetDragState();
      cleanup();
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey);
}

function finishDrag(x: number, y: number) {
  const { panel, origin, target, moved } = dockDnd;
  if (!panel) return;
  if (!moved) {
    // 几乎无位移 = 点击：直接激活（click 事件可能被后续 DOM 变更吞掉，这里兜底）
    if (origin !== "floating" && origin) activate(origin, panel);
    resetDragState();
    return;
  }
  if (target) {
    dockTo(panel, target.zone, target.index);
  } else if (origin === "floating") {
    // 浮动窗口拖到空白处 → 移动窗口位置
    const f = docks.floating.find((w) => w.panel === panel);
    if (f) {
      f.x = Math.max(0, Math.round(x - 20));
      f.y = Math.max(0, Math.round(y - 12));
    }
  } else {
    floatPanel(panel, x - 90, y - 24, origin ?? "left");
  }
  resetDragState();
}

function resetDragState() {
  dockDnd.active = false;
  dockDnd.moved = false;
  dockDnd.panel = null;
  dockDnd.origin = null;
  dockDnd.target = null;
}

// ---------------------------------------------------------------------------
// 停靠区分隔条拖拽（调整区域尺寸）
// ---------------------------------------------------------------------------
export function beginZoneResize(zone: DockZoneId, clientX: number, clientY: number) {
  const startX = clientX;
  const startY = clientY;
  const startLeft = docks.sizes.left;
  const startRight = docks.sizes.right;
  const startBottom = docks.sizes.bottom;
  document.body.classList.add("dock-resizing");
  const leftMin = 180;
  const rightMin = 200;
  const bottomMin = 96;
  const leftMax = 560;
  const rightMax = 560;
  const bottomMax = 480;
  const onMove = (e: MouseEvent) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (zone === "left") {
      docks.sizes.left = Math.min(leftMax, Math.max(leftMin, startLeft + dx));
    } else if (zone === "right") {
      docks.sizes.right = Math.min(rightMax, Math.max(rightMin, startRight - dx));
    } else {
      docks.sizes.bottom = Math.min(bottomMax, Math.max(bottomMin, startBottom - dy));
    }
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("dock-resizing");
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}