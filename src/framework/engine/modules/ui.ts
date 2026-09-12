// ---------------------------------------------------------------------------
// UI 系统（Canvas-Widget，屏幕叠加渲染）——编辑器侧。
//
// 渲染语义（与运行时 public/engine/runtime/ui.mjs 镜像，改动需两侧同步）：
// - 画布（uiCanvasNode）空间每帧贴合活动渲染相机（相机叠加）：
//   - 透视相机：画布平面放在相机前方 d = UI_HALF_HEIGHT / tan(fov/2) 处，
//     使纵向可见范围恰为 2×UI_HALF_HEIGHT 个 UI 单位（与 fov 无关的恒定标尺）；
//   - 正交相机：按缩放 s = orthoTop / UI_HALF_HEIGHT 对齐（平面深度取视轴中点）；
//   - 画布设计矩形按 1:1 设计单位显示（设计分辨率/100，UI_PPU 标准）。画布的
//     缩放模式（scaleMode）是运行时屏幕适配方案，编辑器布局视图不参与映射。
//   画布根对象 matrixAutoUpdate 关闭、矩阵每帧覆写，节点自身变换不参与取景。
// - 定位：Widget/布局容器的位置由锚点系统每帧解析（resolveUIRect：点锚点用
//   anchoredPosition、拉伸锚点用 offset 边距；布局容器再按 horizontal/vertical/
//   grid 排列其直接子 UI 节点）——子节点的 transform.position 不再直接生效。
// - Widget（uiImageNode/uiTextNode/uiButtonNode）材质统一：透明 + 关深度测试 +
//   不写深度 + frustumCulled 关；渲染序 = UI_RENDER_ORDER_BASE + 画布 sortOrder×1e4
//   + Widget sortOrder —— SortOrder 决定画布上 UI 节点的叠加顺序（大者在上）。
// - 编辑视口两种形态（运行时导出物恒为"场景 + UI 叠加"）：
//   - 场景视图：画布整体隐藏（点选同规则）；
//   - 布局视图：UI 独占渲染——除画布祖先链与 gizmo 外的顶层子树临时隐藏，
//     布局视口只显示 Canvas 下的节点（beginSolo/endSolo）。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  UI_HALF_HEIGHT,
  uiFontSizeToUnits,
  uiRenderOrder,
  pxToUnits,
  resolveUIRect,
  resolveUILayoutCenters,
  type UIAlign,
  type UIFontFamily,
  type UIRect,
  type Vec2,
} from "../../prototype/nodes/ui-shared";

export const UI_WIDGET_KINDS = ["uiImageNode", "uiTextNode", "uiButtonNode"] as const;

/** 文本光栅化像素密度（像素 / UI 单位；文本贴图分辨率 = size × PPU） */
export const UI_TEXT_PPU = 128;

const UI_FONT_STACKS: Record<UIFontFamily, string> = {
  system: 'system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: 'Consolas, "Courier New", monospace',
};

/** UI 文本样式（编辑器与运行时共用的绘制输入） */
export interface UITextStyle {
  text: string;
  fontSize: number;
  color: number;
  bold: boolean;
  italic: boolean;
  fontFamily: UIFontFamily;
  align: UIAlign;
}

const _scaleVec = new THREE.Vector3();

/** 数值标注读取（非法回退 fallback） */
function numOf(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * 相机叠加贴合矩阵 M：camSpace = M × uiSpace。
 * 透视 → 平移 (0,0,-d)（d 使画布平面纵向可见 2×UI_HALF_HEIGHT 单位）；正交 →
 * 平移 (0,0,-d) 后按 s0 = |top|/UI_HALF_HEIGHT 对齐。画布设计矩形按 1:1 设计
 * 单位置于该空间——缩放模式（scaleMode）是运行时屏幕适配方案，编辑器布局
 * 视图不参与映射（恒按设计尺寸显示）。与相机 worldMatrix 相乘即画布根矩阵。
 */
export function uiGlueMatrixForCamera(cam: THREE.Camera, out: THREE.Matrix4): THREE.Matrix4 {
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera === true) {
    const oc = cam as THREE.OrthographicCamera;
    const halfH = Math.abs(oc.top) > 1e-6 ? Math.abs(oc.top) : 1;
    const s0 = halfH / UI_HALF_HEIGHT;
    out.makeTranslation(0, 0, -(oc.near + oc.far) / 2);
    out.scale(_scaleVec.set(s0, s0, s0));
    return out;
  }
  const pc = cam as THREE.PerspectiveCamera;
  const fovDeg = pc.fov > 0 ? pc.fov : 50;
  const d = UI_HALF_HEIGHT / Math.tan((fovDeg * Math.PI) / 360);
  out.makeTranslation(0, 0, -d);
  return out;
}

