# 单元：项目域 IPC（`src/lib/api.ts` 项目段）

## 契约

| 方法（后端命令） | 用途 |
|---|---|
| `openProject(path)` → `RecentProject` | 打开项目（后端登记最近） |
| `createProject(parent, name, templateId, files)` → `RecentProject` | 从模板创建项目 |
| `listRecentProjects()` → `RecentProject[]` | 最近列表（后端持久化、规范化去重） |
| `removeRecentProject(path)` | 移除最近记录 |
| `renameProject(path, newName)` → `RecentProject` | 重命名项目目录（最近记录跟随） |
| `trashPath(path)` | 移入系统回收站（目录/文件均可） |
| `pickProjectFolder()` → path\|null | 选择文件夹对话框 |
| `getDefaultProjectDir()` / `setDefaultProjectDir(dir)` | 新建项目默认父目录（null=未设置） |

类型：`RecentProject { path, name, sceneCount }`。

**打开顺序约定**：`openProject` 成功后必须先 `await api.setCurrentProjectRoot(info.path)`
（asset:// 协议根就位），再做任何资产请求——见 stores/project.ts:405 的编排。

## 使用例

业务编排都在 `src/app/stores/project.ts`（store 持有流程，UI 只调 store）：

`src/app/stores/project.ts:405`（打开项目：登记 asset 根 → 解析初始场景 → 装载）：

```ts
const info = await api.openProject(path);
await api.setCurrentProjectRoot(info.path);
await store.loadScene(info.path, await resolveProjectBoot(info.path));
```

`src/app/components/home/ProjectsSection.vue:120`（Home 卡片重命名直接调 api）：

```ts
await api.renameProject(path, newName);
```

`src/app/components/home/ProjectsSection.vue:94`（删除项目走回收站）：

```ts
await api.trashPath(path);
```

## 测试例

当前无 spec。`stores/project.ts` 里可无依赖直测的纯状态逻辑是**最近列表维护**
（`addRecent` 去重/上限 20、`removeRecent` 路径规范化比较）——推荐写法
（`src/app/stores/project.spec.ts`，注意 import 门面在 jsdom 下可加载、只在调用时才碰 Tauri）：

```ts
import { describe, expect, it } from "vitest";
import { getProjectStore } from "./project";

describe("最近项目列表", () => {
  it("同一路径不同分隔符/大小写视为同一项目（去重置顶）", () => {
    const s = getProjectStore();
    s.clearRecent();
    s.addRecent({ path: "D:\\Demo", name: "demo", sceneCount: 1 });
    s.addRecent({ path: "d:/demo/", name: "demo", sceneCount: 1 });
    expect(s.recent).toHaveLength(1);
  });
});
```

组织口径（正常/边界/异常/空值）与放置位置见 `tve-unit-testing` 技能。
