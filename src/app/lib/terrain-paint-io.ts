// ---------------------------------------------------------------------------
// 地形绘制落盘（应用层）：splatmap 工作缓冲 → PNG base64。
// 与 TerrainSection「生成 Splatmap」同一条写盘链路（api.writeAssetBinary →
// 引擎 invalidateTerrainSplatmap 失效缓存 → 地形仅重烤颜色纹理）。
// ---------------------------------------------------------------------------

import type { SplatBuffer } from "../../framework/terrain";

/** 工作缓冲编码为 PNG（canvas 栅格化 → dataURL 取 base64） */
export function encodeSplatBufferPng(buf: SplatBuffer): string {
  const canvas = document.createElement("canvas");
  canvas.width = buf.width;
  canvas.height = buf.height;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(buf.width, buf.height);
  imgData.data.set(buf.data);
  ctx.putImageData(imgData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
