// ---------------------------------------------------------------------------
// UI 系统（Canvas-Widget，屏幕叠加渲染）——编辑器侧。
//
// 渲染语义（与运行时 public/engine/runtime/ui.mjs 镜像，改动需两侧同步）：
// - 画布（uiCanvasNode）空间每帧贴合活动渲染相机（相机叠加）：
//   - 透视相机：画布平面放在相机前方 d = UI_HALF_HEIGHT / tan(fov/2) 处，
//     使纵向可见范围恰为 2×UI_HALF_HEIGHT 个 UI 单位（与 fov 无关的恒定标尺）；
//   - 正交相机：按缩放 s = orthoTop / UI_HALF_HEIGHT 对齐（平面深度取视轴中点）。
//   画布根对象 matrixAutoUpdate 关闭、矩阵每帧覆写，节点自身变换不参与取景；
//   子节点（Widget）的 transform 即 UI 坐标（原点=屏幕中心，+x 右 +y 上）。
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
  type UIAlign,
  type UIFontFamily,
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

/**
 * 相机叠加贴合矩阵 M：camSpace = M × uiSpace。
 * 透视 → 平移 (0,0,-d)；正交 → 平移 (0,0,-d) 后缩放 s（this = T·S，作用为
 * 先缩放 UI 坐标再放深度 d）。与相机的 worldMatrix 相乘后即画布根矩阵。
 */
export function uiGlueMatrixForCamera(cam: THREE.Camera, out: THREE.Matrix4): THREE.Matrix4 {
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera === true) {
    const oc = cam as THREE.OrthographicCamera;
    const halfH = Math.abs(oc.top) > 1e-6 ? Math.abs(oc.top) : 1;
    const s = halfH / UI_HALF_HEIGHT;
    out.makeTranslation(0, 0, -(oc.near + oc.far) / 2);
    out.scale(_scaleVec.set(s, s, s));
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

  update(cam: THREE.Camera | null, objects: Map<string, THREE.Object3D>): void {
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
      uiGlueMatrixForCamera(cam, this.glueMatrix);
      obj.matrix.multiplyMatrices(this.camMatrix, this.glueMatrix);
      obj.matrixWorldNeedsUpdate = true;
    }
    if (!this.uiVisible) return;
    for (const obj of objects.values()) {
      switch (obj.userData?.nodeKind as string | undefined) {
        case "uiImageNode":
        case "uiTextNode":
        case "uiButtonNode":
          this.applyRenderOrder(obj);
          break;
      }
    }
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
