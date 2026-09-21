# 模式：纯逻辑/工厂测试（构造注入，无 mock）

适用：`src/framework/**` 的数据模型/解析器/收敛/求值器/数学，以及 lib 层纯函数
（如 assetService 的 validateAssetName、repos.ts 的 isTextRepoFile）。

## 模式要点

1. **直接 import 被测对象，依赖用真实轻量实现构造后注入**——本项目 0 处 vi.mock。
   工厂依赖注册表：`createNodeFactory(createDefaultRegistry())`，不造假注册表。
2. framework 模块**不 mount、不开渲染器**。three 核心几何/数学 headless 可用；
   WebGL/WebGPU 路径归 smoke。
3. 解析/收敛类函数的标准断言面：正常输入的字段守恒、非法输入回退默认值、
   钳制边界、克隆隔离（改副本不影响源）。
4. 序列化类函数必测**往返**（toJSON→fromJSON）与悬空引用健壮性。
5. 类型口径：禁 ES2021+ API（根 tsconfig lib ES2020，`vue-tsc --noEmit` 会查 spec）。

## 测试例（真实摘录）

`src/framework/factory/NodeFactory.spec.ts:18-53`——注入式构造 + 回退约定：

```ts
const factory: NodeFactory = createNodeFactory(createDefaultRegistry());

describe("create 通用路径", () => {
  it("按类型派发 + 注入父级/名称/位置；缺省不动模板默认", () => {
    const n = factory.create("node", { parentId: "p", name: "自定义", position: vec3(1, 2, 3) });
    expect(n).toBeInstanceOf(Node);
    expect(n.transform.position).toEqual(vec3(1, 2, 3));
    expect(factory.create("node").parentId).toBeNull();
  });
});

describe("网格与模型", () => {
  it("createMesh 未登记几何回退 box（渲染不中断约定）", () => {
    expect(factory.createMesh("不存在的几何").geometry).toBe("box");
  });
});
```

`src/framework/scene/ScenePrototype.spec.ts`——四类输入的组织范本（19 用例/6 describe）：
默认元数据与设置（空值）、节点树增删查（正常+重复添加）、traverse（空场景无回调）、
序列化往返+缺字段回默认+悬空 childId（异常健壮性）、clone/clear（边界）。

## 覆盖率联动

新增 framework 纯逻辑模块后，把它加进 `vitest.config.ts` 的 `coverage.thresholds`
对应桶（核心 90/85 或派生宽桶 75/70）——步骤与负向验证见 coverage-buckets.md。
