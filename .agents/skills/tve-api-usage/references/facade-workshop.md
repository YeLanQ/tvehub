# 单元：创意工坊仓库与内置资源 IPC

## 契约

仓库 = `public/repos/<分类>/<文件>`（gitcode TvEHub-Repos 子模块，MIT）。业务代码经
`src/app/lib/repos.ts` 包装层调用，不直用 api。

api 方法（`src/lib/api.ts`）：

| 方法（后端命令） | 用途 |
|---|---|
| `listRepoCategories()` → `RepoCategoryEntry[]` | 全部分类（含文件清单与目录路径） |
| `readRepoFile(category, file)` → string | 读文件（仅文本） |
| `writeRepoFile(category, file, code)` | 写文件（目录不存在自动创建） |
| `deleteRepoFile(category, file)` | 删除文件 |
| `listCodeProtos / readCodeProto / writeCodeProto / deleteCodeProto` | 脚本原型遗留通道，**当前无调用点**，新代码不要用（走上面四个 + code 分类） |
| `readInternalAsset(rel)` → string | 读内置资源（internal/…，只读，编译期内嵌） |
| `scanInternalAssets()` → `AssetEntry[]` | 扫描内置资源目录 |
| `readInternalBinary(rel)` → base64 | 读内置二进制（贴图等一次性复制用） |
| `writeAssetBinary(root, rel, contentB64)` | 写项目内二进制 |

repos.ts 包装层导出：`isTextRepoFile(ext)`、`repoPrototypeExt(id)`（code→ts、
effect→shader，其余分类只读）、`repoCategoryHint(id)`、`listRepoCategories()`、
`loadRepoCategoryTexts(category)`、`readRepoFile`、`writeRepoFile(category, file,
description, code)`（@desc 注释剥离防重复堆积）、`deleteRepoFile`、
`formatRepoSize(size)`、`cachedRepoCategories()`。
类型：`RepoFileEntry { file, name, ext, description, size }`、`RepoFile`、`RepoCategory`。

## 使用例

`src/app/lib/repos.ts:103`（扫描分类并映射展示名/说明/原型扩展名）：

```ts
const cats = await api.listRepoCategories().catch(() => []);
const mapped = cats.map((c) => ({ id: c.id, label: repoLabel(c.id), ... }));
```

`src/app/composables/assets/useAssetActions.ts:120`（工坊脚本「导入到项目」读源码）：

```ts
const code = await readRepoFile(category, file);
```

`src/app/lib/repos.ts:149`（保存原型：描述写入首部 // @desc: 注释）。

## 测试例

当前无 spec。repos.ts 的**纯函数**适合先补（推荐写法，`src/app/lib/repos.spec.ts`）：

```ts
import { describe, expect, it } from "vitest";
import { isTextRepoFile, repoPrototypeExt, formatRepoSize } from "./repos";

describe("仓库纯函数", () => {
  it("isTextRepoFile：大小写不敏感，二进制扩展名拒绝", () => {
    expect(isTextRepoFile("TS")).toBe(true);
    expect(isTextRepoFile("png")).toBe(false);
  });
  it("repoPrototypeExt：code/effect 可写，未知分类只读", () => {
    expect(repoPrototypeExt("code")).toBe("ts");
    expect(repoPrototypeExt("audio")).toBeNull();
  });
  it("formatRepoSize：空值/单位换算（边界）", () => {
    expect(formatRepoSize(0)).toBe("");
    expect(formatRepoSize(1536)).toBe("1.5 KB");
  });
});
```

IPC 调用部分（readRepoFile 等）不直测，同 facade-assets.md 的口径。
