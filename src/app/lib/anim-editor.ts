// 动画编辑窗口（底部停靠面板）的跨组件状态：
// - clipRel：当前在编辑的 .anim 资产；
// - seq：打开请求序号（AssetInspector/组件卡「在动画编辑器中打开」递增），
//   面板监听 seq 变化加载对应剪辑；dockTo 把面板带到前台（底部停靠区）。
import { reactive } from "vue";
import { dockTo } from "../docks/docks-layout";

export const animEditor = reactive({
  clipRel: "",
  seq: 0,
});

export function openInAnimEditor(rel: string): void {
  animEditor.clipRel = rel;
  animEditor.seq += 1;
  dockTo("animation", "bottom");
}
