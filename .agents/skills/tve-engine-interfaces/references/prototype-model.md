# 单元：原型数据模型（`src/framework/prototype/`）

## 契约

接口层级（interfaces.ts）：`IPrototype { typeKey; clone(); toJSON(): JsonValue }`
→ `ITransform`（position/rotation(度)/scale + set 系 + copyFrom/equals）→
`INode { id, name, parentId, childIds, active, visible, tag, layer(0-31), prefab,
transform: Transform, properties: JsonRecord, components: NodeComponentRef[] }`。

- `Node`（Node.ts）：实现 INode；`clone()` 生成**新 id**、properties 深拷贝；
  组件引用见 `components/registry.ts`（descriptorOf 查表 / parseNodeComponents 清洗）。
- `Transform`：度制欧拉；setter/copyFrom 均克隆隔离（改副本不动源）。
- `PrototypeRegistry`：typeKey → 派生类注册表；`fromJSON` 按类型分发、旧场景兼容。
- `derived/Primitives`：18 种派生节点类（mesh/light/camera/skybox/audio/particle/
  terrain/nav/fsm/bt/fog/ui* 等）。
- `prefab.ts`：`serializePrefabTree / instantiatePrefabTree`——.prefab 文档
  （嵌套 children）↔ 场景根同形状；实例化时节点/组件 id 全部重生成。
- 派生节点属性的**收敛函数**在各系统 types 模块（parseXxxSettings：钳制/回退默认/
  克隆/签名），是检查器 ↔ 序列化的边界。

## 使用例

`src/framework/engine/starterScene.ts`（初始场景构建：工厂 + 文档组装）：

```ts
export function buildStarterSceneDoc(factory: NodeFactory) { /* addXxx + toJSON */ }
```

`src/app/services/assetService.ts:316`（新建 .prefab：单节点嵌套文档，模板 id 仅占位）。
检查器分区（useInspector*）读写的是派生节点 properties + 对应 parse 收敛函数。

## 测试例

本单元是全仓库测试最密的面（核心桶 90/85/85/90），四个真实 spec：

- `src/framework/prototype/Node.spec.ts` — 构造默认值、init 克隆、层级链、可见/激活收敛
- `src/framework/prototype/Transform.spec.ts` — 默认值、setter/copyFrom 克隆隔离
- `src/framework/prototype/PrototypeRegistry.spec.ts` — 注册/派生实例/fromJSON 分发/旧场景兼容
- `src/framework/prototype/prefab.spec.ts` — 序列化/实例化往返、id 重生成

配套：`types.spec.ts`（vec3/cloneRecord 深拷贝）、`components.spec.ts`（描述符清洗）。

**新增派生节点类的必做清单**：Primitives 加类 → PrototypeRegistry 登记 →
EditorEngine SCRIPT_NODE_BASE 加创建函数（漏登记编译报错）→ 同目录 spec 补四类
输入用例 → 覆盖率进 prototype/** 宽桶（或提升进核心桶）。
