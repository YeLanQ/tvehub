# 单元：任务队列/预览/构建导出 IPC（`src/lib/api.ts`）

## 契约

**任务**（后端任务表；事件 `task:progress` / `task:completed`）：

| 方法 | 用途 |
|---|---|
| `listTasks(root?)` → `TaskStatus[]` | 活跃任务（可按项目根过滤） |
| `cancelTask(id)` → boolean | 取消指定任务 |
| `cancelTasksByRoot(root)` → number | 批量取消某项目全部任务 |

`TaskStatus { id, kind, root, priority: "low"|"normal"|"high", progress, message, running, cancelled }`。

**导入选择对话框**：`pickImportFiles(title?)` / `pickImportFolders(title?)` → 路径数组。

**网页预览/构建**：

| 方法 | 用途 |
|---|---|
| `exportWebPreviewFromScene(root, sceneRel, files)` | 当前场景导出预览产物（场景/贴图后端直读盘；files=网页运行时文本） |
| `startWebPreviewServer(root, dir?)` → baseUrl | 起本地静态服务（缺省 .tmp/web-preview，可指 build/<channel>） |
| `stopWebPreview()` | 停服务释放端口 |
| `buildExport(args)` → `BuildResult` | 构建导出（channel/scenes/mainScene/singlePage/gzip/release/cdn/...） |
| `scanUserTemplates(kind)` / `readUserTemplateText(kind, dir, rel)` | exe 旁用户自定义模板（"templates"\|"exports-web"） |

## 使用例

`src/app/composables/use-task-scheduler.ts:50-63`（任务面板轮询与取消，isTauri 守卫）：

```ts
export async function refreshTasks(root?: string) {
  if (!isTauri()) return;
  const list = await api.listTasks(root);
  tasks.value = new Map(list.map((t) => [t.id, t]));
}
```

`src/app/components/WebPreviewPanel.vue:293-296`（导出并起预览服务）：

```ts
await api.exportWebPreviewFromScene(root, sceneRel, files);
const base = await api.startWebPreviewServer(root);
```

`src/app/components/BuildPanel.vue:266`（构建产物预览：`startWebPreviewServer(root, "build/"+channel)`，
`:291` stopWebPreview）；实际构建走 `src/app/lib/build-export.ts:271` 的 `api.buildExport({...})`。

## 测试例

当前无 spec。use-task-scheduler 的**浏览器分支**可直接测（jsdom 下 isTauri 恒 false，
安全空操作）——推荐写法（`src/app/composables/use-task-scheduler.spec.ts`）：

```ts
import { describe, expect, it } from "vitest";
import { activeTasks, refreshTasks, cancelTask } from "./use-task-scheduler";

describe("任务调度（浏览器直开分支）", () => {
  it("refreshTasks/cancelTask 不抛错且不改动任务表（空值安全）", async () => {
    await expect(refreshTasks()).resolves.toBeUndefined();
    await expect(cancelTask("x")).resolves.toBeUndefined();
    expect(activeTasks.value.size).toBe(0);
  });
});
```

Tauri 真机分支（事件监听/真实任务流转）归手工与 devtools 联调，不进单测。
