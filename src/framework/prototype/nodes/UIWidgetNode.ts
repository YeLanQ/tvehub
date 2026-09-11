import { Node, type NodeInit } from "../Node";
import { clampUISortOrder, parseVec2, vec2, type Vec2 } from "./ui-shared";

export interface UIWidgetNodeInit extends NodeInit {
  /** Widget 矩形尺寸（UI 单位；几何按此构建，transform.scale 再叠加） */
  size?: Vec2;
  /** 画布内排序：同一画布里 sortOrder 大的 Widget 叠在上层 */
  sortOrder?: number;
}

/**
 * UI Widget 基类（抽象）：画布上的可渲染 UI 元素共有字段。
 * - size：矩形尺寸（UI 单位），几何按尺寸构建（改尺寸重建几何，与 meshNode.size 同策略）；
 * - sortOrder：画布内叠加序；渲染序 = 画布 sortOrder×1e4 + 本值（材质关深度测试按序叠加）。
 * 渲染侧约束（编辑器 SceneSynchronizer / 运行时 ui.mjs 同一语义）：
 * 透明 + 不写深度 + 关深度测试 + frustumCulled 关（贴合相机后位于近处）。
 */
export abstract class UIWidgetNode extends Node {
  size: Vec2 = vec2(2, 2);
  sortOrder: number = 0;

  protected initWidget(init: UIWidgetNodeInit, defaultSize: Vec2): void {
    this.size = parseVec2(init.size, defaultSize);
    this.sortOrder = clampUISortOrder(init.sortOrder, this.sortOrder);
  }

  protected readWidget(source: Record<string, unknown>, defaultSize: Vec2): void {
    this.size = parseVec2(source.size, this.size ?? defaultSize);
    this.sortOrder = clampUISortOrder(source.sortOrder, this.sortOrder);
  }

  protected writeWidget(target: Record<string, unknown>): void {
    target.size = { ...this.size };
    target.sortOrder = this.sortOrder;
  }
}
