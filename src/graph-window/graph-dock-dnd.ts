// 脚本图窗口停靠拖拽（编辑器 docks-dnd 的图窗口版，逻辑一致）
import { reactive } from "vue";
import { activate, dockTo, floatPanel, graphDocks } from "./docks";
import type { GraphDockPanelId, GraphDockZoneId } from "./docks";

export interface GraphDockDropTarget {
  kind: "zone";
  zone: GraphDockZoneId;
  index: number;
}

export const graphDockDnd = reactive({
  active: false,
  moved: false,
  panel: null as GraphDockPanelId | null,
  origin: null as GraphDockZoneId | "floating" | null,
  clientX: 0,
  clientY: 0,
  startX: 0,
  startY: 0,
  target: null as GraphDockDropTarget | null,
});

const zoneEls = new Map<GraphDockZoneId, HTMLElement>();
export function registerZoneEl(zone: GraphDockZoneId, el: HTMLElement | null) {
  if (el) zoneEls.set(zone, el);
  else zoneEls.delete(zone);
}

function tabIndexAt(zone: GraphDockZoneId, x: number): number {
  const el = zoneEls.get(zone);
  if (!el) return 0;
  const tabs = Array.from(el.querySelectorAll<HTMLElement>("[data-dock-tab]"));
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

function computeTarget(x: number, y: number): GraphDockDropTarget | null {
  for (const z of ["left", "right", "bottom"] as GraphDockZoneId[]) {
    const el = zoneEls.get(z);
    if (!el || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { kind: "zone", zone: z, index: tabIndexAt(z, x) };
    }
  }
  return null;
}

export function beginTabDrag(
  panel: GraphDockPanelId,
  origin: GraphDockZoneId | "floating",
  clientX: number,
  clientY: number,
) {
  if (graphDockDnd.active) return;
  graphDockDnd.active = true;
  graphDockDnd.moved = false;
  graphDockDnd.panel = panel;
  graphDockDnd.origin = origin;
  graphDockDnd.clientX = clientX;
  graphDockDnd.clientY = clientY;
  graphDockDnd.startX = clientX;
  graphDockDnd.startY = clientY;
  graphDockDnd.target = computeTarget(clientX, clientY);
  document.body.classList.add("dock-dragging");

  const onMove = (e: MouseEvent) => {
    graphDockDnd.clientX = e.clientX;
    graphDockDnd.clientY = e.clientY;
    if (!graphDockDnd.moved && Math.hypot(e.clientX - graphDockDnd.startX, e.clientY - graphDockDnd.startY) >= 4) {
      graphDockDnd.moved = true;
    }
    graphDockDnd.target = computeTarget(e.clientX, e.clientY);

    if (graphDockDnd.moved && origin === "floating") {
      const f = graphDocks.floating.find((w) => w.panel === graphDockDnd.panel);
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
  const { panel, origin, target, moved } = graphDockDnd;
  if (!panel) return;
  if (!moved) {
    if (origin !== "floating" && origin) activate(origin, panel);
    resetDragState();
    return;
  }
  if (target) {
    dockTo(panel, target.zone, target.index);
  } else if (origin === "floating") {
    const f = graphDocks.floating.find((w) => w.panel === panel);
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
  graphDockDnd.active = false;
  graphDockDnd.moved = false;
  graphDockDnd.panel = null;
  graphDockDnd.origin = null;
  graphDockDnd.target = null;
}

