// @desc: 虚拟摇杆：拖拽 UI 摇杆头输出方向并驱动目标移动（指针事件 + UI 矩形/坐标换算 + anchoredPosition）
import { Component, property, engine, UIImageNode, Transform } from "tve";

// 使用（建两块 UI 图片，摇杆头为底座的子节点，本脚本挂到摇杆头上）：
// 1. 底座：居中点锚点的 uiImageNode（纯色/半透明圆图），如 120×120；
// 2. 摇杆头：底座的子节点 uiImageNode（如 56×56），锚点对齐底座中心；
// 3. 挂本脚本到摇杆头，target 指向要控制移动的节点（缺省仅输出方向）。
// 输出方向为归一化平面向量 dirX/dirY（上 = +Y，右 = +X），同工程其他脚本可经
// getComponent(类名) 读取复用；控制目标移动 = 平面投影到世界 XZ（上 = -Z 前进）。
// 坐标系：engine.ui 的矩形/坐标原点 = 画布中心、y 向上、单位 = UI 单位；
// engine.input.pointer 为画布 CSS 像素——用 screenToUi 换算到同一空间再比较。
export default class {{CLASS_NAME}} extends Component {
  /** 摇杆底座（缺省 = 摇杆头的父节点） */
  @property({ type: UIImageNode, label: "底座（缺省 = 父节点）" })
  base: UIImageNode | null = null;

  /** 受控移动的目标节点（缺省 = 不移动，仅输出方向） */
  @property({ type: Transform, label: "控制目标（缺省 = 不移动）" })
  target: Transform | null = null;

  /** 目标移动速度（米/秒） */
  @property({ label: "移动速度（米/秒）", min: 0 })
  speed = 4;

  /** 摇杆头可拖拽半径（UI 单位）；0 = 自动（底座短边一半 − 摇杆头半径） */
  @property({ label: "拖拽半径（0 = 自动）", min: 0, step: 1 })
  radius = 0;

  /** 摇杆头半径外仍可起拖的放宽系数（手感用，指头粗） */
  @property({ label: "起拖范围放宽（倍）", min: 1, step: 0.1 })
  grabPad = 1.6;

  /** 输出方向（归一化平面向量；无输入 = 0,0）——供其他脚本读取 */
  dirX = 0;
  dirY = 0;

  private knob: UIImageNode | null = null;
  /** 摇杆头静止位（onStart 记录，松手复位） */
  private restX = 0;
  private restY = 0;
  private dragging = false;

  onStart() {
    if (!(this.entity instanceof UIImageNode)) {
      engine.warn("本脚本请挂到 UI 图片节点（摇杆头）上");
      return;
    }
    this.knob = this.entity;
    if (!this.base && this.entity.parent instanceof UIImageNode) this.base = this.entity.parent;
    if (!this.base) {
      engine.warn("找不到底座：请把摇杆头放进底座图片节点，或在检查器指定 base");
      return;
    }
    // 静止位快照（克隆分量；松手复位用）
    this.restX = this.knob.anchoredPosition.x;
    this.restY = this.knob.anchoredPosition.y;
  }

  onUpdate(delta: number) {
    const pointer = engine.input.pointer;
    if (this.dragging) {
      if (!pointer.down) {
        this.release();
      } else {
        this.dragTo(pointer.x, pointer.y);
      }
    } else if (pointer.down && this.tryBeginDrag(pointer.x, pointer.y)) {
      this.dragging = true;
      this.dragTo(pointer.x, pointer.y);
    }

    // 输出方向 → 控制目标移动（平面投影：UI y+（屏幕上）= 世界 -Z（前进），
    // 与 WASD 的 W = -Z 约定一致；translate 沿目标本地轴，目标带朝向时随头转动）
    if (this.target && delta > 0 && (this.dirX !== 0 || this.dirY !== 0)) {
      this.target.translate(this.dirX * this.speed * delta, 0, -this.dirY * this.speed * delta);
    }
  }

  /** 按下起点是否落在底座范围内（半径放宽 grabPad 倍，方便手指起拖） */
  private tryBeginDrag(px: number, py: number): boolean {
    const zone = this.baseRect();
    if (!zone) return false;
    const p = engine.ui.screenToUi(this.entity, px, py);
    if (!p) return false;
    const dx = p.x - zone.cx, dy = p.y - zone.cy;
    return Math.hypot(dx, dy) <= zone.radius * this.grabPad;
  }

  /** 拖拽中：摇杆头锚点偏移 = 静止位 + 截断到半径内的位移向量；方向 = 位移/半径 */
  private dragTo(px: number, py: number) {
    const zone = this.baseRect();
    if (!zone || !this.knob) return;
    const p = engine.ui.screenToUi(this.entity, px, py);
    if (!p) return;
    let ox = p.x - zone.cx, oy = p.y - zone.cy;
    const len = Math.hypot(ox, oy);
    if (len > zone.radius) {
      ox = (ox / len) * zone.radius;
      oy = (oy / len) * zone.radius;
    }
    this.knob.anchoredPosition = { x: this.restX + ox, y: this.restY + oy };
    this.dirX = ox / zone.radius;
    this.dirY = oy / zone.radius;
  }

  /** 松手：摇杆头复位、方向清零 */
  private release() {
    this.dragging = false;
    this.dirX = 0;
    this.dirY = 0;
    if (this.knob) this.knob.anchoredPosition = { x: this.restX, y: this.restY };
  }

  /** 底座矩形信息（画布局部 UI 坐标；首帧布局解析未完成时为 null） */
  private baseRect(): { cx: number; cy: number; radius: number } | null {
    if (!this.base) return null;
    const rect = engine.ui.rectOf(this.base);
    if (!rect) return null;
    let radius = this.radius;
    if (radius <= 0) {
      // 自动：底座短边一半 − 摇杆头半径（头不出底座）
      const knobRect = engine.ui.rectOf(this.entity);
      radius = Math.max(1, Math.min(rect.w, rect.h) / 2 - (knobRect ? knobRect.w / 2 : 0));
    }
    return { cx: rect.cx, cy: rect.cy, radius };
  }
}
