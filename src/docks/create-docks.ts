// ---------------------------------------------------------------------------
// 通用停靠系统工厂（编辑器窗口 / 场景图窗口共用）：
// 布局状态（页签停靠 + 浮动 + 分隔条尺寸）、页签拖拽、后端 UI 状态 KV 持久化。
// 每个窗口在自己的 JS 上下文中实例化一份，面板集/标签/持久化键由配置注入，
// 布局经 storageKey 隔离互不串扰；switchGuard 供宿主拦截面板切换（动画编辑锁）。
// ---------------------------------------------------------------------------

import { reactive, watch } from "vue";
import { uiStateGet, uiStateSet } from "../lib/ui-state";
import type {
  DockDropTarget,
  DockDndState,
  DockLayout,
  DockSystem,
  DockSystemConfig,
  DockZoneId,
  FloatingDock,
} from "./types";
import { DOCK_ZONES } from "./types";

function clampNum(v: unknown, min: number, max: number, def: number): number {
  return typeof v === "number" && isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

export function createDockSystem<P extends string>(cfg: DockSystemConfig<P>): DockSystem<P> {
  const blocked = (panel: P): boolean => cfg.switchGuard?.(panel) ?? false;

  function isPanel(p: unknown): p is P {
    return typeof p === "string" && (cfg.panels as readonly string[]).includes(p);
  }

  function normalize(l: Partial<DockLayout<P>> | null): DockLayout<P> {
    const d = cfg.defaults();
    if (!l) return d;
    const placed = new Set<P>();
    const zones: Record<DockZoneId, P[]> = { left: [], right: [], bottom: [] };
    for (const z of DOCK_ZONES) {
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
    const floating: FloatingDock<P>[] = [];
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
        origin: DOCK_ZONES.includes(f.origin) ? f.origin : "left",
        active: f.panel,
      });
    }
    floating.forEach((f) => placed.add(f.panel));
    for (const p of cfg.panels) {
      if (!placed.has(p)) {
        zones.left.push(p);
        placed.add(p);
      }
    }
    const active = { ...d.active };
    for (const z of DOCK_ZONES) {
      const a = l.active?.[z];
      active[z] = zones[z].includes(a as P) ? (a as P) : zones[z][0];
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

  // Vue reactive 会在类型层面把泛型元素解包为 UnwrapRef<P>；状态内无 ref 嵌套，
  // 运行时就是原对象，断言回 DockLayout<P> 以保住泛型操作的类型
  const layout = reactive(cfg.defaults()) as unknown as DockLayout<P>;

  /** 把已保存布局应用到响应式状态（原位变更，保持页签/浮动的引用稳定） */
  function applyLayout(l: Partial<DockLayout<P>> | null): void {
    const n = normalize(l);
    for (const z of DOCK_ZONES) {
      const list = layout.zones[z];
      list.splice(0, list.length, ...n.zones[z]);
      layout.active[z] = n.active[z];
    }
    layout.floating = n.floating;
    layout.sizes = { ...n.sizes };
  }

  // 持久化：布局变更 300ms 防抖写后端 UI 状态 KV
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    () => JSON.stringify(layout),
    () => {
      if (saveTimer != null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void uiStateSet(cfg.storageKey, layout);
      }, 300);
    },
  );

  // 启动时从后端 UI 状态装载（异步；蒙版期间应用无感）
  const ready: Promise<void> = (async () => {
    const saved = await uiStateGet<Partial<DockLayout<P>> | null>(cfg.storageKey);
    if (saved) applyLayout(saved);
  })();

  // ---- 布局操作 ----
  function panelZone(panel: P): DockZoneId | null {
    for (const z of DOCK_ZONES) {
      if (layout.zones[z].includes(panel)) return z;
    }
    return null;
  }

  function activate(zone: DockZoneId, panel: P): void {
    if (blocked(panel)) return;
    if (layout.zones[zone].includes(panel)) layout.active[zone] = panel;
  }

  function removePanel(panel: P): DockZoneId | null {
    if (blocked(panel)) return null;
    const from = panelZone(panel);
    if (from) {
      const list = layout.zones[from];
      const i = list.indexOf(panel);
      if (i >= 0) list.splice(i, 1);
      if (layout.active[from] === panel) layout.active[from] = list[0];
    }
    const fi = layout.floating.findIndex((f) => f.panel === panel);
    if (fi >= 0) layout.floating.splice(fi, 1);
    return from;
  }

  function dockTo(panel: P, zone: DockZoneId, index?: number): void {
    if (blocked(panel)) return;
    const list = layout.zones[zone];
    if (list.includes(panel)) {
      const i = list.indexOf(panel);
      list.splice(i, 1);
      const target = Math.min(index ?? list.length, list.length);
      list.splice(target, 0, panel);
      layout.active[zone] = panel;
      return;
    }
    removePanel(panel);
    const target = Math.min(index ?? list.length, list.length);
    list.splice(target, 0, panel);
    layout.active[zone] = panel;
  }

  let floatId = 1;
  function floatPanel(panel: P, x: number, y: number, origin: DockZoneId): void {
    if (blocked(panel)) return;
    const existed = layout.floating.find((f) => f.panel === panel);
    removePanel(panel);
    layout.floating.push({
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

  function closeFloating(panel: P): void {
    const f = layout.floating.find((x) => x.panel === panel);
    if (!f) return;
    dockTo(panel, f.origin);
  }

  // ---- 页签拖拽（移动/停靠/浮动/拖回原区激活） ----
  const dnd = reactive({
    active: false,
    moved: false,
    panel: null,
    origin: null,
    clientX: 0,
    clientY: 0,
    startX: 0,
    startY: 0,
    target: null,
  }) as unknown as DockDndState<P>;

  const zoneEls = new Map<DockZoneId, HTMLElement>();
  function registerZoneEl(zone: DockZoneId, el: HTMLElement | null): void {
    if (el) zoneEls.set(zone, el);
    else zoneEls.delete(zone);
  }

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
    for (const z of DOCK_ZONES) {
      const el = zoneEls.get(z);
      if (!el || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { kind: "zone", zone: z, index: tabIndexAt(z, x) };
      }
    }
    return null;
  }

  function beginTabDrag(panel: P, origin: DockZoneId | "floating", clientX: number, clientY: number): void {
    if (dnd.active) return;
    dnd.active = true;
    dnd.moved = false;
    dnd.panel = panel;
    dnd.origin = origin;
    dnd.clientX = clientX;
    dnd.clientY = clientY;
    dnd.startX = clientX;
    dnd.startY = clientY;
    dnd.target = computeTarget(clientX, clientY);
    document.body.classList.add("dock-dragging");

    const onMove = (e: MouseEvent) => {
      dnd.clientX = e.clientX;
      dnd.clientY = e.clientY;
      if (!dnd.moved && Math.hypot(e.clientX - dnd.startX, e.clientY - dnd.startY) >= 4) {
        dnd.moved = true;
      }
      dnd.target = computeTarget(e.clientX, e.clientY);

      if (dnd.moved && origin === "floating") {
        const f = layout.floating.find((w) => w.panel === dnd.panel);
        if (f) {
          f.x = Math.max(0, Math.round(e.clientX - 20));
          f.y = Math.max(0, Math.round(e.clientY - 12));
        }
      }
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

  function finishDrag(x: number, y: number): void {
    const { panel, origin, target, moved } = dnd;
    if (!panel) return;
    if (!moved) {
      if (origin !== "floating" && origin) activate(origin, panel);
      resetDragState();
      return;
    }
    if (target) {
      dockTo(panel, target.zone, target.index);
    } else if (origin === "floating") {
      const f = layout.floating.find((w) => w.panel === panel);
      if (f) {
        f.x = Math.max(0, Math.round(x - 20));
        f.y = Math.max(0, Math.round(y - 12));
      }
    } else {
      floatPanel(panel, x - 90, y - 24, origin ?? "left");
    }
    resetDragState();
  }

  function resetDragState(): void {
    dnd.active = false;
    dnd.moved = false;
    dnd.panel = null;
    dnd.origin = null;
    dnd.target = null;
  }

  // ---- 停靠区分隔条拖拽（调整区域尺寸） ----
  function beginZoneResize(zone: DockZoneId, clientX: number, clientY: number): void {
    const startX = clientX;
    const startY = clientY;
    const startLeft = layout.sizes.left;
    const startRight = layout.sizes.right;
    const startBottom = layout.sizes.bottom;
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
        layout.sizes.left = Math.min(leftMax, Math.max(leftMin, startLeft + dx));
      } else if (zone === "right") {
        layout.sizes.right = Math.min(rightMax, Math.max(rightMin, startRight - dx));
      } else {
        layout.sizes.bottom = Math.min(bottomMax, Math.max(bottomMin, startBottom - dy));
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

  return {
    panelIds: cfg.panels,
    labels: cfg.labels,
    layout,
    dnd,
    ready,
    panelZone,
    activate,
    removePanel,
    dockTo,
    floatPanel,
    closeFloating,
    beginTabDrag,
    registerZoneEl,
    beginZoneResize,
  };
}
