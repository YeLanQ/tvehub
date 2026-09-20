import { afterEach } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";
import { closeConfirm, confirmState } from "../ui-kit/composables/confirm";
import { closePrompt, promptState } from "../ui-kit/composables/prompt";
import { closeContextMenu } from "../ui-kit/composables/context-menu";
import { dismissAll } from "../ui-kit/composables/toast";

/**
 * vitest 全局 setup（jsdom）。放 src/ 下是刻意的：它 import 的都是 src 内模块，
 * 归根 tsconfig（strict + DOM lib）类型检查；若放仓库根 tests/ 再挂进
 * tsconfig.node.json，composite 项目会因引用了 src 文件而报 TS6059。
 *
 * 只补组件实际会碰到的浏览器 API（不做全家桶），全部带存在性守卫——
 * jsdom 未来内置后自动让位。
 */

// PointerEvent（NumberField 拖拽依赖 button/clientX，老版本 jsdom 缺失）
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

// 指针捕获（NumberField 拖拽起止调用）
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

// 布局观察 / 媒体查询 / 滚动到可见（浮层定位与对话框聚焦场景）
if (typeof window.ResizeObserver === "undefined") {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver =
    ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}
if (typeof window.matchMedia === "undefined") {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// 每条用例后卸载仍挂载的组件（顺带清 Teleport 内容），并复位 ui-kit 全局单例，
// 避免队列/弹层状态跨用例串扰。
enableAutoUnmount(afterEach);
afterEach(() => {
  dismissAll();
  closeContextMenu();
  if (confirmState.open) closeConfirm(false);
  if (promptState.open) closePrompt(null);
});
