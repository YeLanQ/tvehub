import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import { UIWidgetNode, type UIWidgetNodeInit } from "./UIWidgetNode";
import {
  parseUIAlign,
  parseUIFontFamily,
  parseUIFontNumber,
  parseUIColor,
  type UIAlign,
  type UIFontFamily,
} from "./ui-shared";

export interface UITextNodeInit extends UIWidgetNodeInit {
  text?: string;
  /** 字号（设计像素；100px = 1 单位设计标准，映射到 UI 空间 = fontSize/100 个单位） */
  fontSize?: number;
  color?: number;
  bold?: boolean;
  italic?: boolean;
  fontFamily?: UIFontFamily;
  /** 多行文本水平对齐（相对 Widget 矩形） */
  align?: UIAlign;
}

/** UI 文本能力接口：内容 + 字体样式 */
export interface IUITextNode extends INode {
  text: string;
  fontSize: number;
  color: number;
  bold: boolean;
  italic: boolean;
  fontFamily: UIFontFamily;
  align: UIAlign;
}

/**
 * UI 文本 Widget：2D 画布光栅化的多行文本（自动换行，SystemUI/衬线/等宽三种字族）。
 * 字号按设计像素解释（100px = 1 UI 单位，fontSize 像素 → UI 空间 fontSize/100 单位），
 * 与屏幕比例无关：同字号在不同分辨率视口里占屏比例一致。
 */
export class UITextNode extends UIWidgetNode implements IUITextNode {
  static override readonly kType: string = "uiTextNode";
  override readonly typeKey: string = UITextNode.kType;
  text: string = "Text";
  fontSize: number = 24;
  color: number = 0xffffff;
  bold: boolean = false;
  italic: boolean = false;
  fontFamily: UIFontFamily = "system";
  align: UIAlign = "center";

  constructor(init: UITextNodeInit = {}) {
    super(init);
    this.initWidget(init, { x: 4, y: 1 });
    this.text = typeof init.text === "string" ? init.text : this.text;
    this.fontSize = parseUIFontNumber(init.fontSize, this.fontSize, 4, 512);
    this.color = parseUIColor(init.color, this.color);
    this.bold = init.bold ?? this.bold;
    this.italic = init.italic ?? this.italic;
    this.fontFamily = parseUIFontFamily(init.fontFamily);
    this.align = parseUIAlign(init.align);
  }

  override clone(): UITextNode {
    return new UITextNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      size: this.size,
      sortOrder: this.sortOrder,
      text: this.text,
      fontSize: this.fontSize,
      color: this.color,
      bold: this.bold,
      italic: this.italic,
      fontFamily: this.fontFamily,
      align: this.align,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeWidget(target);
    target.text = this.text;
    target.fontSize = this.fontSize;
    target.color = this.color;
    target.bold = this.bold;
    target.italic = this.italic;
    target.fontFamily = this.fontFamily;
    target.align = this.align;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readWidget(source, { x: 4, y: 1 });
    this.text = typeof source.text === "string" ? source.text : "Text";
    this.fontSize = parseUIFontNumber(source.fontSize, this.fontSize, 4, 512);
    this.color = parseUIColor(source.color, this.color);
    this.bold = source.bold === true;
    this.italic = source.italic === true;
    this.fontFamily = parseUIFontFamily(source.fontFamily);
    this.align = parseUIAlign(source.align);
  }
}
