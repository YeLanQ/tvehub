// ---------------------------------------------------------------------------
// 白板缓动曲线表（CSS timing-function 值 + 中文名）：
// 幻灯片的切页动画与元素动画（SvgAnim.easing）共用这一份词汇，避免出现第二套叫法。
// - 命名沿用 Penner 标准族（与脚本 SDK src/runtime/core/tween.ts 的 EASING 同名，
//   便于和白板外的补间动画对上话），值取 easings.net 的等价三次贝塞尔近似；
// - 多项式族与 back 都能用单条 cubic-bezier 表达（back 的 y 超出 0..1 就是超调），
//   elastic / bounce 需要振荡，单条三次贝塞尔表达不出来，故不列入——真要用得把切页
//   改为 Web Animations（element.animate + JS 缓动函数）驱动。
// ---------------------------------------------------------------------------

export interface EasingOption {
  /** CSS animation-timing-function 取值 */
  value: string;
  label: string;
}

/** 元素动画（SvgAnim.easing）默认曲线：CSS 关键字，历史取值，保持不变 */
export const DEFAULT_ANIM_EASING = "ease-in-out";

/** 切页动画默认曲线：与接入曲线选择前的写死值一致，升级前后观感不变 */
export const DEFAULT_SLIDE_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";

/** 可选曲线（顺序即下拉里的顺序，第一项为默认） */
export const EASING_OPTIONS: EasingOption[] = [
  { value: DEFAULT_SLIDE_EASING, label: "缓出（默认）" },
  { value: "linear", label: "线性" },
  { value: "cubic-bezier(0.61, 1, 0.88, 1)", label: "缓出·正弦" },
  { value: "cubic-bezier(0.5, 1, 0.89, 1)", label: "缓出·二次" },
  { value: "cubic-bezier(0.33, 1, 0.68, 1)", label: "缓出·三次" },
  { value: "cubic-bezier(0.22, 1, 0.36, 1)", label: "缓出·五次" },
  { value: "cubic-bezier(0.16, 1, 0.3, 1)", label: "缓出·指数" },
  { value: "cubic-bezier(0.45, 0, 0.55, 1)", label: "缓入缓出·二次" },
  { value: "cubic-bezier(0.65, 0, 0.35, 1)", label: "缓入缓出·三次" },
  { value: "cubic-bezier(0.83, 0, 0.17, 1)", label: "缓入缓出·五次" },
  { value: "cubic-bezier(0.87, 0, 0.13, 1)", label: "缓入缓出·指数" },
  { value: "cubic-bezier(0.34, 1.56, 0.64, 1)", label: "回弹·缓出" },
  { value: "cubic-bezier(0.68, -0.6, 0.32, 1.6)", label: "回弹·缓入缓出" },
];

/** 是否为表内曲线（持久化脏值/历史值收敛用） */
export function isEasingOption(v: unknown): v is string {
  return typeof v === "string" && EASING_OPTIONS.some((o) => o.value === v);
}

/** 取曲线中文名（列表/提示用；表外取值原样返回） */
export function easingLabel(v: string): string {
  return EASING_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
