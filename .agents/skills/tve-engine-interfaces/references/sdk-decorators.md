# 单元：tve SDK —— 装饰器与元数据（@property / @nodeType）

## 契约

**`@property(options?)`**：把类字段暴露为检查器可编辑属性。选项：
`{ type?, label?, tooltip?, min?, max?, step?, default? }`。
- `type` 可为 `PropType`（"number"|"string"|"boolean"|"color"|"vec3"，可由字段初值推断）；
- `type` 用**节点类**（NodeClass，如 `CameraNode`）= 场景节点引用属性（检查器按
  EntityKind 过滤候选）；
- `type` 用**组件类**（ComponentClass）= 组件引用属性。

**`@nodeType({ kind?, label? })`**（类装饰器）：声明脚本可创建的节点类型基础
（ScriptNodeKind，对应编辑器节点类型键），声明后该脚本出现在层级/资源面板的
创建入口（scriptsStore.scriptNodeTypes() 消费）。

编译契约：`src/app/lib/script-compile/compile.ts` 用 TS transpileModule 内存编译
（ES2020 ESM），重写 "tve" 裸导入说明符，transformer 注入
`static __tveComponentKeys`；元数据解析在 `src/app/lib/script-compile/meta.ts`
（parseScriptClassMeta → ScriptPropDef[]/ScriptNodeType）。保存脚本 = 写盘 + 编译
+ props 解析（scriptsStore，schemaRev 递增驱动检查器刷新控件）。

## 使用例

`public/repos/code/Rotator.ts:5`（数值属性 + min）：

```ts
@property({ label: "速度（度/秒）", min: 0 })
speed = 90;
```

`public/repos/code/CameraFollow.ts`（节点引用属性，target 指向场景相机节点）：

```ts
@property({ type: CameraNode, label: "跟随目标" })
target: CameraNode | null = null;
```

工坊原型被资产面板「新建脚本 → 原型」直接落盘（assetService.createScriptAsset
原样写入，不做占位符替换）。

## 测试例

`script-compile/meta.ts` 当前**无 spec**。元数据解析是纯 AST 逻辑，适合单测——
推荐写法（`src/app/lib/script-compile/meta.spec.ts`）：

```ts
import { describe, expect, it } from "vitest";
import { parseScriptClassMeta } from "./meta";

describe("parseScriptClassMeta", () => {
  it("正常：@property 数值属性解析 label/min，初值推断 type", () => { /* … */ });
  it("边界：type 为节点类 → 引用属性；未知类名回退 string", () => { /* … */ });
  it("异常：语法错误源码返回空 schema 且不抛", () => { /* … */ });
  it("空值：无装饰器类返回空 props", () => { /* … */ });
});
```

脚本保存→编译→检查器刷新的端到端链路归手工（Monaco/工作台）；SDK 运行时侧的
装饰器行为由 tve.mjs 实现，回归走 smoke-script-hooks.mjs。
