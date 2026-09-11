import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import { clampUICanvasSortOrder } from "./ui-shared";

/** UI 画布渲染模式（当前只有屏幕叠加；保留字段给未来的世界空间画布） */
export type UIRenderMode = "overlay";

export interface UICanvasNodeInit extends NodeInit {
  renderMode?: UIRenderMode;
  /** 画布整体排序：多画布叠加时先按此比较（大者在上），再比画布内 Widget 的 sortOrder */
  sortOrder?: number;
}

/** UI 画布能力接口：渲染模式 + 画布级排序 */
export interface IUICanvasNode extends INode {
  renderMode: UIRenderMode;
  sortOrder: number;
}

/**
 * UI 画布节点（Canvas-Widget 的 Canvas）：UI Widget 的容器根。
 * - 渲染：屏幕叠加（相机叠加）——画布空间每帧贴合活动渲染相机（原点 = 屏幕中心，
 *   +x 右 +y 上，纵向可见 2×UI_HALF_HEIGHT 个 UI 单位），画布自身变换不参与取景，
 *   子节点的 transform 即 UI 坐标（z 只影响叠加序内的深度无关排序）；
 * - 排序：renderOrder = 画布 sortOrder（权重 1e4）+ Widget sortOrder，
 *   材质统一关深度测试，按 renderOrder 从小到大叠加。
 */
export class UICanvasNode extends Node {
  static override readonly kType: string = "uiCanvasNode";
  override readonly typeKey: string = UICanvasNode.kType;
  renderMode: UIRenderMode = "overlay";
  sortOrder: number = 0;

  constructor(init: UICanvasNodeInit = {}) {
    super(init);
    this.renderMode = init.renderMode === "overlay" ? "overlay" : this.renderMode;
    this.sortOrder = clampUICanvasSortOrder(init.sortOrder, this.sortOrder);
  }

  override clone(): UICanvasNode {
    return new UICanvasNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      renderMode: this.renderMode,
      sortOrder: this.sortOrder,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.renderMode = this.renderMode;
    target.sortOrder = this.sortOrder;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.renderMode = source.renderMode === "overlay" ? "overlay" : "overlay";
    this.sortOrder = clampUICanvasSortOrder(source.sortOrder, this.sortOrder);
  }
}
