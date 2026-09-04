import { docks, type DockZoneId } from "./docks-layout";

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