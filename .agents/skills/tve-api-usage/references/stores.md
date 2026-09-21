# 单元：应用 store（惰性单例，无 Pinia）

## 契约

所有 store 是**模块级单例 + `getXxxStore()` 惰性构造**（首次调用才 new，常驻不销毁；
`logStore` 直接导出单例对象）。组件/命令/composable 里按需取用，不通过 provide/inject。

| 入口 | 核心 state（只读快照） | 核心 action |
|---|---|---|
| `getEditorStore()`（src/app/stores/editor.ts:52） | engine 实例、selectionIds、viewMode（scene/layout/preview/script）、gizmoMode/Space、canUndo/Redo、historyLabels、mounted、dirty、terrainPaintActive | setViewMode、setTerrainPaint、markMounted/markSaved、nodeById/childrenOf/revision |
| `getProjectStore()`（project.ts:107） | recent、currentPath、projectName、sceneRel、rendererBackend、antiAliasing、hdrMode、physics*、tags、layers、designWidth/Height、orientation | openProject/createProject、openScene/loadScene、applyOpenedProject、addRecent/removeRecent、setLayers/setTags 等 |
| `getAssetsStore()`（assets.ts:105） | assets 列表、metaMap、selectedAsset(+Seq)、loadedPath | load/refresh、select、rename/duplicate/remove/moveTo/importPaths、createXxxAsset 十余种（委托 assetService） |
| `getScriptsStore()`（scripts.ts:84） | tabs、active、busy、schemaRev、files 缓存（源码/脏/诊断/props schema） | openScript/saveScript/saveAll、createScript/renameScript/deleteScript、propsSchemaFor、scriptNodeTypes、reloadExternal |
| `logStore`（log.ts:29，直接导出） | lines（上限 500 条环形截断） | log(level, text, tag?)、clear()；level: info/warn/error/engine/success |
| `getBootLoadingStore()`（boot-loading.ts:79） | 启动遮罩进度状态 | 见源文件 |
| `resetEditorEngine()`（editor.ts:244） | — | 销毁引擎单例（仅供 editorService.disposeEditor 调用） |

跨窗口 store（graph/whiteboard）见 stores-windows.md。

**约定**：写路径走 engine/store action；store 不做业务规则（那些在 services 层），
只做成功后的状态刷新。

## 使用例

`src/App.vue:44`（根组件引导取双 store）：

```ts
const projectStore = getProjectStore();
const editorStore = getEditorStore();
```

`src/app/components/AssetTreeNode.vue:70`（资产树节点组件取 assets store，`:149` 调 createFolder）。

`src/app/commands/editorCommands.ts:137`（命令层组合双 store：editor.close）。

## 测试例

当前无 spec。最容易落地的真实单元是 `logStore`（纯内存、无 IPC）——推荐写法
（`src/app/stores/log.spec.ts`）：

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { logStore } from "./log";

describe("logStore", () => {
  beforeEach(() => logStore.clear());

  it("正常：log 追加带时间与 tag 的行", () => {
    logStore.log("info", "hello", "test");
    expect(logStore.lines).toHaveLength(1);
    expect(logStore.lines[0].text).toBe("hello");
  });
  it("边界：超过 500 条截断最旧行", () => {
    for (let i = 0; i < 505; i++) logStore.log("info", `#${i}`);
    expect(logStore.lines).toHaveLength(500);
    expect(logStore.lines[0].text).toBe("#5");
  });
});
```

editor/project 等 store 构造时 new EditorEngine / import 门面，jsdom 下可加载但测前
先明确只测**无 IPC 的纯状态方法**（如 project store 的 addRecent 去重，见
facade-projects.md 测试例）；带 engine/IPC 的 action 归手工/smoke。
