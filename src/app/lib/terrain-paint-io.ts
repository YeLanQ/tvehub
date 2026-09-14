// ---------------------------------------------------------------------------
// 地形绘制落盘（应用层）：splatmap 工作缓冲 → PNG base64。
// 与 TerrainSection「生成 Splatmap」同一条写盘链路（api.writeAssetBinary →
// 引擎 invalidateTerrainSplatmap 失效缓存 → 地形仅重烤颜色纹理）。
// ---------------------------------------------------------------------------

import type { SplatBuffer } from "../../framework/terrain";

// canvas / ctx / ImageData 在会话期间按尺寸复用（splatmap 尺寸 = gridSize 不变），
// 避免每次提交都 createElement + createImageData 的分配开销。
let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _imgData: ImageData | null = null;
let _w = 0;
let _h = 0;

/** 工作缓冲编码为 PNG（canvas 栅格化 → dataURL 取 base64） */
export function encodeSplatBufferPng(buf: SplatBuffer): string {
  if (!_canvas) {
    _canvas = document.createElement("canvas");
    _ctx = _canvas.getContext("2d")!;
  }
  if (_w !== buf.width || _h !== buf.height) {
    _canvas.width = buf.width;
    _canvas.height = buf.height;
    _imgData = _ctx!.createImageData(buf.width, buf.height);
    _w = buf.width;
    _h = buf.height;
  }
  _imgData!.data.set(buf.data);
  _ctx!.putImageData(_imgData!, 0, 0);
  const dataUrl = _canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
