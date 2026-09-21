# 单元：业务服务层（`src/app/services/`）

## 契约

无 reactive 状态的用例编排层：业务规则集中于此，落盘成功后由调用方（store）刷新列表。

**`assetService`（assetService.ts:149）** —— 资产 CRUD 与十几种 createXxxAsset：

| 方法 | 规则要点 |
|---|---|
| `createFolder / rename / duplicate / remove / moveTo` | 内置目录（internal/…）与项目固定目录（assets/src）只读保护（isProtectedAsset/isInternalAsset）；rename/moveTo 成功后 `followSceneMove` 跟随改写场景引用与 mainScene 配置 |
| `importPaths(root, destDir, sourcePaths)` | 拒绝导入到 internal 与 src/ |
| `createSceneAsset / createAnimAsset / createPrefabAsset / createScriptAsset` | 模板注入（internal/templates）；目录内去重（uniqueRel）；脚本固定 src/ 目录、工坊原型原样落盘 |
| `createMaterialAsset / createShaderAsset / createShaderFromSource` | 默认挂内置 PBR；kind 经 normalizeShaderKind |
| `createTextureCubeAsset / createSkyboxAsset / createTerrainAsset / createTerrainMaterialAsset / createFsmAsset / createBehaviorTreeAsset` | 默认设置来自 framework 工厂注册表单一来源 |
| `copyInternalToProject` | 按扩展名落默认目录；二进制走 base64 |
| `validateAssetName(name)` → string\|null（:34） | 纯函数：trim、拒空/`/ \ : ..` |
| `suggestAssetName(assets, base, stem, ext)`（:44） | 纯函数：目录内不冲突建议名 |

**`editorService`（editorService.ts）**：`mountEditor(container)`（:182，项目配置→
scene_open→材质/模型预取→场景构建→揭幕）、`disposeEditor()`（:459，幂等容错）、
`reloadEditorScene(root, rel)`（切换场景重装会话）。

**`fs-watch.ts`**：`installFsWatch()`（:38，项目目录变更→外部改盘事件）。

## 使用例

`src/app/stores/assets.ts:215`（store 委托业务层，成功后自刷列表）：

```ts
const r = await assetService.rename(root, rel, newName);
```

`src/app/services/assetService.ts:169`（业务层内部：IPC + 场景引用跟随）：

```ts
const r = await api.renameAsset(root, rel, newName);
await followSceneMove(root, rel, r);
```

## 测试例

当前无 spec。服务层里**最值得先测的纯函数**（推荐写法，
`src/app/services/assetService.spec.ts`）：

```ts
import { describe, expect, it } from "vitest";
import { suggestAssetName, validateAssetName } from "./assetService";

describe("validateAssetName", () => {
  it("正常：trim 后返回", () => expect(validateAssetName(" My Mesh ")).toBe("My Mesh"));
  it("异常：路径分隔符与 .. 拒绝", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "..", "a..b_placeholder".replace("_placeholder", "")]) {
      expect(validateAssetName(bad)).toBeNull();
    }
  });
  it("空值：空串/纯空白返回 null", () => {
    expect(validateAssetName("")).toBeNull();
    expect(validateAssetName("   ")).toBeNull();
  });
});

describe("suggestAssetName", () => {
  const assets = [{ name: "x", path: "assets/Box.mat", kind: "mat", size: 0 }];
  it("无冲突返回原名", () =>
    expect(suggestAssetName(assets, "assets", "Box", ".mat")).toBe("Box.mat"));
  it("冲突自动加序号（大小写不敏感）", () =>
    expect(suggestAssetName(assets, "assets", "box", ".mat")).toBe("box 2.mat"));
});
```

editorService 涉及引擎/IPC 生命周期，不进单测（渲染链路归 smoke，见
`tve-unit-testing` 技能 smoke-boundary.md）。
