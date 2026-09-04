import { reactive } from "vue";
import type { DockPanelId, DockZoneId } from "./docks-layout";
import { docks } from "./docks-layout";

export interface DockDropTarget {
  kind: "zone";
  zone: DockZoneId;
  index: number;
}

export const dockDnd = reactive({
  active: false,
  moved: false,
  panel: null as DockPanelId | null,
  origin: null as DockZoneId | "floating" | null,
  clientX: 0,
  clientY: 0,
  startX: 0,
  startY: 0,
  target: null as DockDropTarget | null,
});

const zoneEls = new Map<DockZoneId, HTMLElement>();
export function registerZoneEl(zone: DockZoneId, el: HTMLElement | null) {
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
  for (const z of ["left", "right", "bottom"] as DockZoneId[]) {
    const el = zoneEls.get(z);
    if (!el || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { kind: "zone", zone: z, index: tabIndexAt(z, x) };
    }
  }
  return null;
}

import { activate, floatPanel, dockTo } from "./docks-layout";

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

    if (dockDnd.moved && origin === "floating") {
      const f = docks.floating.find((w) => w.panel === dockDnd.panel);
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

function finishDrag(x: number, y: number) {
  const { panel, origin, target, moved } = dockDnd;
  if (!panel) return;
  if (!moved) {
    if (origin !== "floating" && origin) activate(origin, panel);
    resetDragState();
    return;
  }
  if (target) {
    dockTo(panel, target.zone, target.index);
  } else if (origin === "floating") {
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