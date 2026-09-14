// ---------------------------------------------------------------------------
// 导航可视化叠层（framework 层）：烘焙产物 → 顶点色网格。
//
// 叠层是铺在地形表面上方的半透明网格（每格一色），由同步器挂在导航区域节点
// 下渲染：
// - walkable 模式：可行走格绿色 / 不可行走（坡度/高差）暗红 / 障碍投影深红；
// - sdf 模式：SDF 距离场热力图——黄(贴近障碍) → 蓝(远离)，障碍内部红→紫。
// 纯查表着色：烘焙一次、渲染任意久，零实时碰撞计算（性能设计的一部分）。
// 顶点取世界系坐标（节点变换经逆补偿抵消），不随导航区域节点位姿漂移。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { sampleNavHeight, NAV_SURFACE_LIFT, type NavBakeResult } from "./bake";
import type { NavDisplayMode } from "./types";

/** 叠层在地表上方的抬升（避免与地形 z-fighting） */
const OVERLAY_LIFT = NAV_SURFACE_LIFT + 0.08;

/** sdf 热力图色带跨度（米；0 距离 → 黄，5 米 → 蓝，障碍内按深度红→紫） */
const SDF_COLOR_SPAN = 5;

/**
 * 构建叠层网格（display = off 或无烘焙数据时返回 null）。
 * 顶点布局 (w+1)×(h+1) 角点网格；颜色取所属格的烘焙值。
 */
export function buildNavOverlayGeometry(
  nav: NavBakeResult,
  display: NavDisplayMode,
): THREE.BufferGeometry | null {
  if (display === "off") return null;
  const cs = nav.cellSize;
  const gw = nav.w + 1;
  const gh = nav.h + 1;
  const count = gw * gh;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const minX = nav.originX - cs / 2;
  const minZ = nav.originZ - cs / 2;
  const color = { r: 0, g: 0, b: 0 };

  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const vi = j * gw + i;
      const wx = minX + i * cs;
      const wz = minZ + j * cs;
      const wy = sampleNavHeight(nav, wx, wz) + OVERLAY_LIFT;
      positions[vi * 3] = wx;
      positions[vi * 3 + 1] = wy;
      positions[vi * 3 + 2] = wz;
      // 颜色取角点所属格（clamp 到网格内）
      const ci = Math.min(nav.w - 1, i);
      const cj = Math.min(nav.h - 1, j);
      const idx = cj * nav.w + ci;
      if (display === "walkable") {
        walkableColor(nav.walkable[idx] === 1, color);
      } else {
        sdfColor(nav.sdf[idx], color);
      }
      colors[vi * 3] = color.r;
      colors[vi * 3 + 1] = color.g;
      colors[vi * 3 + 2] = color.b;
    }
  }

  // 索引：每格两个三角形
  const indices = new Uint32Array(nav.w * nav.h * 6);
  let t = 0;
  for (let j = 0; j < nav.h; j++) {
    for (let i = 0; i < nav.w; i++) {
      const a = j * gw + i;
      const b = a + 1;
      const c = a + gw;
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/** 可行走模式配色：可行走绿 / 不可行走暗红 */
function walkableColor(walkable: boolean, out: { r: number; g: number; b: number }): void {
  if (walkable) {
    out.r = 0.3;
    out.g = 0.78;
    out.b = 0.42;
  } else {
    out.r = 0.6;
    out.g = 0.18;
    out.b = 0.16;
  }
}

/** SDF 热力图配色：黄(0) → 蓝(远)，障碍内红(浅) → 紫(深) */
function sdfColor(sdf: number, out: { r: number; g: number; b: number }): void {
  if (sdf >= 0) {
    const t = Math.min(1, sdf / SDF_COLOR_SPAN);
    out.r = 0.95 + (0.15 - 0.95) * t;
    out.g = 0.85 + (0.4 - 0.85) * t;
    out.b = 0.3 + (0.9 - 0.3) * t;
  } else {
    const t = Math.min(1, -sdf / (SDF_COLOR_SPAN * 0.5));
    out.r = 0.85 + (0.42 - 0.85) * t;
    out.g = 0.15;
    out.b = 0.15 + (0.45 - 0.15) * t;
  }
}
