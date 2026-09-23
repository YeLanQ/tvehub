```ts tve
import { Component, engine, math } from "tve";

export default class Controls extends Component {
  private offKey?: () => void;

  onStart() {
    // —— 事件订阅（返回取消订阅函数；指针事件参数为 PointerState）——
    this.offKey = engine.input.onKeyDown((key) => {
      // key 为 KeyboardEvent.code（"KeyW"、"Space"、"ArrowLeft"…）
      if (key === "Space") this.jump();
    });
    // engine.input.onKeyUp((key) => {});
    // engine.input.onPointerDown((p) => {});   // p.x / p.y / p.down / p.pointerId
    // engine.input.onPointerUp((p) => {});
    // engine.input.onPointerMove((p) => {});
    // engine.input.onPointerCancel((p) => {}); // 系统抢占：不会再有 onPointerUp
  }

  onUpdate(delta: number) {
    // —— 轮询 ——
    const w = engine.input.isKeyDown("KeyW");
    const arrow = engine.input.keys.has("ArrowLeft"); // 当前按下集合（实时）
    if (w || arrow) this.entity.translate(0, 0, -2 * delta);

    // 主指针（画布内 CSS 像素，左上原点；跟随最后活跃触点）
    void engine.input.pointer.x;
    void engine.input.pointer.down;

    // 多点触控：pointerId → 状态实时映射（鼠标也是一个触点）
    for (const p of engine.input.pointers.values()) void p.pointerId;
    const first = engine.input.getPointer(0);
    void first;
    void math;
  }

  jump() { /* ... */ }

  onDisable() {
    this.offKey?.(); // 释放订阅
  }
}
```
