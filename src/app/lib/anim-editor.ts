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
 * 打开动画编辑器。必须经动画组件卡入口（传 nodeId）才能进入编辑：
 * 进入「聚焦编辑模式」——面板解除蒙版可编辑、场景选中锁定该节点及其子树、
 * 其它节点不可选中、视口内压暗、面板切换锁定（「退出编辑」解除，面板回到
 * 只读蒙版态）。不传 nodeId（直接开面板/资产侧打开）仅为查看：加载剪辑并
 * 停靠面板，面板保持蒙版只读，不可编辑。
 */
export function openInAnimEditor(rel: string, nodeId?: string): void {
  animEditor.clipRel = rel;
  if (nodeId) enterAnimEditMode(nodeId);
  else exitAnimEditMode();
  animEditor.seq += 1;
  dockTo("animation", "bottom");
}
