import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import { clampUICanvasSortOrder, parseUIDesignPx, parseUIScaleMode, type UIScaleMode } from "./ui-shared";

/** UI 画布渲染模式（当前只有屏幕叠加；保留字段给未来的世界空间画布） */
export type UIRenderMode = "overlay";

export interface UICanvasNodeInit extends NodeInit {
  renderMode?: UIRenderMode;
  /** 画布整体排序：多画布叠加时先按此比较（大者在上），再比画布内 Widget 的 sortOrder */
  sortOrder?: number;
  /** 设计宽度（设计像素；默认取项目设置设计分辨率，100px = 1 UI 单位） */
  designWidth?: number;
  /** 设计高度（设计像素；默认取项目设置设计分辨率） */
  designHeight?: number;
  /** 屏幕适配方案（与项目设置缩放模式同一名集；仅预览/构建产物运行时生效，
   *  编辑器布局视图恒按设计尺寸 1:1 显示；默认 fixedauto 等比铺满裁切） */
  scaleMode?: UIScaleMode;
}

/** UI 画布能力接口：渲染模式 + 画布级排序 + 渲染尺寸/适配 */
export interface IUICanvasNode extends INode {
  renderMode: UIRenderMode;
  sortOrder: number;
  designWidth: number;
  designHeight: number;
  scaleMode: UIScaleMode;
}

/**
 * UI 画布节点（Canvas-Widget 的 Canvas）：UI Widget 的容器根。
 * - 渲染：屏幕叠加（相机叠加）——画布空间每帧贴合活动渲染相机（原点 = 屏幕中心，
 *   +x 右 +y 上），画布自身变换不参与取景；
 * - 渲染尺寸：designWidth × designHeight 设计像素（100px = 1 UI 单位），默认取
 *   项目设置的设计分辨率与屏幕方向；画布矩形按 scaleMode（项目缩放模式语义）
 *   映射到屏幕：noscale 原尺寸 / fixedwidth 定宽 / fixedheight 定高 /
 *   fixedauto 等比铺满裁切 / full 拉伸铺满；
 * - 定位：子节点经锚点系统相对画布矩形定位（见 ui-shared resolveUIRect）；
 * - 排序：renderOrder = 画布 sortOrder（权重 1e4）+ Widget sortOrder，
 *   材质统一关深度测试，按 renderOrder 从小到大叠加。
 */
export class UICanvasNode extends Node {
  static override readonly kType: string = "uiCanvasNode";
  override readonly typeKey: string = UICanvasNode.kType;
  renderMode: UIRenderMode = "overlay";
  sortOrder: number = 0;
  designWidth: number = 1280;
  designHeight: number = 720;
  scaleMode: UIScaleMode = "fixedauto";

  constructor(init: UICanvasNodeInit = {}) {
    super(init);
    this.renderMode = init.renderMode === "overlay" ? "overlay" : this.renderMode;
    this.sortOrder = clampUICanvasSortOrder(init.sortOrder, this.sortOrder);
    this.designWidth = parseUIDesignPx(init.designWidth, this.designWidth);
    this.designHeight = parseUIDesignPx(init.designHeight, this.designHeight);
    this.scaleMode = parseUIScaleMode(init.scaleMode ?? this.scaleMode);
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
      designWidth: this.designWidth,
      designHeight: this.designHeight,
      scaleMode: this.scaleMode,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.renderMode = this.renderMode;
    target.sortOrder = this.sortOrder;
    target.designWidth = this.designWidth;
    target.designHeight = this.designHeight;
    target.scaleMode = this.scaleMode;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.renderMode = source.renderMode === "overlay" ? "overlay" : "overlay";
    this.sortOrder = clampUICanvasSortOrder(source.sortOrder, this.sortOrder);
    this.designWidth = parseUIDesignPx(source.designWidth, this.designWidth);
    this.designHeight = parseUIDesignPx(source.designHeight, this.designHeight);
    this.scaleMode = parseUIScaleMode(source.scaleMode ?? this.scaleMode);
  }
}
