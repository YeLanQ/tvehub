// ---------------------------------------------------------------------------
// UI 域（Canvas-Widget）：画布卡与图片/文本/按钮 Widget 卡的编辑逻辑。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），编辑走
// commit → mutateNode（整节点快照进撤销历史），label 决定历史文案。
// Widget 共用 onUIUpdate(label, value) 单入口（与灯光域同模式），按 label 分发。
// ---------------------------------------------------------------------------
import {
  UIButtonNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIWidgetNode,
  clampUICanvasSortOrder,
  clampUISortOrder,
} from "../../../framework/prototype/derived/Primitives";
import {
  parseUIAlign,
  parseUIFontFamily,
  vec2,
  type UIAlign,
  type UIFontFamily,
} from "../../../framework/prototype/nodes/ui-shared";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorUIApi {
  onUICanvasUpdate: (label: string, value: unknown) => void;
  onUIImageUpdate: (label: string, value: unknown) => void;
  onUITextUpdate: (label: string, value: unknown) => void;
  onUIButtonUpdate: (label: string, value: unknown) => void;
}

/** Widget 共有字段编辑（size/sortOrder；label 形如 "size.x" / "sortOrder"） */
function editWidgetField(target: UIWidgetNode, label: string, value: unknown): boolean {
  if (label === "sortOrder") {
    target.sortOrder = clampUISortOrder(value as number);
    return true;
  }
  if (label === "size.x" || label === "size.y") {
    const part = label === "size.x" ? "x" : "y";
    const v = typeof value === "number" && Number.isFinite(value) ? Math.max(0.01, value) : 1;
    target.size = vec2(part === "x" ? v : target.size.x, part === "y" ? v : target.size.y);
    return true;
  }
  return false;
}

export function useInspectorUI(ctx: InspectorNodeApi): InspectorUIApi {
  const { node, commit } = ctx;

  function onUICanvasUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof UICanvasNode)) return;
    commit((target) => {
      const c = target as UICanvasNode;
      if (label === "sortOrder") c.sortOrder = clampUICanvasSortOrder(value as number);
    }, "Set Canvas Sort Order");
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

  return { onUICanvasUpdate, onUIImageUpdate, onUITextUpdate, onUIButtonUpdate };
}
