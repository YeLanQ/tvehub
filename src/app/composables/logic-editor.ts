// ---------------------------------------------------------------------------
// 逻辑资产可视化编辑器（弹窗）的打开状态（模块级 reactive 单例）：
// 双击 / 右键「打开编辑器」/ 检查器按钮 共用这一个入口。rel 非空即打开对应
// 弹窗（FsmEditorDialog / BtEditorDialog 由 App.vue 按状态挂载，rel 变化经
// :key 强制重建以重新装载资产内容）。
// ---------------------------------------------------------------------------
import { reactive } from "vue";

export const logicEditorState = reactive({
  /** 打开中的状态机资产 rel（null = 关闭） */
  fsmRel: null as string | null,
  /** 打开中的行为树资产 rel（null = 关闭） */
  btRel: null as string | null,
});

/** 打开状态机可视化编辑器（.fsm） */
export function openFsmEditor(rel: string): void {
  logicEditorState.btRel = null;
  logicEditorState.fsmRel = rel;
}

/** 打开行为树可视化编辑器（.bt） */
export function openBehaviorTreeEditor(rel: string): void {
  logicEditorState.fsmRel = null;
  logicEditorState.btRel = rel;
}

export function closeFsmEditor(): void {
  logicEditorState.fsmRel = null;
}

export function closeBehaviorTreeEditor(): void {
  logicEditorState.btRel = null;
}

/** 按资产扩展名打开对应编辑器（非逻辑资产忽略） */
export function openLogicAssetEditor(rel: string): boolean {
  if (rel.toLowerCase().endsWith(".fsm")) {
    openFsmEditor(rel);
    return true;
  }
  if (rel.toLowerCase().endsWith(".bt")) {
    openBehaviorTreeEditor(rel);
    return true;
  }
  return false;
}
