import { Node, type NodeInit } from "../Node";
import { cloneRecord, vec3, type Vec3 } from "../types";
import { DEFAULT_MATERIAL_REL } from "../../material/types";
import type { MeshSourceKind } from "../../mesh/types";
import type { GeometryKind } from "../../mesh/geometry";
import {
  cloneAnimGraph,
  parseAnimGraph,
  parseClipSettings,
  type AnimClipSettings,
  type AnimGraph,
} from "../../animation";

export type { GeometryKind };

export interface MeshNodeInit extends NodeInit {
  geometry?: GeometryKind;
  size?: Vec3;
  /** 材质资产引用路径（internal/… 内置或 assets/… 项目资产；默认 internal/materials/Default.mat） */
  material?: string;
  /** 网格来源：基元（默认）/ 模型资产 */
  source?: MeshSourceKind;
  /** 模型资产引用（source=model 时有效） */
  model?: string;
  /** 单剪辑播放设置（source=model 时有效） */
  anim?: AnimClipSettings;
  /** 动画图（source=model 时优先于单剪辑；null = 未使用图模式） */
  animGraph?: AnimGraph | null;
}

/**
 * 网格节点：两种网格来源 + 材质**资产引用** + 动画数据。
 * - source=primitive：基元几何（geometry/size）+ 材质资产引用（material），
 *   材质参数由 .mat 资产文件持有，渲染期经 MaterialManager 解析；
 * - source=model：模型资产引用（model，glb/gltf/fbx/obj），几何/材质随模型
 *   内嵌；动画剪辑由模型携带，节点上的 anim（单剪辑）与 animGraph（动画图）
 *   描述播放意图，运行时由 AnimationSystem 驱动（含骨骼动画）。
 */
export class MeshNode extends Node {
  static override readonly kType: string = "meshNode";
  override readonly typeKey: string = MeshNode.kType;
  source: MeshSourceKind = "primitive";
  geometry: GeometryKind = "box";
  size: Vec3 = vec3(1, 1, 1);
  material: string = DEFAULT_MATERIAL_REL;
  /** 模型资产引用（空串 = 未绑定模型） */
  model: string = "";
  /** 单剪辑播放设置（动画图存在时被其覆盖） */
  anim: AnimClipSettings = { autoplay: true, clip: "", speed: 1, loop: "loop" };
  /** 动画图（null = 单剪辑模式） */
  animGraph: AnimGraph | null = null;

  constructor(init: MeshNodeInit = {}) {
    super(init);
    this.source = init.source ?? this.source;
    this.geometry = init.geometry ?? this.geometry;
    this.size = init.size ? { ...init.size } : this.size;
    this.material = init.material ?? this.material;
    this.model = init.model ?? this.model;
    this.anim = init.anim ? { ...init.anim } : { ...this.anim };
    this.animGraph = init.animGraph ? cloneAnimGraph(init.animGraph) : null;
  }

  override clone(): MeshNode {
    return new MeshNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      prefab: this.prefab,
      components: this.components,
      source: this.source,
      geometry: this.geometry,
      size: this.size,
      material: this.material,
      model: this.model,
      anim: { ...this.anim },
      animGraph: this.animGraph ? cloneAnimGraph(this.animGraph) : null,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.source = this.source;
    target.geometry = this.geometry;
    target.size = { ...this.size };
    target.material = this.material;
    target.model = this.model;
    target.anim = { ...this.anim };
    target.animGraph = this.animGraph ? cloneAnimGraph(this.animGraph) : null;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    // 旧版场景无 source 字段 → 回退基元（既有行为不变）
    this.source = source.source === "model" ? "model" : "primitive";
    this.geometry = (source.geometry as GeometryKind) ?? this.geometry;
    this.size = (source.size as Vec3) ?? this.size;
    // 旧版场景把材质参数内嵌在节点字段里；现在材质资产化后节点只保存引用。
    // 兼容读取：缺 material 字段时回退内置默认材质（旧内嵌参数交由装载期迁移）。
    this.material = (source.material as string) ?? this.material;
    this.model = typeof source.model === "string" ? source.model : "";
    this.anim = parseClipSettings(source.anim);
    this.animGraph = parseAnimGraph(source.animGraph);
  }

  static fromJSON(json: Record<string, unknown>): MeshNode {
    const node = new MeshNode();
    node.applyJSON(json);
    return node;
  }
}
