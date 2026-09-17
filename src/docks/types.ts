// ---------------------------------------------------------------------------
// 通用停靠系统类型（编辑器窗口 / 场景图窗口共用）：
// 泛型面板 id P 由各窗口实例化时注入（面板集/标签/持久化键不同，逻辑同一份）。
// ---------------------------------------------------------------------------

export type DockZoneId = "left" | "right" | "bottom";

export const DOCK_ZONES: readonly DockZoneId[] = ["left", "right", "bottom"];

/** 浮动面板窗口（拖出停靠区的面板） */
export interface FloatingDock<P extends string = string> {
  id: number;
  panel: P;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 拖出前的原停靠区（关闭浮动时返回该区） */
  origin: DockZoneId;
  active: P;
}

export interface DockLayout<P extends string = string> {
  zones: Record<DockZoneId, P[]>;
  active: Record<DockZoneId, P>;
  floating: FloatingDock<P>[];
  sizes: { left: number; right: number; bottom: number };
}

/** 页签拖拽落点（停靠区 + 页签插入索引） */
export interface DockDropTarget {
  kind: "zone";
  zone: DockZoneId;
  index: number;
}

/** 拖拽过程状态（App 层据此渲染幽灵/捕获层/落点预览） */
export interface DockDndState<P extends string = string> {
  active: boolean;
  moved: boolean;
  panel: P | null;
  origin: DockZoneId | "floating" | null;
  clientX: number;
  clientY: number;
  startX: number;
  startY: number;
  target: DockDropTarget | null;
}

export interface DockSystemConfig<P extends string> {
  /** 面板注册表（持久化装载时按它校验/兜底） */
  panels: readonly P[];
  labels: Record<P, string>;
  /** 后端 UI 状态 KV 持久化键（各窗口隔离） */
  storageKey: string;
  defaults: () => DockLayout<P>;
  /** 返回 true = 拦截该面板的激活/移动/停靠（宿主钩子，如编辑器动画编辑锁） */
  switchGuard?: (panel: P) => boolean;
}

/** 一套停靠系统实例（每窗口一份；layout/dnd 为响应式对象） */
export interface DockSystem<P extends string = string> {
  readonly panelIds: readonly P[];
  readonly labels: Record<P, string>;
  layout: DockLayout<P>;
  dnd: DockDndState<P>;
  /** 启动时装载已保存布局的 Promise（就绪前使用缺省布局） */
  ready: Promise<void>;
  panelZone(panel: P): DockZoneId | null;
  activate(zone: DockZoneId, panel: P): void;
  removePanel(panel: P): DockZoneId | null;
  dockTo(panel: P, zone: DockZoneId, index?: number): void;
  floatPanel(panel: P, x: number, y: number, origin: DockZoneId): void;
  closeFloating(panel: P): void;
  beginTabDrag(panel: P, origin: DockZoneId | "floating", clientX: number, clientY: number): void;
  registerZoneEl(zone: DockZoneId, el: HTMLElement | null): void;
  beginZoneResize(zone: DockZoneId, clientX: number, clientY: number): void;
}
