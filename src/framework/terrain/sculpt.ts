// ---------------------------------------------------------------------------
// 地形雕刻（framework 层，纯逻辑）：高度偏移层的盖章计算。
//
// 雕刻不改程序化地形公式，而是在其上叠加一层"高度偏移网格"（gridN²，
// Float32，经 base64 随 TerrainNode.sculpt 持久化）：buildTerrain 叠加偏移后
// 几何/颜色/采样全链路一致。四种模式：
// - raise/lower：沿法向抬升/压低（每章固定流动量 × 强度 × 边缘衰减）；
// - flatten：向笔画起点的目标高度收敛（偏移向 target - base 收敛）；
// - smooth：对组合高度（base + offset）做邻域模糊，偏移随之软化。
// 像素映射与 splatmap 绘制同基准（顶点网格 = segments+1，世界 XZ ↔ 格点互逆）。
// ---------------------------------------------------------------------------

import { worldToSplatPixel } from "./paint";

/** 雕刻偏移层（TerrainNode.sculpt 的形状；data = Float32Array 的 base64） */
export interface TerrainSculptData {
  /** 网格边长（= 生成时地形的 segments + 1；与当前地形设置不一致时不生效） */
  gridN: number;
  /** 高度偏移（行主序 gridN²，世界单位）base64 编码 */
  data: string;
}

export type SculptMode = "raise" | "lower" | "flatten" | "smooth";

/** 雕刻笔刷参数（应用层 UI 持有） */
export interface SculptBrush {
  mode: SculptMode;
  /** 半径（世界单位） */
  radius: number;
  /** 强度 0..1 */
  strength: number;
}

/** 抬升/压低单章流动量（米/章；拖拽沿线多章叠加） */
const SCULPT_FLOW = 0.12;

/** 任意来源 → 收敛的雕刻层数据（非法返回 null） */
export function parseTerrainSculpt(v: unknown): TerrainSculptData | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const gridN =
    typeof o.gridN === "number" && Number.isInteger(o.gridN) && o.gridN >= 2 && o.gridN <= 1024
      ? o.gridN
      : 0;
  if (!gridN || typeof o.data !== "string" || !o.data) return null;
  return { gridN, data: o.data };
}

/** Float32 偏移 → base64（节点 JSON 持久化） */
export function encodeSculptData(offsets: Float32Array): string {
  const bytes = new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Float32 偏移（损坏返回 null） */
export function decodeSculptData(data: string): Float32Array | null {
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

/** 边缘衰减（与 splatmap 笔刷同曲线） */
function falloff(t: number): number {
  const v = 1 - t * t;
  return v * v;
}

/** 单格雕刻（i 已在网格内；a = 衰减 × 强度） */
function applySculpt(
  offsets: Float32Array,
  base: Float32Array,
  gridN: number,
  i: number,
  brush: SculptBrush,
  a: number,
  targetY: number,
): void {
  const k = Math.min(1, brush.strength * a);
  switch (brush.mode) {
    case "raise":
      offsets[i] += SCULPT_FLOW * k;
      break;
    case "lower":
      offsets[i] -= SCULPT_FLOW * k;
      break;
    case "flatten": {
      // 组合高度向目标高度收敛（偏移量承担差值）
      offsets[i] += (targetY - (base[i] + offsets[i])) * Math.min(1, 0.3 * k);
      break;
    }
    case "smooth": {
      // 组合高度的十字邻域均值 → 偏移软化
      const px = i % gridN;
      const py = (i - px) / gridN;
      let sum = base[i] + offsets[i];
      let cnt = 1;
      if (px > 0) {
        const j = i - 1;
        sum += base[j] + offsets[j];
        cnt++;
      }
      if (px < gridN - 1) {
        const j = i + 1;
        sum += base[j] + offsets[j];
        cnt++;
      }
      if (py > 0) {
        const j = i - gridN;
        sum += base[j] + offsets[j];
        cnt++;
      }
      if (py < gridN - 1) {
        const j = i + gridN;
        sum += base[j] + offsets[j];
        cnt++;
      }
      offsets[i] += (sum / cnt - (base[i] + offsets[i])) * Math.min(1, a);
      break;
    }
  }
}

/** 在世界坐标 (wx, wz) 盖一章雕刻笔刷（圆形，影响域 = 半径） */
export function stampSculpt(
  offsets: Float32Array,
  base: Float32Array,
  gridN: number,
  terrainSize: number,
  wx: number,
  wz: number,
  brush: SculptBrush,
  targetY: number,
): void {
  if (brush.radius <= 0 || terrainSize <= 0 || gridN < 2) return;
  const pxPerMeter = (gridN - 1) / terrainSize;
  const cx = worldToSplatPixel(terrainSize, gridN, wx);
  const cy = worldToSplatPixel(terrainSize, gridN, wz);
  const r = Math.max(0.5, brush.radius * pxPerMeter);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(gridN - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(gridN - 1, Math.ceil(cy + r));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px - cx) / r;
      const dz = (py - cy) / r;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 1) continue;
      applySculpt(offsets, base, gridN, py * gridN + px, brush, falloff(d), targetY);
    }
  }
}

/** 沿世界坐标线段连续盖章（拖拽防断触；步长 = 半径 × 0.35） */
export function stampSculptLine(
  offsets: Float32Array,
  base: Float32Array,
  gridN: number,
  terrainSize: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  brush: SculptBrush,
  targetY: number,
): void {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const step = Math.max(0.05, brush.radius * 0.35);
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampSculpt(offsets, base, gridN, terrainSize, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, brush, targetY);
  }
}
