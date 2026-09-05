// 场景保存工具：把当前编辑器场景图写回项目主场景 assets/Main.scene。
// 与旧 Toolbar 保存逻辑一致：读取上次场景文件内容（保留 metadata/settings 等），
// 仅替换 root 为引擎场景图序列化结果。

import { invoke } from "@tauri-apps/api/core";
import { getProjectStore } from "../stores/project";
import { getEditorStore } from "../stores/editor";

/** 当前主场景相对路径（编辑器当前只维护一个活动场景） */
export const MAIN_SCENE_REL = "assets/Main.scene";

/**
 * 保存当前场景到项目主场景文件。
 * @throws 未打开项目或写入失败时抛错
 */
export async function saveCurrentSceneToMain(): Promise<void> {
  const projectStore = getProjectStore();
  const path = projectStore.currentPath;
  if (!path) throw new Error("尚未打开项目，无法保存场景");

  let data: unknown = null;
  try {
    data = JSON.parse(projectStore.sceneJson ?? "");
  } catch {
    data = null;
  }
  const out = {
    ...(data && typeof data === "object" ? (data as object) : {}),
    root: getEditorStore().engine.graph.toJSON(),
  };
  await invoke("write_text", {
    root: path,
    rel: MAIN_SCENE_REL,
    content: JSON.stringify(out, null, 2),
  });
}
