# 单元：多窗口域 IPC（`src/lib/api.ts` 窗口段）

## 契约

多窗口架构：index.html=编辑器、home.html=首页、graph.html=节点图、whiteboard.html=白板、
docs.html=文档（各自独立入口 `src/*-main.ts`）。

| 方法（后端命令） | 用途 |
|---|---|
| `showWindowWithProject(label, root, name, rel)` | 显示目标窗口并写待交付项目（首页→编辑器/图窗口统一入口） |
| `takePendingProject()` → `{root,name,rel}\|null` | 窗口启动拉取待交付项目（**取走即清空**，只交付一次） |
| `showHomeWindow()` | 回首页并隐藏编辑器 |
| `showWhiteboardWindow(name)` | 开白板窗口（全局单例；name 非空=待打开文件） |
| `takePendingWhiteboardFile()` → name\|null | 白板启动拉取待打开文件名 |
| `showDocsWindow(hash?)` | 开文档窗口（全局单例；hash=待打开文档页） |
| `takePendingDocsHash()` → hash\|null | 文档窗口启动拉取 hash |
| `whiteboardListFiles/Read/Write/Delete` | 全局白板 .svg 文件 CRUD（写自动建目录） |

**冷启动要点**：窗口 listen 未就绪时事件广播会丢，所以跨窗口交付一律
"写 pending + 窗口启动时主动 take"兜底，不要只用事件。

## 使用例

`src/app/components/home/WhiteboardSection.vue:89`（首页开白板并指定文件）：

```ts
await api.showWhiteboardWindow(name);
```

`src/whiteboard-main.ts:23`（白板窗口启动领取待打开文件）：

```ts
const pending = await api.takePendingWhiteboardFile();
```

`src/app/components/HomeView.vue:63`（打开文档窗口）与
`src/docs-window/DocsWindowApp.vue:38`（启动领取 hash）同构。

`src/app/commands/editorCommands.ts:171`（关闭项目回首页）：`await api.showHomeWindow();`

## 测试例

真实测试例：`src/docs-window/DocsWindowApp.spec.ts` —— jsdom 无
`__TAURI_INTERNALS__`，`isTauri()` 恒 false，spec 专测**浏览器直开分支的安全空操作**
（渲染 iframe、非 Tauri 时不 invoke 不抛错）。要点：

```ts
// 浏览器直开（无 Tauri）：takePending* 返回 null，窗口照常渲染兜底内容
it("非 Tauri 环境安全空操作", async () => { ... });
```

给"带 takePending 的启动逻辑"写测试时照此模式：断言空值分支不抛错 + UI 兜底渲染；
Tauri 真机分支留给手工/smoke（规范见 `tve-unit-testing` 技能）。
