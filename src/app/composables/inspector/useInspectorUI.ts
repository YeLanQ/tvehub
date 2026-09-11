// ---------------------------------------------------------------------------
// UI 域（Canvas-Widget）：画布卡与图片/文本/按钮/布局容器卡的编辑逻辑。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），编辑走
// commit → mutateNode（整节点快照进撤销历史），label 决定历史文案。
// Widget 共用 onUIUpdate(label, value) 单入口（与灯光域同模式），按 label 分发。
// 2D 变换/锚点/布局卡的数值换算（px ↔ UI 单位）在各 Section 组件内完成，
// 这里只接收 UI 单位（100px = 1 单位）与归一化锚点值。
// ---------------------------------------------------------------------------
import {
  UIButtonNode,
  UICanvasNode,
  UIImageNode,
  UILayoutNode,
  UITextNode,
  UIWidgetNode,
  clampUICanvasSortOrder,
  clampUISortOrder,
  parseUIDesignPx,
  parseUIScaleMode,
  parseUILayoutMode,
} from "../../../framework/prototype/derived/Primitives";
import {
  parseUIAlign,
  parseUIFontFamily,
  parseUIPadding,
  parseUIFreeVec2,
  vec2,
  type UIAlign,
  type UIFontFamily,
  type Vec2,
} from "../../../framework/prototype/nodes/ui-shared";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorUIApi {
  onUICanvasUpdate: (label: string, value: unknown) => void;
  onUIImageUpdate: (label: string, value: unknown) => void;
  onUITextUpdate: (label: string, value: unknown) => void;
  onUIButtonUpdate: (label: string, value: unknown) => void;
  onUILayoutUpdate: (label: string, value: unknown) => void;
}

/** 组件写入（0..1 收敛） */
function unit01(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(1, Math.max(0, n));
}

function setVecPart(cur: Vec2, part: "x" | "y", v: unknown): Vec2 {
  const n = typeof v === "number" && Number.isFinite(v) ? v : cur[part];
  return vec2(part === "x" ? n : cur.x, part === "y" ? n : cur.y);
}

/** Widget 共有字段编辑（锚点/2D 变换/size/sortOrder；label 形如 "size.x" / "anchorMin.y"） */
function editWidgetField(target: UIWidgetNode, label: string, value: unknown): boolean {
  switch (label) {
    case "sortOrder":
      target.sortOrder = clampUISortOrder(value as number);
      return true;
    case "size.x":
    case "size.y": {
      const v = typeof value === "number" && Number.isFinite(value) ? Math.max(0.01, value) : 1;
      target.size = label === "size.x" ? vec2(v, target.size.y) : vec2(target.size.x, v);
      return true;
    }
    case "anchoredPosition.x":
    case "anchoredPosition.y":
      target.anchoredPosition = setVecPart(target.anchoredPosition, label === "anchoredPosition.x" ? "x" : "y", value);
      return true;
    case "offsetMin.x":
    case "offsetMin.y":
      target.offsetMin = setVecPart(target.offsetMin, label === "offsetMin.x" ? "x" : "y", value);
      return true;
    case "offsetMax.x":
    case "offsetMax.y":
      target.offsetMax = setVecPart(target.offsetMax, label === "offsetMax.x" ? "x" : "y", value);
      return true;
    case "anchorMin.x":
    case "anchorMin.y":
      target.anchorMin = setVecPart(target.anchorMin, label === "anchorMin.x" ? "x" : "y", unit01(value, 0.5));
      return true;
    case "anchorMax.x":
    case "anchorMax.y":
      target.anchorMax = setVecPart(target.anchorMax, label === "anchorMax.x" ? "x" : "y", unit01(value, 0.5));
      return true;
    case "pivot.x":
    case "pivot.y":
      target.pivot = setVecPart(target.pivot, label === "pivot.x" ? "x" : "y", unit01(value, 0.5));
      return true;
    case "anchorMin":
      target.anchorMin = parseUIFreeVec2(value, target.anchorMin);
      target.anchorMin = vec2(unit01(target.anchorMin.x, 0.5), unit01(target.anchorMin.y, 0.5));
      return true;
    case "anchorMax":
      target.anchorMax = parseUIFreeVec2(value, target.anchorMax);
      target.anchorMax = vec2(unit01(target.anchorMax.x, 0.5), unit01(target.anchorMax.y, 0.5));
      return true;
    case "rotZ": {
      const r = target.transform.rotation;
      const z = typeof value === "number" && Number.isFinite(value) ? value : r.z;
      target.transform.setRotation(r.x, r.y, z);
      return true;
    }
    case "scale.x":
    case "scale.y": {
      const s = target.transform.scale;
      const v = typeof value === "number" && Number.isFinite(value) ? Math.max(0.01, value) : 1;
      target.transform.setScale(label === "scale.x" ? v : s.x, label === "scale.y" ? v : s.y, s.z);
      return true;
    }
    default:
      return false;
  }
}

