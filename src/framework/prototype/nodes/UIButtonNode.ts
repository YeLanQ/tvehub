import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import { UIWidgetNode, type UIWidgetNodeInit } from "./UIWidgetNode";
import { parseUIFontNumber, parseUIColor } from "./ui-shared";

export interface UIButtonNodeInit extends UIWidgetNodeInit {
  /** 背景图片资产引用（空串 = 纯色背景） */
  image?: string;
  /** 背景着色（与背景图片相乘；无图片时即底色） */
  color?: number;
  label?: string;
  labelColor?: number;
  /** 标签字号（与文本 Widget 同一设计像素语义，100px = 1 单位） */
  fontSize?: number;
  labelBold?: boolean;
  /** 可交互：运行时参与指针点击命中（false 时仅展示） */
  interactable?: boolean;
}

/** UI 按钮能力接口：背景 + 标签 + 交互开关 */
export interface IUIButtonNode extends INode {
  image: string;
  color: number;
  label: string;
  labelColor: number;
  fontSize: number;
  labelBold: boolean;
  interactable: boolean;
}

/**
 * UI 按钮 Widget：背景（图片或纯色）+ 居中标签，运行时可点击。
 * 点击命中在画布空间做反投影 + 矩形命中测试（按渲染序取最上层）；
 * 脚本经 engine.ui.onClick(entity, cb) 订阅点击回调。
 */
export class UIButtonNode extends UIWidgetNode implements IUIButtonNode {
  static override readonly kType: string = "uiButtonNode";
  override readonly typeKey: string = UIButtonNode.kType;
  image: string = "";
  color: number = 0xc8c8c8;
  label: string = "Button";
  labelColor: number = 0x202020;
  fontSize: number = 24;
  labelBold: boolean = false;
  interactable: boolean = true;

  constructor(init: UIButtonNodeInit = {}) {
    super(init);
    this.initWidget(init, { x: 2, y: 0.8 });
    this.image = typeof init.image === "string" ? init.image : this.image;
    this.color = parseUIColor(init.color, this.color);
    this.label = typeof init.label === "string" ? init.label : this.label;
    this.labelColor = parseUIColor(init.labelColor, this.labelColor);
    this.fontSize = parseUIFontNumber(init.fontSize, this.fontSize, 4, 512);
    this.labelBold = init.labelBold ?? this.labelBold;
    this.interactable = init.interactable ?? this.interactable;
  }

  override clone(): UIButtonNode {
    return new UIButtonNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      size: this.size,
      sortOrder: this.sortOrder,
      image: this.image,
      color: this.color,
      label: this.label,
      labelColor: this.labelColor,
      fontSize: this.fontSize,
      labelBold: this.labelBold,
      interactable: this.interactable,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeWidget(target);
    target.image = this.image;
    target.color = this.color;
    target.label = this.label;
    target.labelColor = this.labelColor;
    target.fontSize = this.fontSize;
    target.labelBold = this.labelBold;
    target.interactable = this.interactable;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readWidget(source, { x: 2, y: 0.8 });
    this.image = typeof source.image === "string" ? source.image : "";
    this.color = parseUIColor(source.color, this.color);
    this.label = typeof source.label === "string" ? source.label : "Button";
    this.labelColor = parseUIColor(source.labelColor, this.labelColor);
    this.fontSize = parseUIFontNumber(source.fontSize, this.fontSize, 4, 512);
    this.labelBold = source.labelBold === true;
    this.interactable = source.interactable !== false;
  }
}
