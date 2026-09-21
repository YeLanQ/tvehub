# 单元：资产域 IPC（`src/lib/api.ts` 资产段）

## 契约

全部经 `import { api } from "@/lib/api"`（或相对路径 `../../lib/api`）调用；`root` = 项目根绝对路径，`rel` = 项目内正斜杠相对路径。

| 方法（后端命令） | 用途 |
|---|---|
| `scanAssets(root)` → `AssetEntry[]` | 扫描项目资产树（`kind`: "dir" 或小写扩展名） |
| `scanAssetDb(root)` → `MetaEntry[]` | 扫描 .meta 库（uuid/url/sizeGrid） |
| `readText/writeText(root, rel, content?)` | 项目内文本读写 |
| `readAssetMeta/writeAssetMeta(root, rel, meta?)` | 单资产 .meta 读写 |
| `ensureProjectMeta(root)` | 补齐全项目 .meta |
| `copyAsset(root, rel)` → 新 rel | 复制资产（自动去重命名） |
| `importAssets(root, destDir, sourcePaths)` → 新 rel[] | 外部文件导入项目 |
| `moveAsset(root, rel, destDir)` → 新 rel | 移动资产 |
| `deleteAsset(root, rel)` | 删除资产 |
| `renameAsset(root, rel, newName)` → 新 rel | 重命名资产 |
| `createFolder(root, rel)` → rel | 新建目录 |
| `writeAssetBinary(root, rel, contentB64)` | 写二进制（base64） |
| `setCurrentProjectRoot(root \| null)` | **打开项目后必须先调**：asset:// 协议根就位 |

类型：`AssetEntry { name, path, kind, size }`、`MetaEntry { uuid, url, sizeGrid }`。

## 使用例

业务代码不直调这些方法，走 `assetService`（见 services.md）：

`src/app/services/assetService.ts:227`（导入，服务层封装 + 日志）：

```ts
const imported = await api.importAssets(root, destDir, sourcePaths);
logStore.log("success", `已导入 ${imported.length} 个资产到 ${destDir || "项目根"}`);
```

`src/app/stores/assets.ts:180`（资产树刷新，scanAssets 与 meta 扫描并行）：

```ts
const [list, metas] = await Promise.all([api.scanAssets(root), api.scanAssetDb(root)]);
```

## 测试例

api.* 是薄 IPC 封装，**不直测转发行为**；业务规则（命名校验/去重/只读保护）都在
`src/app/services/assetService.ts`，测那一层——纯函数 `validateAssetName` /
`suggestAssetName` 的示范 spec 见 [services.md](services.md) 测试例段。
