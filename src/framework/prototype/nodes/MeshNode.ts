import { Node, type NodeInit } from "../Node";
import { cloneRecord, vec3, type Vec3 } from "../types";
import { DEFAULT_MATERIAL_REL } from "../../material/types";

export type GeometryKind = "box" | "sphere" | "plane" | "cylinder";

export interface MeshNodeInit extends NodeInit {
  geometry?: GeometryKind;
  size?: Vec3;
  /** 材质资产引用路径（internal/… 内置或 assets/… 项目资产；默认 internal/materials/Default.mat） */
  material?: string;
}

/**
 * 网格节点：几何 + 材质**资产引用**。
 * 材质参数不再内嵌在节点上，而是由 .mat 资产文件持有（引用可被多个网格共享），
 * 渲染期经 MaterialManager 按引用解析为 three 标准材质参数。
 */
export class MeshNode extends Node {
  static override readonly kType: string = "meshNode";
  override readonly typeKey: string = MeshNode.kType;
  geometry: GeometryKind = "box";
  size: Vec3 = vec3(1, 1, 1);
  material: string = DEFAULT_MATERIAL_REL;

  constructor(init: MeshNodeInit = {}) {
    super(init);
    this.geometry = init.geometry ?? this.geometry;
    this.size = init.size ? { ...init.size } : this.size;
    this.material = init.material ?? this.material;
  }

  override clone(): MeshNode {
    return new MeshNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      geometry: this.geometry,
      size: this.size,
      material: this.material,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.geometry = this.geometry;
    target.size = { ...this.size };
    target.material = this.material;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.geometry = (source.geometry as GeometryKind) ?? this.geometry;
    this.size = (source.size as Vec3) ?? this.size;
    // 旧版场景把材质参数内嵌在节点字段里；现在材质资产化后节点只保存引用。
    // 兼容读取：缺 material 字段时回退内置默认材质（旧内嵌参数交由装载期迁移）。
    this.material = (source.material as string) ?? this.material;
  }

  static fromJSON(json: Record<string, unknown>): MeshNode {
    const node = new MeshNode();
    node.applyJSON(json);
    return node;
  }
}