/** 十六进制颜色（UI 样式用）→ css 颜色串 */
function uiCssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** 字体 CSS 串（字号 px 已换算好） */
export function uiFontCss(style: UITextStyle, px: number): string {
  return `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} ${px}px ${UI_FONT_STACKS[style.fontFamily]}`;
}

/** 换行后的文本行（逐字符断行：中文友好；新行丢弃行首空格） */
export function uiWrapText(ctx: CanvasRenderingContext2D, style: UITextStyle, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of style.text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const ch of paragraph) {
      const candidate = line + ch;
      if (line.length > 0 && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = ch === " " ? "" : ch;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** 把文本绘制进 2D 画布（水平按 align，垂直居中；超界自然裁剪） */
export function drawUIText(
  ctx: CanvasRenderingContext2D,
  style: UITextStyle,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h);
  const px = Math.max(4, Math.round(uiFontSizeToUnits(style.fontSize) * UI_TEXT_PPU));
  ctx.font = uiFontCss(style, px);
  ctx.fillStyle = uiCssColor(style.color);
  ctx.textBaseline = "middle";
  ctx.textAlign = style.align;
  const maxWidth = Math.max(1, w - px * 0.25);
  const lines = uiWrapText(ctx, style, maxWidth);
  const lineHeight = px * 1.25;
  const startY = h / 2 - (lines.length * lineHeight) / 2 + lineHeight / 2;
  const anchorX = style.align === "left" ? px * 0.125 : style.align === "right" ? w - px * 0.125 : w / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], anchorX, startY + i * lineHeight);
  }
}

