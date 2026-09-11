import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import { UIWidgetNode, type UIWidgetNodeInit } from "./UIWidgetNode";
import {
  parseUILayoutMode,
  parseUIPadding,
  parseUIFreeVec2,
  type UILayoutMode,
  type UIPadding,
  type Vec2,
} from "./ui-shared";

export interface UILayoutNodeInit extends UIWidgetNodeInit {
  /** 排列方向：none 不排列（纯容器）/ horizontal 横向一行 / vertical 竖向一列 / grid 网格 */
  layoutMode?: UILayoutMode;
  /** 内边距（UI 单位；内容区 = 矩形收进四边） */
  padding?: UIPadding;
  /** 子元素间距（UI 单位；x 横向 / y 纵向） */
  spacing?: Vec2;
  /** 网格列数（grid 模式；行数由子元素数量推导） */
  gridColumns?: number;
}

/** UI 布局容器能力接口：排列模式 + 内边距/间距/网格列数 */
export interface IUILayoutNode extends INode {
  layoutMode: UILayoutMode;
  padding: UIPadding;
  spacing: Vec2;
  gridColumns: number;
}

/**
 * UI 布局容器（Layout Group）：按横向/竖向/网格排列其直接子 UI 节点。
 * - 自身是一个"无形 Widget"：有 size/锚点/SortOrder（可被父布局排列、参与锚点
 *   定位），但不渲染内容——编辑器画布内显示辅助框（选中可点选），运行时为空容器；
 * - 子元素位置由本容器在每帧布局解析中接管（resolveUILayoutCenters），子元素的
 *   anchoredPosition 被忽略（与 Unity Layout Group 同语义）；layoutMode=none 时
 *   子元素回归锚点定位；
 * - 排列顺序 = 层级子节点顺序；子元素在槽位/格子内居中。
 */
export class UILayoutNode extends UIWidgetNode implements IUILayoutNode {
  static override readonly kType: string = "uiLayoutNode";
  override readonly typeKey: string = UILayoutNode.kType;
  layoutMode: UILayoutMode = "none";
  padding: UIPadding = { left: 0, right: 0, top: 0, bottom: 0 };
  spacing: Vec2 = { x: 0, y: 0 };
  gridColumns: number = 2;

  constructor(init: UILayoutNodeInit = {}) {
    super(init);
    this.initWidget(init, { x: 4, y: 4 });
    this.layoutMode = parseUILayoutMode(init.layoutMode ?? this.layoutMode);
    this.padding = parseUIPadding(init.padding, this.padding);
    this.spacing = parseUIFreeVec2(init.spacing, this.spacing);
    this.gridColumns =
      typeof init.gridColumns === "number" && Number.isFinite(init.gridColumns)
        ? Math.max(1, Math.round(init.gridColumns))
        : this.gridColumns;
  }

  override clone(): UILayoutNode {
    return new UILayoutNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      size: this.size,
      sortOrder: this.sortOrder,
      anchorMin: this.anchorMin,
      anchorMax: this.anchorMax,
      pivot: this.pivot,
      anchoredPosition: this.anchoredPosition,
      offsetMin: this.offsetMin,
      offsetMax: this.offsetMax,
      layoutMode: this.layoutMode,
      padding: { ...this.padding },
      spacing: { ...this.spacing },
      gridColumns: this.gridColumns,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeWidget(target);
    target.layoutMode = this.layoutMode;
    target.padding = { ...this.padding };
    target.spacing = { ...this.spacing };
    target.gridColumns = this.gridColumns;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readWidget(source, { x: 4, y: 4 });
    this.layoutMode = parseUILayoutMode(source.layoutMode ?? this.layoutMode);
    this.padding = parseUIPadding(source.padding, this.padding);
    this.spacing = parseUIFreeVec2(source.spacing, this.spacing);
    const cols = source.gridColumns;
    this.gridColumns =
      typeof cols === "number" && Number.isFinite(cols) ? Math.max(1, Math.round(cols)) : this.gridColumns;
  }
}
