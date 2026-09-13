// ---------------------------------------------------------------------------
// 项目脚本模型镜像（跨脚本智能提示的地基）：
// Monaco 的 TS 语言服务（补全/诊断/跳转/自动导入 quick fix）只认识「已注册的
// 模型」。此前只有打开的标签页会建模型，脚本之间互相引用（import type 组件类、
// 跨脚本自动导入、F12 跳转）在文件未打开时全部失效。本模块把 src/ 下全部脚本
// 镜像为后台模型（不打编辑器）：
// - 项目脚本清单变化（新建/重命名/删除/切项目）→ 建/删模型；
// - 非打开页模型内容跟随 store 缓存（磁盘重读/fs-watch 外部改盘后自动同步）；
// - 打开的标签页模型仍归脚本编辑器面板所有（脏编辑保护），本模块不触碰。
// 面板可反复挂载/卸载：进程内只启动一次（Monaco 单例随应用存活）。
// 依赖 scripts store 的 ensureCached（按需读盘缓存）。
// ---------------------------------------------------------------------------

import { watchEffect } from "vue";
import { getScriptsStore } from "../../stores/scripts";
import type { MonacoNamespace } from "./monaco-setup";

let started = false;

/** 启动全项目脚本 → Monaco 模型的镜像同步（幂等；无资源需释放，应用级存活） */
export function startScriptModelSync(monaco: MonacoNamespace): void {
  if (started) return;
  started = true;
  const store = getScriptsStore();
  let known = new Set<string>();
  watchEffect(() => {
    const rels = store.listScripts();
    for (const rel of rels) syncModel(monaco, store, rel);
    for (const rel of known) {
      if (!rels.includes(rel) && !store.tabs.includes(rel)) {
        monaco.editor.getModel(monaco.Uri.parse("file:///" + rel))?.dispose();
      }
    }
    known = new Set(rels);
  });
}

/** 单个脚本的模型同步：未缓存先读盘（读完后响应式重入本函数） */
function syncModel(
  monaco: MonacoNamespace,
  store: ReturnType<typeof getScriptsStore>,
  rel: string,
): void {
  // 打开的标签页模型由脚本编辑器面板绑定与同步（脏内容不回写）
  if (store.tabs.includes(rel)) return;
  const st = store.fileState(rel);
  if (!st) {
    void store.ensureCached(rel);
    return;
  }
  const uri = monaco.Uri.parse("file:///" + rel);
  const model = monaco.editor.getModel(uri);
  if (!model) {
    monaco.editor.createModel(st.source, "typescript", uri);
    return;
  }
  // 外部改盘（reloadExternal 回写 store）后同步镜像内容
  if (model.getValue() !== st.source) model.setValue(st.source);
}
