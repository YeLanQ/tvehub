import { Node, type NodeInit } from "../Node";
import {
  clampUISortOrder,
  parseUIFreeVec2,
  parseUIUnitVec2,
  parseVec2,
  vec2,
  type Vec2,
} from "./ui-shared";

export interface UIWidgetNodeInit extends NodeInit {
  /** Widget 矩形尺寸（UI 单位；100px = 1 单位。几何按此构建，点锚点轴生效） */
  size?: Vec2;
  /** 画布内排序：同一画布里 sortOrder 大的 Widget 叠在上层 */
  sortOrder?: number;
  /** 归一化锚点下限（0..1，父矩形；min==max 为点锚点） */
  anchorMin?: Vec2;
  /** 归一化锚点上限（0..1；min<max 该轴为拉伸锚点，尺寸由边距推导） */
  anchorMax?: Vec2;
  /** 归一化枢轴（0..1，Widget 自身；点锚点定位与旋转基准） */
  pivot?: Vec2;
  /** 点锚点轴：枢轴相对锚点的偏移（UI 单位） */
  anchoredPosition?: Vec2;
  /** 拉伸轴边距：相对下/左锚线（UI 单位） */
  offsetMin?: Vec2;
  /** 拉伸轴边距：相对上/右锚线（UI 单位） */
  offsetMax?: Vec2;
}

/**
 * UI Widget 基类（抽象）：画布上的 UI 元素共有字段。
 * - 尺寸与定位：size 为设计尺寸（UI 单位，100px = 1 单位）；位置由锚点系统在
 *   每帧布局解析中推导（resolveUIRect）——点锚点轴用 anchoredPosition，拉伸轴用
 *   offsetMin/offsetMax 边距，size 仅在点锚点轴生效。旧数据（无锚点字段）迁移：
 *   anchoredPosition 取原 transform.position（中心锚点），视觉位置不变；
 * - sortOrder：画布内叠加序；渲染序 = 画布 sortOrder×1e4 + 本值。
 * 渲染侧约束（编辑器 SceneSynchronizer / 运行时 ui.mjs 同一语义）：
 * 透明 + 不写深度 + 关深度测试 + frustumCulled 关（贴合相机后位于近处）。
 */
export abstract class UIWidgetNode extends Node {
  size: Vec2 = vec2(2, 2);
  sortOrder: number = 0;
  anchorMin: Vec2 = vec2(0.5, 0.5);
  anchorMax: Vec2 = vec2(0.5, 0.5);
  pivot: Vec2 = vec2(0.5, 0.5);
  anchoredPosition: Vec2 = vec2(0, 0);
  offsetMin: Vec2 = vec2(0, 0);
  offsetMax: Vec2 = vec2(0, 0);

  protected initWidget(init: UIWidgetNodeInit, defaultSize: Vec2): void {
    this.size = parseVec2(init.size, defaultSize);
    this.sortOrder = clampUISortOrder(init.sortOrder, this.sortOrder);
    this.anchorMin = parseUIUnitVec2(init.anchorMin, this.anchorMin);
    this.anchorMax = parseUIUnitVec2(init.anchorMax, this.anchorMax);
    this.pivot = parseUIUnitVec2(init.pivot, this.pivot);
    this.anchoredPosition = parseUIFreeVec2(init.anchoredPosition, this.anchoredPosition);
    this.offsetMin = parseUIFreeVec2(init.offsetMin, this.offsetMin);
    this.offsetMax = parseUIFreeVec2(init.offsetMax, this.offsetMax);
  }

  protected readWidget(source: Record<string, unknown>, defaultSize: Vec2): void {
    this.size = parseVec2(source.size, this.size ?? defaultSize);
    this.sortOrder = clampUISortOrder(source.sortOrder, this.sortOrder);
    this.anchorMin = parseUIUnitVec2(source.anchorMin, this.anchorMin);
    this.anchorMax = parseUIUnitVec2(source.anchorMax, this.anchorMax);
    this.pivot = parseUIUnitVec2(source.pivot, this.pivot);
    // 旧数据迁移：无 anchoredPosition 时取原 transform.position（中心锚点下等价）
    const legacy = source.anchoredPosition === undefined ? this.legacyPosition(source) : null;
    this.anchoredPosition = parseUIFreeVec2(source.anchoredPosition, legacy ?? this.anchoredPosition);
    this.offsetMin = parseUIFreeVec2(source.offsetMin, this.offsetMin);
    this.offsetMax = parseUIFreeVec2(source.offsetMax, this.offsetMax);
  }

  protected writeWidget(target: Record<string, unknown>): void {
    target.size = { ...this.size };
    target.sortOrder = this.sortOrder;
    target.anchorMin = { ...this.anchorMin };
    target.anchorMax = { ...this.anchorMax };
    target.pivot = { ...this.pivot };
    target.anchoredPosition = { ...this.anchoredPosition };
    target.offsetMin = { ...this.offsetMin };
    target.offsetMax = { ...this.offsetMax };
  }

  /** 旧节点 JSON 的 transform.position x/y（缺失回 0） */
  private legacyPosition(source: Record<string, unknown>): Vec2 {
    const t = source.transform as { position?: { x?: unknown; y?: unknown } } | undefined;
    const dim = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
    return vec2(dim(t?.position?.x), dim(t?.position?.y));
  }
}