/** 文本样式 → 光栅化 CanvasTexture（sRGB；由调用方持有与释放） */
export function buildUITextTexture(style: UITextStyle, size: Vec2): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.x * UI_TEXT_PPU));
  canvas.height = Math.max(1, Math.round(size.y * UI_TEXT_PPU));
  const ctx = canvas.getContext("2d");
  if (ctx) drawUIText(ctx, style, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 文本样式签名（样式或尺寸变化 → 重光栅化） */
export function uiTextSignature(style: UITextStyle, size: Vec2): string {
  return [style.text, style.fontSize, style.color, style.bold, style.italic, style.fontFamily, style.align, size.x, size.y].join("|");
}

/** 沿父链查找最近的 UI 画布根（userData.uiCanvasRoot === true），无则 null */
export function nearestUICanvasRoot(obj: THREE.Object3D | null): THREE.Object3D | null {
  let cur = obj?.parent ?? null;
  while (cur) {
    if (cur.userData?.uiCanvasRoot === true) return cur;
    cur = cur.parent;
  }
  return null;
}

/** 父链上是否还有其它画布（嵌套画布不作叠加根） */
function hasCanvasAncestor(obj: THREE.Object3D): boolean {
  let cur = obj.parent;
  while (cur) {
    if (cur.userData?.nodeKind === "uiCanvasNode") return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * UI 系统运行态：
 * - 可见性开关（setVisible）：场景视图关（画布整体隐藏，渲染与视口点选同规则——
 *   拾取按祖先可见性过滤，隐藏的画布不可点选）；布局视图开（UI 独占渲染）。
 *   导出运行时（player.mjs + ui.mjs）不受此开关影响，恒显示 UI 且叠加在场景之上。
 * - 每帧渲染前把画布根贴合活动相机、按 SortOrder 合成 Widget 渲染序。
 * - 布局视图独占渲染（beginSolo/endSolo）：主渲染前隐藏画布子树与 gizmo 之外的
 *   全部场景渲染内容（网格/灯光/辅助线/天空面），使布局视口只显示 Canvas 下的
 *   节点；渲染结束恢复。灯光随场景内容隐藏 → 分层多 pass 自然退化为单 pass。
 */
export class UISystem {
  private glueMatrix = new THREE.Matrix4();
  private camMatrix = new THREE.Matrix4();
  /** UI 画布在编辑视口中是否显示（布局视图 true；场景视图 false；默认关） */
  private uiVisible = false;
  /** 场景根（attach 注入；顶层子树隐藏用） */
  private scene: THREE.Scene | null = null;
  /** 独占渲染时保持可见的编辑辅助（gizmo 等，顶层对象） */
  private exempt: THREE.Object3D[] = [];
  /** 本帧隐藏的顶层子树（beginSolo/endSolo 之间） */
  private hiddenSolo: THREE.Object3D[] = [];
  /** 本帧 update() 识别的顶层画布根（嵌套画布除外） */
  private frameTopRoots: THREE.Object3D[] = [];
  /** 布局视图缩放（1 = 1:1 设计尺寸；2D 设计视图导航） */
  private viewZoom = 1;
  /** 布局视图平移（UI 单位；2D 设计视图导航） */
  private viewPan = new THREE.Vector2();
  /** 胶合矩阵 × 缩放/平移 的每帧合成结果（避免每画布重算） */
  private glueView = new THREE.Matrix4();
  private zoomMat = new THREE.Matrix4();

  /** 布局视图当前缩放（gizmo 手柄尺寸补偿用） */
  get zoom(): number {
    return this.viewZoom;
  }

  /**
   * 滚轮缩放（锚点 = 指针处的画布点不动）。
   * 屏幕 UI 点 q = zoom × (c + pan)（q.x = ndc.x×5×aspect，q.y = ndc.y×5，
   * 透视/正交同式）；锚点 c 不动 → pan += q × (1/z' − 1/z)。
   */
  zoomAt(factor: number, ndcX: number, ndcY: number, aspect: number): void {
    const z0 = this.viewZoom;
    const z1 = Math.min(8, Math.max(0.2, z0 * factor));
    if (z1 === z0) return;
    this.viewPan.x += ndcX * UI_HALF_HEIGHT * aspect * (1 / z1 - 1 / z0);
    this.viewPan.y += ndcY * UI_HALF_HEIGHT * (1 / z1 - 1 / z0);
    this.viewZoom = z1;
  }

  /** 平移（拖拽内容跟手：内容右移 = pan.x 减小；屏幕像素 → UI 单位在此换算） */
  panByPixels(dxPx: number, dyPx: number, viewportW: number, viewportH: number, aspect: number): void {
    const z = this.viewZoom;
    this.viewPan.x -= (dxPx * 10 * aspect) / (viewportW * z);
    this.viewPan.y += (dyPx * 10) / (viewportH * z);
  }

  /** 复位布局视图（1:1、无平移） */
  resetView(): void {
    this.viewZoom = 1;
    this.viewPan.set(0, 0);
  }

  /** 注入场景根与独占渲染豁免对象（引擎 mount 后调用一次） */
  attach(scene: THREE.Scene, exempt: THREE.Object3D[]): void {
    this.scene = scene;
    this.exempt = exempt;
  }

  /** 编辑视口 UI 显示开关（布局视图开；场景视图关。根对象可见性由 update 每帧接管） */
  setVisible(visible: boolean): void {
    this.uiVisible = visible;
  }

  isVisible(): boolean {
    return this.uiVisible;
  }

  update(cam: THREE.Camera | null, objects: Map<string, THREE.Object3D>, dragOverride: THREE.Object3D | null = null): void {
    this.frameTopRoots.length = 0;
    // 相机不在场景图内（预览相机）或本帧渲染尚未推进 matrixWorld 时需手动刷新，
    // 否则采到上一帧位姿（与 updateOrthoSkyQuad 同一处理）
    cam?.updateMatrixWorld();
    this.camMatrix.copy(cam?.matrixWorld ?? this.camMatrix);
    for (const obj of objects.values()) {
      if ((obj.userData?.nodeKind as string | undefined) !== "uiCanvasNode") continue;
      const top = !hasCanvasAncestor(obj);
      obj.userData.uiCanvasRoot = top;
      obj.matrixAutoUpdate = false;
      if (!top) continue;
      this.frameTopRoots.push(obj);
      // 画布根可见性由本系统接管：场景视图整体隐藏（点选同规则），布局视图按节点状态显示
      obj.visible = this.uiVisible && obj.userData?.uiNodeVisible !== false;
      if (!this.uiVisible || !obj.visible || !cam) continue;
      // 布局视图恒按设计尺寸 1:1 显示（设计像素/100 = UI 单位）；
      // 缩放模式是运行时适配方案，编辑器不参与映射。
      // 2D 设计视图导航：glue × S(zoom) × T(pan)（S 后 setPosition = 先平移后缩放）
      uiGlueMatrixForCamera(cam, this.glueMatrix);
      this.glueView.multiplyMatrices(
        this.glueMatrix,
        this.zoomMat.makeScale(this.viewZoom, this.viewZoom, 1).setPosition(this.viewPan.x, this.viewPan.y, 0),
      );
      obj.matrix.multiplyMatrices(this.camMatrix, this.glueView);
      obj.matrixWorldNeedsUpdate = true;
    }
    if (!this.uiVisible) return;
    for (const obj of objects.values()) {
      switch (obj.userData?.nodeKind as string | undefined) {
        case "uiImageNode":
        case "uiTextNode":
        case "uiButtonNode":
        case "uiLayoutNode":
          this.applyRenderOrder(obj);
          break;
      }
    }
    // 每帧布局解析：锚点矩形 + 布局容器排列（子节点 transform.position 由本系统
    // 接管；applyTransform 对画布子树内的托管类型只同步旋转，见 SceneSynchronizer）
    for (const root of this.frameTopRoots) {
      if (!root.visible) continue;
      const cw = pxToUnits(numOf(root.userData?.uiDesignW, 1280));
      const ch = pxToUnits(numOf(root.userData?.uiDesignH, 720));
      const rect: UIRect = { cx: 0, cy: 0, w: cw, h: ch };
      root.userData.uiRect = rect;
      this.resolveSubtree(root, rect, dragOverride, false);
    }
  }

  /**
   * 递归解析画布子树：rect 为 owner 局部空间中「owner 矩形」（原点 = owner 中心）。
   * - 托管类型（Widget/布局容器）：resolveUIRect 算出父局部矩形 → 写 obj.position
   *   与 scale（2D 缩放 × 解析尺寸/设计尺寸比，拉伸轴经缩放生效）；子树递归传
   *   「子矩形」（子局部空间）；
   * - 布局容器的直接子节点：位置已由 applyLayout 接管（anchoredPosition 不生效，
   *   与 Unity Layout Group 同语义），只按「本地位置 + 设计尺寸」落矩形标注；
   * - 普通容器（Group/嵌套画布）：矩形按其 transform.position 平移后下传（自身
   *   位置仍走 3D 变换）；
   * - gizmo 拖拽中的子树整体跳过（提交后由下一帧解析接管，避免拖拽中被拉回）。
   */
  private resolveSubtree(
    owner: THREE.Object3D,
    rect: UIRect,
    dragOverride: THREE.Object3D | null,
    ownerIsLayout: boolean,
  ): void {
    for (const child of owner.children) {
      if (typeof (child.userData as Record<string, unknown> | undefined)?.nodeId !== "string") continue;
      const kind = child.userData.nodeKind as string | undefined;
      if (kind !== "uiImageNode" && kind !== "uiTextNode" && kind !== "uiButtonNode" && kind !== "uiLayoutNode") {
        // 普通容器：自身变换照常生效，矩形按其位置平移后传给子树
        child.userData.uiRect = rect;
        this.resolveSubtree(
          child,
          { cx: rect.cx - child.position.x, cy: rect.cy - child.position.y, w: rect.w, h: rect.h },
          dragOverride,
          false,
        );
        continue;
      }
      if (this.inDragSubtree(child, dragOverride)) continue;
      const u = child.userData;
      const design = (u.uiSize ?? { x: 1, y: 1 }) as Vec2;
      const s2 = (u.uiScale2D ?? { x: 1, y: 1 }) as Vec2;
      let r: UIRect;
      if (ownerIsLayout) {
        // 布局接管：位置来自 applyLayout，尺寸 = 设计尺寸 × 2D 缩放（无拉伸语义）
        child.scale.set(s2.x, s2.y, child.scale.z);
        r = { cx: child.position.x, cy: child.position.y, w: design.x * s2.x, h: design.y * s2.y };
      } else {
        r = resolveUIRect(rect, {
          anchorMin: u.uiAnchorMin ?? { x: 0.5, y: 0.5 },
          anchorMax: u.uiAnchorMax ?? { x: 0.5, y: 0.5 },
          pivot: u.uiPivot ?? { x: 0.5, y: 0.5 },
          anchoredPosition: u.uiAnchorPos ?? { x: 0, y: 0 },
          offsetMin: u.uiOffsetMin ?? { x: 0, y: 0 },
          offsetMax: u.uiOffsetMax ?? { x: 0, y: 0 },
          size: design,
        });
        child.position.x = r.cx;
        child.position.y = r.cy;
        // 缩放 = 2D 缩放 × 解析尺寸/设计尺寸（拉伸轴把父矩形差值折算成缩放）
        child.scale.set(
          s2.x * (r.w / Math.max(0.01, design.x)),
          s2.y * (r.h / Math.max(0.01, design.y)),
          child.scale.z,
        );
      }
      u.uiRect = r;
      if (kind === "uiLayoutNode") this.applyLayout(child, r, dragOverride);
      this.resolveSubtree(child, { cx: 0, cy: 0, w: r.w, h: r.h }, dragOverride, kind === "uiLayoutNode");
    }
  }

  /** 布局容器排列直接子 UI 节点（容器局部空间；mode=none 时子节点走锚点定位） */
  private applyLayout(container: THREE.Object3D, rect: UIRect, dragOverride: THREE.Object3D | null): void {
    const u = container.userData;
    const mode = (u.uiLayoutMode as string | undefined) ?? "none";
    if (mode === "none") return;
    const kids: THREE.Object3D[] = [];
    const sizes: Vec2[] = [];
    for (const c of container.children) {
      const ku = c.userData as Record<string, unknown> | undefined;
      const kind = ku?.nodeKind as string | undefined;
      if (kind !== "uiImageNode" && kind !== "uiTextNode" && kind !== "uiButtonNode" && kind !== "uiLayoutNode") {
        continue;
      }
      kids.push(c);
      sizes.push((ku?.uiSize as Vec2 | undefined) ?? { x: 1, y: 1 });
    }
    const centers = resolveUILayoutCenters(
      { cx: 0, cy: 0, w: rect.w, h: rect.h },
      mode as "horizontal" | "vertical" | "grid",
      sizes,
      (u.uiPadding as { left: number; right: number; top: number; bottom: number } | undefined) ?? { left: 0, right: 0, top: 0, bottom: 0 },
      (u.uiSpacing as Vec2 | undefined) ?? { x: 0, y: 0 },
      typeof u.uiGridCols === "number" ? u.uiGridCols : 2,
    );
    for (let i = 0; i < kids.length; i++) {
      const c = centers[i];
      const kid = kids[i];
      if (!c || this.inDragSubtree(kid, dragOverride)) continue;
      kid.position.x = c.x;
      kid.position.y = c.y;
    }
  }

  /** obj 是否处于拖拽子树内（自身即拖拽对象或为其子孙） */
  private inDragSubtree(obj: THREE.Object3D, dragOverride: THREE.Object3D | null): boolean {
    if (!dragOverride) return false;
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur === dragOverride) return true;
      cur = cur.parent;
    }
    return false;
  }

  /**
   * 布局视图主渲染前：隐藏画布祖先链与豁免对象（gizmo）之外的渲染内容
   * （返回隐藏数量；0 = 非 solo，调用方跳过 endSolo）。
   * keep = 画布整棵子树 + 画布祖先链 + 豁免对象整棵子树；对每个 keep 对象，
   * 其不在 keep 中的直接子对象整棵隐藏（场景节点都挂在场景根节点对象下，
   * 不能只扫 scene.children）。只隐藏「当前可见」的子树，endSolo 精确恢复。
   */
  beginSolo(): number {
    this.hiddenSolo.length = 0;
    if (!this.uiVisible || !this.scene) return 0;
    const keep = new Set<THREE.Object3D>();
    for (const root of this.frameTopRoots) {
      root.traverse((d) => keep.add(d));
      let cur: THREE.Object3D | null = root.parent;
      while (cur) {
        keep.add(cur);
        cur = cur.parent;
      }
    }
    for (const obj of this.exempt) {
      obj.traverse((d) => keep.add(d));
      keep.add(obj);
    }
    for (const owner of [...keep]) {
      for (const child of owner.children) {
        if (!keep.has(child) && child.visible) {
          this.hiddenSolo.push(child);
          child.visible = false;
        }
      }
    }
    return this.hiddenSolo.length;
  }

  /** 布局视图主渲染后：恢复被隐藏的顶层子树 */
  endSolo(): void {
    const hidden = this.hiddenSolo;
    this.hiddenSolo = [];
    for (const child of hidden) child.visible = true;
  }

  /** 合成渲染序：画布 sortOrder（父链最近画布根上标注）×1e4 + Widget sortOrder */
  private applyRenderOrder(widget: THREE.Object3D): void {
    const canvas = nearestUICanvasRoot(widget);
    const canvasSort = typeof canvas?.userData?.uiCanvasSort === "number" ? canvas.userData.uiCanvasSort : 0;
    const sort = typeof widget.userData?.uiSort === "number" ? widget.userData.uiSort : 0;
    const order = uiRenderOrder(canvasSort, sort);
    widget.renderOrder = order;
    // Widget 的内部渲染子对象（按钮标签等）随主对象同序
    for (const child of widget.children) {
      if ((child.userData as Record<string, unknown>)?.uiRenderable === true) {
        child.renderOrder = order;
      }
    }
  }
}
