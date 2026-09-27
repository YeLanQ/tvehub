// 外部 .scene 修改的响应动作判定（纯函数，独立便于单测）。
// 背景：场景权威状态在编辑器会话内存中，外部覆盖自动重装可能冲掉未保存改动；
// 但"只能关开项目才能同步"体验太差（2026-09-28 反馈），故按脏态分级响应。

export type SceneReloadAction = "auto" | "confirm" | "notice";

/**
 * 判定外部 .scene 修改的响应动作：
 * - 非当前打开场景 → "notice"（仅日志提醒，不打扰）；
 * - 当前场景且有未保存改动 → "confirm"（重新载入 / 保留我的改动，二选一）；
 * - 当前场景无未保存改动 → "auto"（磁盘即最新，直接重载 + 日志告知）。
 */
export function sceneReloadAction(isCurrentScene: boolean, dirty: boolean): SceneReloadAction {
  if (!isCurrentScene) return "notice";
  return dirty ? "confirm" : "auto";
}
