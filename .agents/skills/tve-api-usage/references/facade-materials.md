# 单元：材质/着色器/资产写入族 IPC（`src/lib/api.ts` 材质段）

## 契约

后端持有各资产格式（序列化 + 自动补 .meta 都在 Rust 侧），前端只提交收敛后的 JSON。

| 方法（后端命令） | 用途 |
|---|---|
| `materialRead(root, rel)` → doc\|null | 解析 .mat（shader 引用→materialType 渲染分支；缺失 null） |
| `materialWrite(root, rel, name, shader, params)` | 写 .mat（shader = 着色器资产相对路径） |
| `materialDuplicate(root, srcRel, preferName)` → rel | 复制材质为项目资产（internal→assets/materials） |
| `shaderRead(root, rel)` → doc\|null | 解析 .shader（Base/Hooks/Properties/error） |
| `shaderWrite(root, rel, kind)` | 新建 .shader（Shader 指令名 = rel 去扩展名） |
| `shaderWriteSource(root, rel, source)` → doc | 保存源码（解析校验，返回重解析文档含 error） |
| `texcubeWrite(root, rel, name, source, map, faces?)` | 写 .texcube（"equirect"\|"faces"） |
| `skymatWrite(root, rel, name, kind)` | 写天空盒 .mat（"procedural"\|"cube"） |
| `terrainWrite(root, rel, name, settings)` | 写 .terrain（程序化地形预设） |
| `terrainmatWrite(root, rel, name, settings)` | 写 .terrainmat（4 纹理图层 + splatmap） |
| `fsmWrite(root, rel, name, graph)` | 写 .fsm（状态图 JSON 前端已收敛） |
| `behaviorTreeWrite(root, rel, name, tree)` | 写 .bt（节点树 JSON 前端已收敛） |

## 使用例

检查器组件直连 api 写回（防抖），是少数不经 service 的合法直调：

`src/app/lib/materials.ts:20/:51`（读回与保存材质文档）：

```ts
const doc = await api.materialRead(root, rel);
await api.materialWrite(root, rel, name, shader, params);
```

`src/app/components/inspector/TerrainSection.vue:99`（地形 Inspector 防抖写回 .terrain）：

```ts
await api.terrainWrite(root, rel, stemOf(rel), { ...settings });
```

`src/app/components/logic/FsmEditorDialog.vue:129`（FSM 编辑器保存）：

```ts
await api.fsmWrite(root, rel, name, graph);
```

## 测试例

IPC 写入本身不单测（需 Tauri）。着色器管线的**可测纯逻辑**在 framework 词法/转译层，
已有真实 spec 可作范式：

- `src/framework/material/tsl/glslLexer.spec.ts` — GLSL 词法（数字/标识符/运算符/错误记录）
- `src/framework/material/tsl/glslParser.spec.ts` — parseStage 顶层与语句结构
- `src/framework/material/tsl/glslToTsl.spec.ts` — GLSL→TSL 整体翻译（uniform/_Time/控制流）

新增"前端收敛 → 提交写入"类逻辑时，把收敛函数写成纯函数放 framework 或 lib，
按同目录 spec 模式补四类输入用例（规范见 `tve-unit-testing` 技能）。
