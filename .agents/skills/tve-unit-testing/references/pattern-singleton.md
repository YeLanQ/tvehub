# 模式：单例 composable / store 测试（fake timers + 复位）

适用：ui-kit 单例浮层（toast/confirm/prompt/context-menu/draco-compress）、app 层
单例 store（logStore 等）、带定时行为的组合函数（use-task-scheduler）。

## 模式要点

1. **模块级单例会跨用例串扰**——`beforeEach` 里复位到空态。ui-kit 四件套的复位已
   全局挂在 `src/test/setup.ts` 的 afterEach（dismissAll/closeContextMenu/
   closeConfirm(false)/closePrompt(null)），自己的 spec 只需再管定时器与专有状态。
2. **定时行为一律 fake timers**：`beforeEach` 里 `vi.useFakeTimers()` +
   复位；`afterEach` 里 `vi.useRealTimers()`；推进用 `vi.advanceTimersByTime(ms)`。
3. 回调桩用 `vi.fn()`，断言 `toBe(run)`（引用相等）而非深比较。
4. 无 Pinia——store 测试就是直接 import 单例（logStore）或 `getXxxStore()` 后
   只调**无 IPC 的纯状态方法**（jsdom 下 isTauri 恒 false，碰 invoke 的方法别测）。
5. 异步初始化（订阅/监听）在 jsdom 下走 isTauri 短路分支，断言"不抛错且状态不变"。

## 测试例（真实摘录）

`src/ui-kit/composables/toast.spec.ts:14-56`——权威范本：

```ts
describe("ui-kit composables/toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dismissAll();                       // 单例复位
  });
  afterEach(() => vi.useRealTimers());

  it("默认停留时长按级别：err 8000 / warn 5000 / 其它 3500", () => {
    toastErr("e"); toastWarn("w"); toastInfo("i"); toastOk("o");
    expect(toasts.value.map((t) => t.duration)).toEqual([8000, 5000, 3500, 3500]);
  });

  it("到期自动离场（淡出 180ms 后移除）", () => {
    const id = toastInfo("hi");
    vi.advanceTimersByTime(3500);
    expect(toasts.value[0]?.leaving).toBe(true);
    vi.advanceTimersByTime(180);
    expect(toasts.value.find((t) => t.id === id)).toBeUndefined();
  });

  it("options.duration 覆盖默认值，action 透传", () => {
    const run = vi.fn();
    toast("ok", "x", { duration: 123, action: { label: "重试", run } });
    expect(toasts.value[0].action?.run).toBe(run);
  });
});
```

四类输入在此文件的落位：正常（入队/时长）、边界（同屏 5 条挤掉最早）、
异常（leave 重复调用无副作用）、空值（dismissAll 清空）。

## 套用到 store

`src/app/stores/log.spec.ts` 推荐写法见 `tve-api-usage` 技能 references/stores.md
测试例段；store 里 new 了引擎/碰 IPC 的 action 不进单测。
