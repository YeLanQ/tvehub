# 模式：组件测试（mount + Teleport 浮层）

适用：`src/ui-kit/components/**`、`src/app/components/**`（浮层类）。环境 jsdom +
`src/test/setup.ts`（已补 PointerEvent/指针捕获/ResizeObserver/matchMedia/scrollIntoView，
已 `enableAutoUnmount(afterEach)` 自动卸载，不用手动 unmount）。

## 模式要点

1. `mount` 自 `@vue/test-utils`；props 驱动，断言 DOM 结构/class/**组件自己写入的
   内联样式绑定**。
2. **不 import SCSS、不断言计算后的主题值**——jsdom 不算 CSS；主题变量只存在于
   `src/ui-kit/styles/variables.scss`。组件发明的 CSS 变量（如 Slider 的 `--fill`）
   可以断言，因为那是内联 style。
3. **Teleport 到 body 的浮层**（ComboBox/MultiSelect/ContextMenu/对话框/ToastHost/
   下拉）不在 wrapper 里：直接 `document.querySelector` + 原生 `dispatchEvent`；
   异步开合后 `await flushPromises()`。
4. 回调断言用 `w.emitted("update:modelValue")`。
5. Tauri 窗口组件（TitleBar/WindowControls）：jsdom 下 `isTauri()` 恒 false，专测
   浏览器分支渲染与不抛错。

## 测试例（真实摘录）

`src/ui-kit/components/Slider.spec.ts`——普通挂载 + 内联样式变量断言：

```ts
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import Slider from "./Slider.vue";

it("填充比例写入 --fill 内联变量并越界钳制", () => {
  const w = mount(Slider, { props: { modelValue: 120, min: 0, max: 100 } });
  expect(w.find(".slider-fill").attributes("style")).toContain("--fill: 100%");
});
```

`src/ui-kit/components/ComboBox.spec.ts:16-52`——Teleport 浮层三板斧
（helper 收敛 + document 查询 + flushPromises）：

```ts
async function openBox(value = "foo") {
  const w = mount(ComboBox, { props: { modelValue: value, options: OPTIONS } });
  await w.find("input").trigger("focus");
  await flushPromises();          // 等浮层 teleport 完成
  return w;
}
const menu = (): Element | null => document.querySelector(".combo-box-menu");

it("点候选提交并关闭", async () => {
  const w = await openBox();
  document.querySelectorAll(".combo-box-row")[1]
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  expect(w.emitted("update:modelValue")).toEqual([["bar"]]);
  expect(menu()).toBeNull();
});
```

## 空值/异常类怎么落

- 空选项数组 → 空态文案；非法输入 → 钳制或回退（NumberField 的 8 位有效数字格式化、
  commit 钳制见 `src/ui-kit/components/NumberField.spec.ts`）。
- 事件竞态（重复点击、Escape 后再提交）→ 断言只兑现一次
  （ConfirmDialog.spec / PromptDialog.spec）。
