// 矩阵渲染：SVG 输出（深色模块按行合并成一条 path，缩放不糊）。
import type { QrMatrix, QrRenderOptions } from "./types";

/**
 * 二维码墨色与纸色：这是**扫码识别契约，不是主题色**——识别率取决于对比度，
 * 换主题色或反色会直接掉识别率，故不随 ui-kit 主题走，全项目只此一处定义。
 * 深色略偏黑而非纯黑（#111111）：纯黑在部分屏幕反射下边缘更硬，抗锯齿后反而
 * 更易出现宽度不均的模块；浅色必须不透明纯白，透明底在深色页面上会失去静区。
 */
export const QR_INK = "#111111";
export const QR_PAPER = "#ffffff";

/** 矩阵 → SVG：深色模块按行合并为横向矩形段，一条 path 画完（缩放不糊） */
export function qrSvg(matrix: QrMatrix, options: QrRenderOptions = {}): string {
  const scale = options.scale ?? 8;
  const quiet = options.quiet ?? 4;
  const dark = options.dark ?? QR_INK;
  const light = options.light ?? QR_PAPER;
  const total = (matrix.size + quiet * 2) * scale;

  const segs: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.modules[row * matrix.size + col]) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < matrix.size && matrix.modules[row * matrix.size + col + run]) run++;
      segs.push(
        `M${(col + quiet) * scale} ${(row + quiet) * scale}h${run * scale}v${scale}h${-run * scale}z`,
      );
      col += run;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="二维码">`,
    `<rect width="${total}" height="${total}" fill="${light}"/>`,
    `<path d="${segs.join("")}" fill="${dark}"/>`,
    `</svg>`,
  ].join("");
}

/** 矩阵 → 供 canvas 绘制的 module 判定（PNG 导出路径用） */
export function qrModuleAt(matrix: QrMatrix, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size) return false;
  return matrix.modules[row * matrix.size + col];
}
