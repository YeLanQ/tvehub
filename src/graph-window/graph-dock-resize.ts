// 脚本图窗口停靠区分隔条拖拽（编辑器 docks-resize 的图窗口版，逻辑一致）
import { graphDocks, type GraphDockZoneId } from "./docks";

export function beginZoneResize(zone: GraphDockZoneId, clientX: number, clientY: number) {
  const startX = clientX;
  const startY = clientY;
  const startLeft = graphDocks.sizes.left;
  const startRight = graphDocks.sizes.right;
  const startBottom = graphDocks.sizes.bottom;
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
      graphDocks.sizes.left = Math.min(leftMax, Math.max(leftMin, startLeft + dx));
    } else if (zone === "right") {
      graphDocks.sizes.right = Math.min(rightMax, Math.max(rightMin, startRight - dx));
    } else {
      graphDocks.sizes.bottom = Math.min(bottomMax, Math.max(bottomMin, startBottom - dy));
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
