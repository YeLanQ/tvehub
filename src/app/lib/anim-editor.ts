// 动画编辑窗口（底部停靠面板）的跨组件状态：
// - clipRel：当前在编辑的 .anim 资产；
// - seq：打开请求序号（AssetInspector/组件卡「在动画编辑器中打开」递增），
//   面板监听 seq 变化加载对应剪辑；dockTo 把面板带到前台（底部停靠区）。
import { reactive } from "vue";
import { dockTo } from "../docks/docks-layout";
import { enterAnimEditMode, exitAnimEditMode } from "./anim-edit-mode";

export const animEditor = reactive({
  clipRel: "",
  seq: 0,
});

/**
 * 打开动画编辑器。nodeId 指定时进入「聚焦编辑模式」：蒙版层高亮该节点及其
 * 子树、其它节点不可选中、面板切换锁定（退出按钮/exitAnimEditMode 解除）；
 * 不传 nodeId（资产面板打开）则普通编辑，目标跟随场景选中节点。
 */
export function openInAnimEditor(rel: string, nodeId?: string): void {
  animEditor.clipRel = rel;
  if (nodeId) enterAnimEditMode(nodeId);
  else exitAnimEditMode();
  animEditor.seq += 1;
  dockTo("animation", "bottom");
}
