// ---------------------------------------------------------------------------
// 地形笔刷绘制（framework 层，纯逻辑，无 DOM/渲染依赖）。
//
// 地形表面绘制 = 直接修改 .terrainmat 已绑定的 splatmap（RGBA 四通道 = 材质
// 层 0..3 的混合权重，与 SceneSynchronizer.loadSplatmap / bakeColorTexture 的
// 采样语义一致：UV = 世界 XZ / 地形边长 + 0.5，最近邻取样，通道值/255 为权重）。
// 笔刷在权重上做"朝目标收敛 + 其余通道归一化"的增量更新：反复涂抹平滑收敛到
// 目标层，擦除把该层权重转移回其余层；不需要额外的地形数据格式。
// ---------------------------------------------------------------------------

/** splatmap 工作缓冲（RGBA，每通道 0..255；与 canvas ImageData 同构） */
export interface SplatBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 笔刷参数（应用层 UI 持有；layer = 材质层 0..3 对应 RGBA 通道） */
export interface SplatBrush {
  /** 目标材质层（0..3 = splatmap R/G/B/A 通道） */
  layer: number;
  /** 笔刷半径（世界单位/米） */
  radius: number;
  /** 单次涂抹强度 0..1（乘以边缘衰减后作为收敛速度） */
  strength: number;
  /** 擦除模式：把该层权重抹回其余层 */
  erase: boolean;
}

/** 世界坐标 → splatmap 像素（与 bakeColorTexture 的取样映射互逆） */
export function worldToSplatPixel(terrainSize: number, dim: number, w: number): number {
  return Math.round((w / terrainSize + 0.5) * (dim - 1));
}

/** splatmap 像素 → 世界坐标（像素中心） */
export function splatPixelToWorld(terrainSize: number, dim: number, px: number): number {
  return (px / (dim - 1) - 0.5) * terrainSize;
}

/** 边缘衰减：中心 1，边缘 0（平滑二次曲线，避免硬边） */
function falloff(t: number): number {
  const v = 1 - t * t;
  return v * v;
}

/** 单像素增量：目标通道朝 0/255 收敛，其余通道归一化保持总权重 255 */
function applyStamp(buf: SplatBuffer, px: number, py: number, brush: SplatBrush, a: number): void {
  const p = (py * buf.width + px) * 4;
  const L = brush.layer;
  const target = brush.erase ? 0 : 255;
  const cur = buf.data[p + L];
  buf.data[p + L] = cur + (target - cur) * Math.min(1, brush.strength * a);
  // 其余通道按原比例缩放到剩余权重（总权重恒 ≈ 255）；其余通道全为零时均分，
  // 避免擦除"孤层"像素时权重无处可去（全黑空洞）
  const remaining = 255 - buf.data[p + L];
  let others = 0;
  for (let c = 0; c < 4; c++) if (c !== L) others += buf.data[p + c];
  if (others > 0) {
    const k = remaining / others;
    for (let c = 0; c < 4; c++) if (c !== L) buf.data[p + c] *= k;
  } else {
    const each = remaining / 3;
    for (let c = 0; c < 4; c++) if (c !== L) buf.data[p + c] = each;
  }
}

/** 在世界坐标 (wx, wz) 盖一章笔刷（圆形，半径按世界单位换算到像素） */
export function stampSplat(
  buf: SplatBuffer,
  terrainSize: number,
  wx: number,
  wz: number,
  brush: SplatBrush,
): void {
  const r = brush.radius;
  if (r <= 0 || terrainSize <= 0) return;
  const pxPerMeterX = (buf.width - 1) / terrainSize;
  const pxPerMeterZ = (buf.height - 1) / terrainSize;
  const cx = worldToSplatPixel(terrainSize, buf.width, wx);
  const cy = worldToSplatPixel(terrainSize, buf.height, wz);
  const rX = Math.max(0.5, r * pxPerMeterX);
  const rZ = Math.max(0.5, r * pxPerMeterZ);
  const x0 = Math.max(0, Math.floor(cx - rX));
  const x1 = Math.min(buf.width - 1, Math.ceil(cx + rX));
  const y0 = Math.max(0, Math.floor(cy - rZ));
  const y1 = Math.min(buf.height - 1, Math.ceil(cy + rZ));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px - cx) / rX;
      const dz = (py - cy) / rZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 1) continue;
      applyStamp(buf, px, py, brush, falloff(d));
    }
  }
}

/**
 * 沿世界坐标线段连续盖章（拖拽绘制防断触）：步长 = 半径 × 0.35，
 * 保证相邻章的中心区域重叠。
 */
export function stampSplatLine(
  buf: SplatBuffer,
  terrainSize: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  brush: SplatBrush,
): void {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const step = Math.max(0.05, brush.radius * 0.35);
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampSplat(buf, terrainSize, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, brush);
  }
}
