import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import { UIWidgetNode, type UIWidgetNodeInit } from "./UIWidgetNode";
import { parseUIColor } from "./ui-shared";

export interface UIImageNodeInit extends UIWidgetNodeInit {
  /** 图片资产相对路径（png/jpg/webp/…；空串 = 纯色矩形） */
  image?: string;
  /** 着色（与图片相乘；无图片时即矩形底色） */
  color?: number;
}

/** UI 图片能力接口：图片资产引用 + 着色 */
export interface IUIImageNode extends INode {
  image: string;
  color: number;
}

/**
 * UI 图片 Widget：画布上的矩形图片（或纯色块）。
 * 图片资产引用按导出产物相对路径解析（与粒子贴图同一打包链路）；
 * 无图片时渲染 color 纯色矩形。着色与图片相乘（MeshBasicMaterial.color × map）。
 */
export class UIImageNode extends UIWidgetNode implements IUIImageNode {
  static override readonly kType: string = "uiImageNode";
  override readonly typeKey: string = UIImageNode.kType;
  image: string = "";
  color: number = 0xffffff;

  constructor(init: UIImageNodeInit = {}) {
    super(init);
    this.initWidget(init, { x: 2, y: 2 });
    this.image = typeof init.image === "string" ? init.image : this.image;
    this.color = parseUIColor(init.color, this.color);
  }

  override clone(): UIImageNode {
    return new UIImageNode({
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
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeWidget(target);
    target.image = this.image;
    target.color = this.color;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readWidget(source, { x: 2, y: 2 });
    this.image = typeof source.image === "string" ? source.image : "";
    this.color = parseUIColor(source.color, this.color);
  }
}
