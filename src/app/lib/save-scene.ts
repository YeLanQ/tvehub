// 场景保存工具：后端持有权威状态，序列化（保留 metadata/settings 信封）与
// 写盘（含 .meta 保障、脏标记清除）全部在 Rust 侧完成，前端只触发命令。

import { sceneApi } from "../../lib/scene-api";

/**
 * 保存当前场景到当前打开的场景文件（sceneRel）。
 * @throws 未打开场景或写入失败时抛错（后端错误信息透传）
 */
export async function saveCurrentSceneToMain(): Promise<void> {
  await sceneApi.save();
}
