# 单元：资产面板操作

## 操作面：工具栏（AssetToolbar.vue:43）

后退/前进/上级、面包屑导航、搜索、类型筛选、排序（名称/类型/大小）、网格/列表
切换、**导入**（`api.pickImportFiles`）、**导入目录**（pickImportFolders）、刷新。

## 操作面：新建资产（内容区/目录树空白右键，asset-menu.ts:96）

新建场景 / 材质 / 着色器（physical·unlit·toon·sky 四种模板）/ 天空盒（程序化·
立方贴图）/ TextureCube / 地形数据 / 地形材质 / 状态机 / 行为树 / 预制体 / 动画 /
**新建目录** / **创意工坊 ▸ 分类 ▸ 原型**（工坊 code/effect 原型直接落盘为项目
脚本/着色器）/ 导入资产… / 导入目录…
重名自动去重（"Box 2"）；命名校验拒空/`/ \ : ..`（assetService.validateAssetName）。

## 操作面：条目右键（asset-menu.ts:181）

打开（目录）；**添加到场景**（模型→`node.add kind:model`、音频、地形）；Draco
压缩…；提取材质为编辑器材质；实例化到场景（.prefab）；打开编辑器（.fsm/.bt →
逻辑编辑弹层）；打开脚本 / 打开着色器（→ 脚本工作台）；目录内新建脚本/目录；
**复制到项目**（仅 internal 只读资产，按扩展名落默认目录）；复制 / 重命名 / 删除；
复制路径。internal 目录下仅「复制路径 + 刷新」（只读保护）。

## 操作面：目录树右键（AssetTreeNode.vue:97）

折叠/展开、复制、重命名、删除、新建目录（仅 assets/ 内）、复制路径。

## 操作面：选择与拖拽（AssetsPanel.vue）

- 单选/Ctrl 多选/Shift 范围选；主选中项是 F2 重命名与检查器预览的对象（:243）。
- 面板内拖拽 = 移动目录；**外部文件拖入 = 导入当前目录**（:362）。
- 点击 .scene/.fsm/.bt/.shader/.ts 等打开对应编辑器/检查器模式。

## 规则/要点（只读与保护，assetService.ts）

- **internal/**（内置资源）只读：不能新建/导入/重命名/删除，只能「复制到项目」。
- **项目固定目录 assets、src** 不可重命名/删除/移动（isProtectedAsset）。
- 脚本只能建在 src/ 内；导入被拒进 internal 与 src/。
- 重命名/移动场景资产 → `followSceneMove` 自动跟随：当前打开场景指针与
  project.config mainScene 同步改写；移动前脏场景先落盘（assets.ts:133）。
- 脚本改名/删除 → scripts store 同步改写/移除场景内组件引用（engine.patchNode，
  可撤销）。

## 测试例

- 面板组件无 spec；命名/去重/保护纯逻辑真实落点：
  `validateAssetName / suggestAssetName / uniqueRel`——示范 spec 见
  `tve-api-usage` 技能 references/services.md 测试例段。
- 新建资产的模板注入依赖 `loadAssetTemplate`（internal/templates）；工坊原型
  原样落盘。资产 IPC 契约：`tve-api-usage` references/facade-assets.md。