export function useInspectorUI(ctx: InspectorNodeApi): InspectorUIApi {
  const { node, commit } = ctx;

  function onUICanvasUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof UICanvasNode)) return;
    commit((target) => {
      const c = target as UICanvasNode;
      if (label === "sortOrder") c.sortOrder = clampUICanvasSortOrder(value as number);
      else if (label === "designWidth") c.designWidth = parseUIDesignPx(value, c.designWidth);
      else if (label === "designHeight") c.designHeight = parseUIDesignPx(value, c.designHeight);
      else if (label === "scaleMode") c.scaleMode = parseUIScaleMode(value ?? c.scaleMode);
    }, `Set Canvas ${label}`);
  }

  function onUIImageUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof UIImageNode)) return;
    commit((target) => {
      const w = target as UIImageNode;
      if (editWidgetField(w, label, value)) return;
      if (label === "image") w.image = typeof value === "string" ? value : "";
      else if (label === "color") w.color = (value as number) & 0xffffff;
    }, `Set Image ${label}`);
  }

  function onUITextUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof UITextNode)) return;
    commit((target) => {
      const w = target as UITextNode;
      if (editWidgetField(w, label, value)) return;
      switch (label) {
        case "text":
          w.text = typeof value === "string" ? value : "";
          break;
        case "fontSize":
          w.fontSize = Math.min(512, Math.max(4, value as number));
          break;
        case "color":
          w.color = (value as number) & 0xffffff;
          break;
        case "bold":
          w.bold = value === true;
          break;
        case "italic":
          w.italic = value === true;
          break;
        case "fontFamily":
          w.fontFamily = parseUIFontFamily(value) as UIFontFamily;
          break;
        case "align":
          w.align = parseUIAlign(value) as UIAlign;
          break;
      }
    }, `Set Text ${label}`);
  }

  function onUIButtonUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof UIButtonNode)) return;
    commit((target) => {
      const w = target as UIButtonNode;
      if (editWidgetField(w, label, value)) return;
      switch (label) {
        case "image":
          w.image = typeof value === "string" ? value : "";
          break;
        case "color":
          w.color = (value as number) & 0xffffff;
          break;
        case "label":
          w.label = typeof value === "string" ? value : "";
          break;
        case "labelColor":
          w.labelColor = (value as number) & 0xffffff;
          break;
        case "fontSize":
          w.fontSize = Math.min(512, Math.max(4, value as number));
          break;
        case "labelBold":
          w.labelBold = value === true;
          break;
        case "interactable":
          w.interactable = value !== false;
          break;
      }
    }, `Set Button ${label}`);
  }

  function onUILayoutUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof UILayoutNode)) return;
    commit((target) => {
      const w = target as UILayoutNode;
      if (editWidgetField(w, label, value)) return;
      switch (label) {
        case "layoutMode":
          w.layoutMode = parseUILayoutMode(value ?? w.layoutMode);
          break;
        case "padding.left":
        case "padding.right":
        case "padding.top":
        case "padding.bottom":
          w.padding = parseUIPadding(
            { ...w.padding, [label.split(".")[1]]: value },
            w.padding,
          );
          break;
        case "spacing.x":
        case "spacing.y":
          w.spacing = setVecPart(w.spacing, label === "spacing.x" ? "x" : "y", value);
          break;
        case "gridColumns":
          w.gridColumns =
            typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : w.gridColumns;
          break;
      }
    }, `Set Layout ${label}`);
  }

  return { onUICanvasUpdate, onUIImageUpdate, onUITextUpdate, onUIButtonUpdate, onUILayoutUpdate };
}
