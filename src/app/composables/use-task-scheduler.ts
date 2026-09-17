import { ref, readonly, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri-env";
import type {
  TaskStatus,
  TaskProgressEvent,
  TaskCompletedEvent,
} from "../../lib/api";

/** 全局任务表（id → 状态） */
const tasks = ref<Map<string, TaskStatus>>(new Map());

/** 活跃任务列表（只读） */
export const activeTasks = readonly(tasks);

let initialized = false;
let unlistenProgress: UnlistenFn | null = null;
let unlistenCompleted: UnlistenFn | null = null;

/** 初始化任务事件监听（幂等，全局只需调一次） */
async function ensureListeners() {
  if (initialized || !isTauri()) return;
  initialized = true;

  unlistenProgress = await listen<TaskProgressEvent>(
    "task:progress",
    (e) => {
      const { id, progress, message } = e.payload;
      const task = tasks.value.get(id);
      if (task) {
        task.progress = progress;
        task.message = message;
      }
    },
  );

  unlistenCompleted = await listen<TaskCompletedEvent>(
    "task:completed",
    (e) => {
      tasks.value.delete(e.payload.id);
    },
  );
}

/** 刷新活跃任务列表（从后端拉取） */
export async function refreshTasks(root?: string) {
  if (!isTauri()) return;
  await ensureListeners();
  const list = await api.listTasks(root);
  tasks.value = new Map(list.map((t) => [t.id, t]));
}

/** 取消指定任务 */
export async function cancelTask(id: string) {
  if (!isTauri()) return;
  await api.cancelTask(id);
}

/** 批量取消某项目的全部任务 */
export async function cancelTasksByRoot(root: string) {
  if (!isTauri()) return;
  await api.cancelTasksByRoot(root);
  await refreshTasks(root);
}

/** 任务调度 composable：自动管理事件监听生命周期 */
export function useTaskScheduler() {
  void ensureListeners();

  onUnmounted(() => {
    // 全局监听不随组件卸载（多组件共享）；仅在 app 卸载时清理
  });

  return {
    tasks: activeTasks,
    refreshTasks,
    cancelTask,
    cancelTasksByRoot,
  };
}

/** 清理全局监听（app 卸载时调） */
export function cleanupTaskScheduler() {
  unlistenProgress?.();
  unlistenCompleted?.();
  unlistenProgress = null;
  unlistenCompleted = null;
  initialized = false;
}