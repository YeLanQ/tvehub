# 单元：跨窗口 store（图窗口 / 白板窗口）

## 契约

两个独立窗口应用各自持有一个惰性单例 store，与 app store 同模式（`getXxxStore()`）：

| 入口 | 位置 | 职责要点 |
|---|---|---|
| `getGraphWindowStore()` | `src/graph-window/graphStore.ts:156` | 节点图窗口状态中枢：`sceneApi.open(root, rel)` + `hierarchyRows` 建实体索引（:278）；独立 `sceneApi.subscribe` 订阅场景变更维护图文档同步（:673）；图文档编辑/保存走后端权威状态 |
| `getWhiteboardStore()` | `src/whiteboard-window/whiteboardStore.ts:118` | 白板窗口状态中枢：全局白板 .svg 文档列表/打开/保存（api.whiteboardListFiles/Read/Write/Delete）；放映模式（slide-show）；命名框重命名防同名覆盖 |

窗口启动流程：`whiteboard-main.ts` / `graph-main.ts` 先 `takePending*` 领取交付物，
再构造 store。图窗口与编辑器窗口**共享同一后端场景会话**（scene:changed 双向同步），
白板窗口则完全独立于 3D 场景。

## 使用例

`src/graph-window/graphStore.ts:673`（图窗口独立订阅场景变更）：

```ts
sceneApi.subscribe((e) => { /* revision 过滤后增量同步图文档 */ });
```

`src/graph-window/graphStore.ts:278`（打开场景并建实体索引）：

```ts
const res = await sceneApi.open(root, rel);
const rows = await sceneApi.hierarchyRows("scene", "");
```

## 测试例

当前无 spec（graph-window / whiteboard-window 目录均无任何 *.spec.ts）。
可先测**纯文档逻辑**：`src/whiteboard-window/svg-doc.ts` 的 SVG 文档序列化/解析
——推荐按 ScenePrototype.spec.ts 的"序列化往返"模板组织（真实范本）：

- 正常：构造→序列化→解析往返字段守恒
- 边界：空文档、深层嵌套
- 异常：残缺 XML/未知节点回退默认
- 空值：空串/undefined 输入不抛错

```ts
import { describe, expect, it } from "vitest";
import { /* parse/serialize 对 */ } from "./svg-doc";

describe("svg-doc 往返", () => {
  it("正常：文档往返字段守恒", () => { /* ... */ });
});
```

与窗口生命周期/Tauri 事件相关的部分归手工验证（jsdom 无 `__TAURI_INTERNALS__`）。
