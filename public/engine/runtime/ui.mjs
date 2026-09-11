// ---------------------------------------------------------------------------
// UI 回放系统（Canvas-Widget，屏幕叠加 / 相机叠加）。
//
// 与编辑器 src/framework/engine/modules/ui.ts 镜像（改动需两侧同步）：
// - 画布（uiCanvasNode）空间每帧贴合渲染相机：
//   - 透视：画布平面放相机前方 d = UI_HALF_HEIGHT / tan(fov/2)，纵向可见范围
//     恒为 2×UI_HALF_HEIGHT 个 UI 单位；正交：缩放 s = orthoTop / UI_HALF_HEIGHT。
//   - 画布渲染尺寸 = 设计分辨率/100（UI_PPU 设计标准，100px = 1 单位）按
//     scaleMode 映射到屏幕；运行时舞台固定按设计分辨率取景（aspect = 设计比例），
//     各等比模式收敛为精确铺满，故此处统一按 fixedauto 语义计算。
//   - 画布根矩阵每帧覆写（matrixAutoUpdate=false），画布自身变换不参与取景。
// - 定位：Widget/布局容器位置由锚点系统每帧解析（点锚点 anchoredPosition、
//   拉伸锚点 offset 边距；布局容器按 horizontal/vertical/grid 排列直接子节点）
//   ——与编辑器 resolveUIRect/resolveUILayoutCenters 同一数学。
// - Widget（图片/文本/按钮）材质透明 + 关深度测试 + 不写深度；渲染序 =
//   UI_RENDER_ORDER_BASE + 画布 sortOrder×1e4 + Widget sortOrder（SortOrder
//   决定画布上 UI 节点的叠加顺序，大者在上）。
// - 按钮点击：指针 NDC → 画布空间反投影 → 按渲染序取最上层命中矩形，
//   脚本经 engine.ui.onClick(entity, cb) 订阅。
// - 分层多 pass（Culling Mask）：uiOnlyFirstPass 标记的画布只在首个 pass 绘制。
// ---------------------------------------------------------------------------
import * as THREE from "../core/three.module.min.js";
import { num } from "../core/utils.mjs";
import { loadImageTex } from "./textures.mjs";

/** UI 空间半高（UI 单位；屏幕纵向可见 10 个 UI 单位） */
export const UI_HALF_HEIGHT = 5;
/** renderOrder 基底（与编辑器 UI_RENDER_ORDER_BASE 一致） */
export const UI_RENDER_ORDER_BASE = 1000000;
/** 2D 设计标准：1 UI 单位 = 100 设计像素（与编辑器 UI_PPU 一致） */
export const UI_PPU = 100;
/** 文本光栅化像素密度（像素 / UI 单位） */
const UI_TEXT_PPU = 128;

/** 锚点/布局解析对象类型（Widget + 布局容器） */
const UI_POSITION_KINDS = new Set(["uiImageNode", "uiTextNode", "uiButtonNode", "uiLayoutNode"]);const UI_LABEL_CHILD_NAME = "__uiLabel";

const FONT_STACKS = {
  system: 'system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: 'Consolas, "Courier New", monospace',
};

function clampSort(v, fallback = 0) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(999, Math.max(-999, n));
}

function clampCanvasSort(v, fallback = 0) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(500, Math.max(-500, n));
}

/** 合成渲染序：画布序（权重 1e4）优先，画布内 Widget 序次之 */
export function uiRenderOrder(canvasSortOrder, widgetSortOrder) {
  return UI_RENDER_ORDER_BASE + canvasSortOrder * 10000 + widgetSortOrder;
}

function vec2Of(v, fx, fy) {
  const o = v && typeof v === "object" ? v : {};
  const dim = (n, fb) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0.01, n) : fb);
  return { x: dim(o.x, fx), y: dim(o.y, fy) };
}

/** 任意值 Vec2（分量允许任意有限值；用于锚点位置/偏移） */
function freeVec2Of(v, fx, fy) {
  const o = v && typeof v === "object" ? v : {};
  const dim = (n, fb) => (typeof n === "number" && Number.isFinite(n) ? n : fb);
  return { x: dim(o.x, fx), y: dim(o.y, fy) };
}

/** 归一化 Vec2（分量收敛 0..1；用于锚点/枢轴） */
function unitVec2Of(v, fx, fy) {
  const p = freeVec2Of(v, fx, fy);
  const c01 = (n) => Math.min(1, Math.max(0, n));
  return { x: c01(p.x), y: c01(p.y) };
}

function colorOf(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) & 0xffffff : fallback;
}

/** 字号（设计像素，100px = 1 单位）→ UI 单位 */
function uiFontSizeToUnits(fontSize) {
  return num(fontSize, 24) / UI_PPU;
}

function fontCss(style, px) {
  const italic = style.italic ? "italic " : "";
  const weight = style.bold ? "700" : "400";
  const family = FONT_STACKS[style.fontFamily] || FONT_STACKS.system;
  return `${italic}${weight} ${px}px ${family}`;
}

/** 缩放模式 → 画布缩放系数（与编辑器 uiCanvasModeScale 同一数学） */
function canvasModeScale(mode, screenW, screenH, canvasW, canvasH) {
  const cw = Math.max(0.01, canvasW);
  const ch = Math.max(0.01, canvasH);
  switch (mode) {
    case "noscale": return { sx: 1, sy: 1 };
    case "fixedwidth": return { sx: screenW / cw, sy: screenW / cw };
    case "fixedheight": return { sx: screenH / ch, sy: screenH / ch };
    case "full": return { sx: screenW / cw, sy: screenH / ch };
    default: {
      const s = Math.max(screenW / cw, screenH / ch);
      return { sx: s, sy: s };
    }
  }
}

/**
 * 锚点矩形解析（与编辑器 resolveUIRect 同一数学）：在父矩形内解析 Widget 矩形。
 * 点锚点轴：中心 = 锚点 + anchoredPosition + (0.5 - pivot) × 设计尺寸；
 * 拉伸轴：矩形 = 两锚线之间收进 offset 边距。返回父局部空间坐标。
 */
function resolveUIRect(parent, a) {
  const pMinX = parent.cx - parent.w / 2;
  const pMinY = parent.cy - parent.h / 2;
  const aMinX = Math.min(1, Math.max(0, a.anchorMin.x));
  const aMaxX = Math.min(1, Math.max(0, a.anchorMax.x));
  const aMinY = Math.min(1, Math.max(0, a.anchorMin.y));
  const aMaxY = Math.min(1, Math.max(0, a.anchorMax.y));

  let cx; let w;
  if (aMaxX - aMinX < 1e-6) {
    w = Math.max(0.01, a.size.x);
    cx = pMinX + aMinX * parent.w + a.anchoredPosition.x + (0.5 - Math.min(1, Math.max(0, a.pivot.x))) * w;
  } else {
    const left = pMinX + aMinX * parent.w + a.offsetMin.x;
    const right = pMinX + aMaxX * parent.w - a.offsetMax.x;
    w = Math.max(0.01, right - left);
    cx = (left + right) / 2;
  }

  let cy; let h;
  if (aMaxY - aMinY < 1e-6) {
    h = Math.max(0.01, a.size.y);
    cy = pMinY + aMinY * parent.h + a.anchoredPosition.y + (0.5 - Math.min(1, Math.max(0, a.pivot.y))) * h;
  } else {
    const bottom = pMinY + aMinY * parent.h + a.offsetMin.y;
    const top = pMinY + aMaxY * parent.h - a.offsetMax.y;
    h = Math.max(0.01, top - bottom);
    cy = (bottom + top) / 2;
  }
  return { cx, cy, w, h };
}

/** Widget 数据 → 锚点解析输入（缺省中心点锚点 + 设计尺寸） */
function anchorInputOf(json) {
  return {
    anchorMin: unitVec2Of(json.anchorMin, 0.5, 0.5),
    anchorMax: unitVec2Of(json.anchorMax, 0.5, 0.5),
    pivot: unitVec2Of(json.pivot, 0.5, 0.5),
    anchoredPosition: freeVec2Of(json.anchoredPosition, 0, 0),
    offsetMin: freeVec2Of(json.offsetMin, 0, 0),
    offsetMax: freeVec2Of(json.offsetMax, 0, 0),
    size: vec2Of(json.size, 2, 2),
  };
}

/**
 * 布局排列（与编辑器 resolveUILayoutCenters 同一数学）：容器局部空间
 * （原点 = 容器中心，y 向上）返回每个子元素中心；子元素在槽位内居中。
 */
function resolveUILayoutCenters(rect, mode, sizes, padding, spacing, gridColumns) {
  const n = sizes.length;
  if (mode === "none" || n === 0) return [];
  const contentL = rect.cx - rect.w / 2 + padding.left;
  const contentR = rect.cx + rect.w / 2 - padding.right;
  const contentT = rect.cy + rect.h / 2 - padding.top;
  const contentB = rect.cy - rect.h / 2 - padding.bottom;
  const midY = (contentT + contentB) / 2;
  const midX = (contentL + contentR) / 2;
  const sx = Math.max(0, spacing.x);
  const sy = Math.max(0, spacing.y);
  const out = new Array(n);

  if (mode === "horizontal") {
    let cursor = contentL;
    for (let i = 0; i < n; i++) {
      const w = Math.max(0.01, sizes[i].x);
      out[i] = { x: cursor + w / 2, y: midY };
      cursor += w + sx;
    }
    return out;
  }
  if (mode === "vertical") {
    let cursor = contentT;
    for (let i = 0; i < n; i++) {
      const h = Math.max(0.01, sizes[i].y);
      out[i] = { x: midX, y: cursor - h / 2 };
      cursor -= h + sy;
    }
    return out;
  }
  let cellW = 0.01;
  let cellH = 0.01;
  for (const s of sizes) {
    cellW = Math.max(cellW, s.x);
    cellH = Math.max(cellH, s.y);
  }
  const cols = Math.max(1, Math.round(gridColumns));
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out[i] = {
      x: contentL + col * (cellW + sx) + cellW / 2,
      y: contentT - row * (cellH + sy) - cellH / 2,
    };
  }
  return out;
}

function paddingOf(v) {
  const o = v && typeof v === "object" ? v : {};
  const d = (n, fb) => (typeof n === "number" && Number.isFinite(n) ? n : fb);
  return { left: d(o.left, 0), right: d(o.right, 0), top: d(o.top, 0), bottom: d(o.bottom, 0) };
}

function layoutModeOf(v) {
  return v === "horizontal" || v === "vertical" || v === "grid" ? v : "none";
}

/** 画布贴合缩放（UI 单位 → 相机平面世界单位；正交含基础对齐缩放） */
function glueScaleForCamera(cam, canvasW, canvasH) {
  const aspect = cam.isOrthographicCamera === true
    ? (Math.abs(cam.top - cam.bottom) > 1e-6
        ? Math.abs(cam.right - cam.left) / Math.abs(cam.top - cam.bottom)
        : 1)
    : (cam.aspect > 0 ? cam.aspect : 1);
  const s = canvasModeScale("fixedauto", UI_HALF_HEIGHT * 2 * aspect, UI_HALF_HEIGHT * 2, canvasW, canvasH);
  if (cam.isOrthographicCamera === true) {
    const halfH = Math.abs(cam.top) > 1e-6 ? Math.abs(cam.top) : 1;
    const s0 = halfH / UI_HALF_HEIGHT;
    return { sx: s0 * s.sx, sy: s0 * s.sy };
  }
  return s;
}

/**
 * 相机叠加贴合矩阵 M：camSpace = M × uiSpace（透视平移 / 正交平移后缩放）。
 * 与编辑器 uiGlueMatrixForCamera 同一数学；运行时舞台 aspect = 设计比例，
 * 等比缩放模式收敛为精确铺满，统一按 fixedauto 语义计算。
 */
export function glueMatrixForCamera(cam, out, canvasW = UI_HALF_HEIGHT * 2, canvasH = UI_HALF_HEIGHT * 2) {
  const s = glueScaleForCamera(cam, canvasW, canvasH);
  if (cam.isOrthographicCamera === true) {
    const halfH = Math.abs(cam.top) > 1e-6 ? Math.abs(cam.top) : 1;
    const s0 = halfH / UI_HALF_HEIGHT;
    out.makeTranslation(0, 0, -(cam.near + cam.far) / 2);
    out.scale(_scaleVec.set(s.sx, s.sy, s0));
    return out;
  }
  const fovDeg = cam.fov > 0 ? cam.fov : 50;
  const d = UI_HALF_HEIGHT / Math.tan((fovDeg * Math.PI) / 360);
  out.makeTranslation(0, 0, -d);
  out.scale(_scaleVec.set(s.sx, s.sy, 1));
  return out;
}

const _scaleVec = new THREE.Vector3();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _camMat = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/** UI 文本样式签名（样式或尺寸变化 → 重光栅化） */
export function uiTextSignature(style, size) {
  return [style.text, style.fontSize, style.color, style.bold, style.italic, style.fontFamily, style.align, size.x, size.y].join("|");
}

/** 文本样式 → 光栅化 CanvasTexture（sRGB；调用方持有与释放） */
export function buildUITextTexture(style, size) {
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

/** 换行后的文本行（逐字符断行；新行丢弃行首空格）——与编辑器 uiWrapText 同算法 */
function wrapText(ctx, style, maxWidth) {
  const lines = [];
  for (const paragraph of String(style.text).split("\n")) {
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

/** 文本绘制（水平按 align，垂直居中；超界自然裁剪）——与编辑器 drawUIText 同算法 */
function drawUIText(ctx, style, w, h) {
  ctx.clearRect(0, 0, w, h);
  const px = Math.max(4, Math.round(uiFontSizeToUnits(style.fontSize) * UI_TEXT_PPU));
  ctx.font = fontCss(style, px);
  ctx.fillStyle = `#${(style.color & 0xffffff).toString(16).padStart(6, "0")}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = style.align;
  const maxWidth = Math.max(1, w - px * 0.25);
  const lines = wrapText(ctx, style, maxWidth);
  const lineHeight = px * 1.25;
  const startY = h / 2 - (lines.length * lineHeight) / 2 + lineHeight / 2;
  const anchorX = style.align === "left" ? px * 0.125 : style.align === "right" ? w - px * 0.125 : w / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], anchorX, startY + i * lineHeight);
  }
}

/** UI 材质（叠加语义统一：透明 + 关深度测试/写深度 + 无雾 + 不参与色调映射） */
function uiMaterial() {
  const mat = new THREE.MeshBasicMaterial();
  mat.transparent = true;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.toneMapped = false;
  return mat;
}

function textStyleOf(json, forLabel) {
  return {
    text: forLabel ? String(json.label ?? "Button") : String(json.text ?? "Text"),
    fontSize: num(json.fontSize, 24),
    color: colorOf(forLabel ? json.labelColor : json.color, forLabel ? 0x202020 : 0xffffff),
    bold: forLabel ? json.labelBold === true : json.bold === true,
    italic: forLabel ? false : json.italic === true,
    fontFamily: json.fontFamily === "serif" || json.fontFamily === "mono" ? json.fontFamily : "system",
    align: forLabel ? "center" : json.align === "left" || json.align === "right" ? json.align : "center",
  };
}

// ---------------------------------------------------------------------------
// Widget 构建（nodes.mjs 的 buildSceneTree 按 type 分派到这里）
// ---------------------------------------------------------------------------

/** UI 画布根：Group 容器（uiCanvas 标记；矩阵由 createUI 每帧覆写） */
export function buildUICanvas() {
  const group = new THREE.Group();
  group.userData.uiCanvas = true;
  return group;
}

function planeOf(size) {
  return new THREE.PlaneGeometry(Math.max(0.01, size.x), Math.max(0.01, size.y));
}

/** UI 图片：矩形网格（贴图由 applyTextures 异步回填；无图 = 纯色矩形） */
export function buildUIImage(json) {
  const size = vec2Of(json.size, 2, 2);
  const mesh = new THREE.Mesh(planeOf(size), uiMaterial());
  mesh.material.color.setHex(colorOf(json.color, 0xffffff));
  mesh.userData.uiSizeSig = `${size.x}|${size.y}`;
  return mesh;
}

/** UI 文本：矩形网格 + 文本光栅化贴图（构建期同步绘制） */
export function buildUIText(json) {
  const size = vec2Of(json.size, 4, 1);
  const mesh = new THREE.Mesh(planeOf(size), uiMaterial());
  mesh.userData.uiSizeSig = `${size.x}|${size.y}`;
  const style = textStyleOf(json, false);
  mesh.material.map = buildUITextTexture(style, size);
  mesh.userData.uiTextSig = uiTextSignature(style, size);
  return mesh;
}

/** UI 按钮：背景网格 + __uiLabel 文本子网格（z 偏移浮向相机，同 renderOrder） */
export function buildUIButton(json) {
  const size = vec2Of(json.size, 2, 0.8);
  const mesh = new THREE.Mesh(planeOf(size), uiMaterial());
  mesh.material.color.setHex(colorOf(json.color, 0xc8c8c8));
  mesh.userData.uiSizeSig = `${size.x}|${size.y}`;
  const label = new THREE.Mesh(planeOf(size), uiMaterial());
  label.name = UI_LABEL_CHILD_NAME;
  label.userData.uiRenderable = true;
  label.position.z = 0.02;
  const style = textStyleOf(json, true);
  label.material.map = buildUITextTexture(style, size);
  mesh.userData.uiLabelSig = uiTextSignature(style, size);
  mesh.add(label);
  return mesh;
}

/** UI 布局容器：空 Group（无渲染内容；子元素位置由 createUI 每帧布局解析接管） */
export function buildUILayout() {
  return new THREE.Group();
}

// ---------------------------------------------------------------------------
// 运行态系统
// ---------------------------------------------------------------------------

/**
 * 创建 UI 回放系统。
 * @param {object} opts
 * @param {Array<{json: object, obj: object}>} opts.nodes buildSceneTree 的全节点注册表
 * @param {HTMLCanvasElement|null} opts.canvas 预览画布（按钮指针事件）
 * @param {THREE.Scene|null} opts.scene 场景根（叠加 pass 顶层子树隐藏用）
 * @param {(cam: object) => void|null} opts.render 不清屏叠加渲染回调（player 提供：
 *        置空背景 + autoClear 关 + renderer.render；UI 存在时每帧多一次 UI 专属渲染）
 * @returns UI 系统（update 每帧渲染前调用；beginRender/endRender 画布主渲染隐藏与
 *          专属叠加渲染；applyTextures 贴图异步回填；settingsOf/updateSettings/
 *          onClick/offClick 供 tve SDK 转发）
 */
export function createUI({ nodes, canvas, scene, render }) {
  const texCache = new Map();
  const canvases = []; // { json, obj, sort, top, cw, ch }
  const widgets = []; // { json, obj, root }（Widget + 布局容器，锚点/布局解析对象）
  const byId = new Map();
  const clickHandlers = new Map(); // 按钮节点 id → Set<cb>
  const topRoots = []; // 顶层画布根（主渲染隐藏；endRender 恢复 + 叠加渲染）
  let lastCam = null;

  for (const entry of nodes) {
    const { json, obj } = entry;
    byId.set(json.id, entry);
    if (json.type === "uiCanvasNode") {
      canvases.push({ json, obj, sort: clampCanvasSort(json.sortOrder, 0), top: false });
    } else if (UI_POSITION_KINDS.has(json.type)) {
      widgets.push({ json, obj, root: null });
    }
  }

  // 画布：顶层判定（父链无其它画布即顶层根）+ 排序/首 pass 标注
  for (const c of canvases) {
    let top = true;
    let p = c.obj.parent;
    while (p) {
      if (p.userData?.nodeKind === "uiCanvasNode") {
        top = false;
        break;
      }
      p = p.parent;
    }
    c.top = top;
    c.obj.userData.uiCanvasRoot = top;
    c.obj.userData.uiCanvasSort = c.sort;
    c.obj.userData.uiOnlyFirstPass = true;
    if (top) topRoots.push(c);
  }

  /** 父链最近的画布顶层根（无则 null；画布外 Widget 不参与叠加序合成） */
  function nearestRoot(obj) {
    let p = obj.parent;
    while (p) {
      if (p.userData?.uiCanvasRoot === true) return p;
      p = p.parent;
    }
    return null;
  }

  function applyOrder(w) {
    const root = nearestRoot(w.obj);
    w.root = root;
    const order = uiRenderOrder(root ? root.userData.uiCanvasSort : 0, clampSort(w.json.sortOrder, 0));
    w.obj.renderOrder = order;
    for (const ch of w.obj.children) {
      if (ch.userData?.uiRenderable === true) ch.renderOrder = order;
    }
  }
  widgets.forEach(applyOrder);

  /** 每帧（渲染前）：画布根贴合相机 + 锚点/布局解析（脚本/动画已更新相机位姿之后调用） */
  function update(cam) {
    if (!cam) return;
    lastCam = cam;
    cam.updateMatrixWorld();
    _camMat.copy(cam.matrixWorld);
    for (const c of canvases) {
      c.obj.matrixAutoUpdate = false;
      if (!c.top || !c.obj.visible) continue;
      const cw = num(c.json.designWidth, 1280) / UI_PPU;
      const ch = num(c.json.designHeight, 720) / UI_PPU;
      glueMatrixForCamera(cam, _m, cw, ch);
      c.obj.matrix.multiplyMatrices(_camMat, _m);
      c.obj.matrixWorldNeedsUpdate = true;
    }
    // 每帧布局解析：锚点矩形 + 布局容器排列（与编辑器 UISystem.update 同语义）
    for (const c of canvases) {
      if (!c.top || !c.obj.visible) continue;
      const cw = num(c.json.designWidth, 1280) / UI_PPU;
      const ch = num(c.json.designHeight, 720) / UI_PPU;
      const rootRect = { cx: 0, cy: 0, w: cw, h: ch };
      c.obj.userData.uiRect = rootRect;
      resolveSubtree(c.obj, rootRect, false);
    }
  }

  /**
   * 递归解析画布子树（rect = owner 局部空间中「owner 矩形」，原点 = owner 中心）：
   * Widget/布局容器按锚点解析位置并按「解析尺寸/设计尺寸」比缩放（拉伸轴生效）；
   * 布局容器的直接子节点位置由 applyLayout 接管（anchoredPosition 不生效）；
   * 普通容器（嵌套画布/空组）矩形按其位置平移后下传。
   */
  function resolveSubtree(owner, rect, ownerIsLayout) {
    for (const child of owner.children) {
      const kind = child.userData?.nodeKind;
      if (!UI_POSITION_KINDS.has(kind)) {
        if (typeof child.userData?.nodeId !== "string") continue;
        child.userData.uiRect = rect;
        resolveSubtree(
          child,
          { cx: rect.cx - child.position.x, cy: rect.cy - child.position.y, w: rect.w, h: rect.h },
          false,
        );
        continue;
      }
      const entry = byId.get(child.userData.nodeId);
      if (!entry) continue;
      const t = entry.json.transform ?? {};
      const s = t.scale ?? {};
      const design = vec2Of(entry.json.size, 1, 1);
      let r;
      if (ownerIsLayout) {
        // 布局接管：位置来自 applyLayout，尺寸 = 设计尺寸 × 2D 缩放（无拉伸语义）
        child.scale.set(num(s.x, 1), num(s.y, 1), num(s.z, 1));
        r = { cx: child.position.x, cy: child.position.y, w: design.x * num(s.x, 1), h: design.y * num(s.y, 1) };
      } else {
        r = resolveUIRect(rect, anchorInputOf(entry.json));
        child.position.x = r.cx;
        child.position.y = r.cy;
        // 缩放 = 变换缩放 × 解析尺寸/设计尺寸（拉伸轴把父矩形差值折算成缩放）
        child.scale.set(
          num(s.x, 1) * (r.w / Math.max(0.01, design.x)),
          num(s.y, 1) * (r.h / Math.max(0.01, design.y)),
          num(s.z, 1),
        );
      }
      child.userData.uiRect = r;
      if (kind === "uiLayoutNode") applyLayout(child, entry.json, r);
      resolveSubtree(child, { cx: 0, cy: 0, w: r.w, h: r.h }, kind === "uiLayoutNode");
    }
  }

  /** 布局容器排列直接子 UI 节点（容器局部空间；mode=none 时子节点走锚点定位） */
  function applyLayout(container, json, rect) {
    const mode = layoutModeOf(json.layoutMode);
    if (mode === "none") return;
    const kids = [];
    const sizes = [];
    for (const c of container.children) {
      if (!UI_POSITION_KINDS.has(c.userData?.nodeKind)) continue;
      const e = byId.get(c.userData.nodeId);
      if (!e) continue;
      kids.push(c);
      sizes.push(vec2Of(e.json.size, 1, 1));
    }
    const centers = resolveUILayoutCenters(
      { cx: 0, cy: 0, w: rect.w, h: rect.h },
      mode,
      sizes,
      paddingOf(json.padding),
      freeVec2Of(json.spacing, 0, 0),
      num(json.gridColumns, 2),
    );
    for (let i = 0; i < kids.length; i++) {
      const c = centers[i];
      if (!c) continue;
      kids[i].position.x = c.x;
      kids[i].position.y = c.y;
    }
  }

  let hiddenRoots = null;

  /**
   * 主渲染前：隐藏全部可见的顶层画布根（返回隐藏数量；0 = 无 UI 可跳过 endRender）。
   * UI 不参与主渲染（含分层多 pass）——后续 pass 不清屏重画其它层对象会踩掉 UI；
   * 主渲染完成后调用 endRender 恢复可见并做专属叠加渲染。
   */
  function beginRender() {
    if (topRoots.length === 0) return 0;
    hiddenRoots = [];
    for (const c of topRoots) {
      if (c.obj.visible) {
        hiddenRoots.push(c.obj);
        c.obj.visible = false;
      }
    }
    return hiddenRoots.length;
  }

  /** 主渲染后：恢复画布根可见；只保留画布祖先链可见做一次不清屏叠加渲染 */
  function endRender(cam) {
    const roots = hiddenRoots;
    hiddenRoots = null;
    if (!roots || roots.length === 0 || !render) return;
    for (const root of roots) root.visible = true;
    const keep = new Set();
    for (const root of roots) {
      let cur = root;
      while (cur) {
        keep.add(cur);
        cur = cur.parent;
      }
    }
    const hiddenOthers = [];
    if (scene) {
      for (const child of scene.children) {
        if (!keep.has(child) && child.visible) {
          hiddenOthers.push(child);
          child.visible = false;
        }
      }
    }
    try {
      render(cam);
    } finally {
      for (const child of hiddenOthers) child.visible = true;
    }
  }

  /** 图片/按钮背景贴图异步回填（资产已在导出产物内，按相对路径 fetch） */
  async function applyTextures() {
    for (const w of widgets) {
      if (w.json.type !== "uiImageNode" && w.json.type !== "uiButtonNode") continue;
      const rel = typeof w.json.image === "string" ? w.json.image : "";
      if (!rel) continue;
      const tex = await loadImageTex(texCache, rel, true);
      if (!tex) continue;
      const mat = w.obj.material;
      mat.map = tex;
      mat.needsUpdate = true;
    }
  }

  // —— tve SDK 转发（engine.ui）——

  /** UI 节点设置快照（非 UI 节点返回 null） */
  function settingsOf(id) {
    const entry = byId.get(id);
    if (!entry) return null;
    const { json } = entry;
    if (json.type === "uiCanvasNode") {
      return {
        sortOrder: json.sortOrder ?? 0,
        designWidth: num(json.designWidth, 1280),
        designHeight: num(json.designHeight, 720),
        scaleMode: typeof json.scaleMode === "string" ? json.scaleMode : "fixedauto",
      };
    }
    if (!UI_POSITION_KINDS.has(json.type)) return null;
    const snap = {
      sortOrder: clampSort(json.sortOrder, 0),
      size: { ...vec2Of(json.size, 2, 2) },
      anchorMin: unitVec2Of(json.anchorMin, 0.5, 0.5),
      anchorMax: unitVec2Of(json.anchorMax, 0.5, 0.5),
      pivot: unitVec2Of(json.pivot, 0.5, 0.5),
      anchoredPosition: freeVec2Of(json.anchoredPosition, 0, 0),
      offsetMin: freeVec2Of(json.offsetMin, 0, 0),
      offsetMax: freeVec2Of(json.offsetMax, 0, 0),
    };
    if (json.type === "uiLayoutNode") {
      snap.layoutMode = layoutModeOf(json.layoutMode);
      snap.padding = paddingOf(json.padding);
      snap.spacing = freeVec2Of(json.spacing, 0, 0);
      snap.gridColumns = num(json.gridColumns, 2);
      return snap;
    }
    if (json.type === "uiTextNode") {
      snap.text = String(json.text ?? "");
      snap.fontSize = num(json.fontSize, 24);
      snap.color = colorOf(json.color, 0xffffff);
      snap.bold = json.bold === true;
      snap.italic = json.italic === true;
      snap.fontFamily = json.fontFamily === "serif" || json.fontFamily === "mono" ? json.fontFamily : "system";
      snap.align = json.align === "left" || json.align === "right" ? json.align : "center";
    } else if (json.type === "uiButtonNode") {
      snap.image = String(json.image ?? "");
      snap.color = colorOf(json.color, 0xc8c8c8);
      snap.label = String(json.label ?? "");
      snap.labelColor = colorOf(json.labelColor, 0x202020);
      snap.fontSize = num(json.fontSize, 24);
      snap.labelBold = json.labelBold === true;
      snap.interactable = json.interactable !== false;
    } else {
      snap.image = String(json.image ?? "");
      snap.color = colorOf(json.color, 0xffffff);
    }
    return snap;
  }

  /** 单个 Widget 重排（sortOrder/父画布变化后重算渲染序） */
  function reapplyWidget(w) {
    const c = canvases.find((x) => x.obj === nearestRoot(w.obj));
    if (c) {
      c.sort = clampCanvasSort(c.json.sortOrder, 0);
      c.obj.userData.uiCanvasSort = c.sort;
    }
    applyOrder(w);
  }

  function rebuildGeometry(w, size) {
    for (const mesh of [w.obj, ...w.obj.children.filter((c) => c.name === UI_LABEL_CHILD_NAME)]) {
      mesh.geometry?.dispose();
      mesh.geometry = planeOf(size);
      mesh.userData.uiSizeSig = `${size.x}|${size.y}`;
    }
  }

  function rebuildText(w, style, size) {
    const target = w.json.type === "uiButtonNode"
      ? w.obj.children.find((c) => c.name === UI_LABEL_CHILD_NAME)
      : w.obj;
    if (!target) return;
    const mat = target.material;
    const old = mat.map;
    mat.map = buildUITextTexture(style, vec2Of(size, 4, 1));
    mat.needsUpdate = true;
    old?.dispose();
    if (w.json.type === "uiButtonNode") w.obj.userData.uiLabelSig = uiTextSignature(style, vec2Of(size, 4, 1));
    else w.obj.userData.uiTextSig = uiTextSignature(style, vec2Of(size, 4, 1));
  }

  /** 画布设置合并（运行态生效，不回写场景文件） */
  function updateCanvasSettings(c, patch) {
    const j = c.json;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "sortOrder" && typeof v === "number" && clampSort(v) !== c.sort) {
        c.sort = clampSort(v);
        j.sortOrder = c.sort;
        c.obj.userData.uiCanvasSort = c.sort;
      } else if (k === "designWidth" && typeof v === "number" && Number.isFinite(v)) {
        j.designWidth = Math.min(16384, Math.max(1, Math.round(v)));
      } else if (k === "designHeight" && typeof v === "number" && Number.isFinite(v)) {
        j.designHeight = Math.min(16384, Math.max(1, Math.round(v)));
      } else if (k === "scaleMode" && typeof v === "string" && v) {
        j.scaleMode = v;
      }
    }
  }

  /**
   * 合并 Widget/画布设置（运行态生效，不回写场景文件）。
   * 支持字段：sortOrder / size / 锚点（anchorMin/anchorMax/pivot/anchoredPosition/
   * offsetMin/offsetMax）/ 布局（layoutMode/padding/spacing/gridColumns）/ 画布
   * （designWidth/designHeight/scaleMode）/ image / color / text / fontSize /
   * bold / italic / fontFamily / align / label / labelColor / labelBold / interactable。
   */
  function updateSettings(id, patch) {
    if (!patch || typeof patch !== "object") return;
    const c = canvases.find((x) => x.json.id === id);
    if (c) {
      updateCanvasSettings(c, patch);
      return;
    }
    const w = widgets.find((x) => x.json.id === id);
    if (!w) return;
    const j = w.json;
    const restyleText = {};
    let sizeChanged = false;
    let orderChanged = false;
    let imageChanged = false;
    for (const [k, v] of Object.entries(patch)) {
      switch (k) {
        case "sortOrder":
          if (typeof v === "number" && clampSort(v) !== clampSort(j.sortOrder, 0)) {
            j.sortOrder = clampSort(v);
            orderChanged = true;
          }
          break;
        case "size": {
          const cur = vec2Of(j.size, 2, 2);
          const next = vec2Of(v, cur.x, cur.y);
          if (next.x !== cur.x || next.y !== cur.y) {
            j.size = next;
            sizeChanged = true;
          }
          break;
        }
        case "anchorMin":
          j.anchorMin = unitVec2Of(v, 0.5, 0.5);
          break;
        case "anchorMax":
          j.anchorMax = unitVec2Of(v, 0.5, 0.5);
          break;
        case "pivot":
          j.pivot = unitVec2Of(v, 0.5, 0.5);
          break;
        case "anchoredPosition":
          j.anchoredPosition = freeVec2Of(v, 0, 0);
          break;
        case "offsetMin":
          j.offsetMin = freeVec2Of(v, 0, 0);
          break;
        case "offsetMax":
          j.offsetMax = freeVec2Of(v, 0, 0);
          break;
        case "layoutMode":
          if (j.type === "uiLayoutNode") j.layoutMode = layoutModeOf(v);
          break;
        case "padding":
          if (j.type === "uiLayoutNode") j.padding = paddingOf(v);
          break;
        case "spacing":
          if (j.type === "uiLayoutNode") j.spacing = freeVec2Of(v, 0, 0);
          break;
        case "gridColumns":
          if (j.type === "uiLayoutNode" && typeof v === "number" && Number.isFinite(v)) {
            j.gridColumns = Math.max(1, Math.round(v));
          }
          break;
        case "image":
          if (j.type !== "uiTextNode" && j.type !== "uiLayoutNode" && typeof v === "string" && v !== j.image) {
            j.image = v;
            imageChanged = true;
          }
          break;
        case "color":
          if (j.type !== "uiTextNode" && j.type !== "uiLayoutNode") {
            j.color = colorOf(v, j.color);
            w.obj.material.color.setHex(colorOf(v, j.color));
          }
          break;
        case "text":
          if (j.type === "uiTextNode" && typeof v === "string" && v !== j.text) {
            j.text = v;
            restyleText.text = v;
          }
          break;
        case "fontSize":
          if (typeof v === "number" && Number.isFinite(v)) {
            j.fontSize = Math.min(512, Math.max(4, v));
            restyleText.fontSize = j.fontSize;
          }
          break;
        case "bold":
          if (j.type === "uiTextNode") {
            j.bold = v === true;
            restyleText.bold = j.bold;
          }
          break;
        case "italic":
          if (j.type === "uiTextNode") {
            j.italic = v === true;
            restyleText.italic = j.italic;
          }
          break;
        case "fontFamily":
          if (j.type === "uiTextNode" && (v === "system" || v === "serif" || v === "mono")) {
            j.fontFamily = v;
            restyleText.fontFamily = v;
          }
          break;
        case "align":
          if (j.type === "uiTextNode" && (v === "left" || v === "center" || v === "right")) {
            j.align = v;
            restyleText.align = v;
          }
          break;
        case "label":
          if (j.type === "uiButtonNode" && typeof v === "string" && v !== j.label) {
            j.label = v;
            restyleText.label = v;
          }
          break;
        case "labelColor":
          if (j.type === "uiButtonNode" && typeof v === "number") {
            j.labelColor = colorOf(v, j.labelColor);
            restyleText.labelColor = j.labelColor;
          }
          break;
        case "labelBold":
          if (j.type === "uiButtonNode") {
            j.labelBold = v === true;
            restyleText.labelBold = j.labelBold;
          }
          break;
        case "interactable":
          if (j.type === "uiButtonNode") j.interactable = v !== false;
          break;
      }
    }
    if (sizeChanged && j.type !== "uiLayoutNode") rebuildGeometry(w, vec2Of(j.size, 2, 2));
    if (Object.keys(restyleText).length > 0) {
      const isLabel = j.type === "uiButtonNode";
      rebuildText(w, textStyleOf(j, isLabel), vec2Of(j.size, 2, 2));
    }
    if (imageChanged) {
      const rel = typeof j.image === "string" ? j.image : "";
      const mat = w.obj.material;
      if (!rel) {
        mat.map = null;
        mat.needsUpdate = true;
      } else {
        void loadImageTex(texCache, rel, true).then((tex) => {
          if (!tex) return;
          mat.map = tex;
          mat.needsUpdate = true;
        });
      }
    }
    if (orderChanged) reapplyWidget(w);
  }

  /** 订阅按钮点击（返回解绑函数；非按钮/不可交互返回空解绑） */
  function onClick(id, cb) {
    if (typeof cb !== "function") return () => {};
    const w = widgets.find((x) => x.json.id === id);
    if (!w || w.json.type !== "uiButtonNode") return () => {};
    let set = clickHandlers.get(id);
    if (!set) {
      set = new Set();
      clickHandlers.set(id, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  function offClick(id, cb) {
    clickHandlers.get(id)?.delete(cb);
  }

  // —— 按钮点击命中（指针 → NDC → 画布空间 → 按渲染序取最上层命中矩形）——

  function chainVisible(obj) {
    let cur = obj;
    while (cur) {
      if (cur.visible === false) return false;
      cur = cur.parent;
    }
    return true;
  }

  function pointerNdc(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  /** 指针 NDC → 画布根本地空间点（贴合矩阵的逆：世界点 ÷ 画布贴合缩放） */
  function uiPointFor(root, ndc) {
    const cam = lastCam;
    if (!cam || !root) return null;
    const c = canvases.find((x) => x.obj === root);
    const cw = c ? num(c.json.designWidth, 1280) / UI_PPU : UI_HALF_HEIGHT * 2;
    const ch = c ? num(c.json.designHeight, 720) / UI_PPU : UI_HALF_HEIGHT * 2;
    const aspect = canvas.clientWidth > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
    let wx; let wy;
    if (cam.isOrthographicCamera === true) {
      const s0 = Math.abs(cam.top) > 1e-6 ? Math.abs(cam.top) / UI_HALF_HEIGHT : 1;
      wx = (ndc.x * Math.abs(cam.right)) / s0;
      wy = (ndc.y * cam.top) / s0;
    } else {
      const fovDeg = cam.fov > 0 ? cam.fov : 50;
      const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
      const d = UI_HALF_HEIGHT / tanHalf;
      wx = ndc.x * tanHalf * aspect * d;
      wy = ndc.y * tanHalf * d;
    }
    // 画布贴合缩放（含缩放模式）：世界标尺 → 画布本地坐标
    const s = glueScaleForCamera(cam, cw, ch);
    return { x: wx / s.sx, y: wy / s.sy };
  }

  function dispatchClick(e) {
    const cam = lastCam;
    if (!cam) return;
    const ndc = pointerNdc(e);
    if (!ndc) return;
    const hittable = widgets
      .filter((w) => w.json.type === "uiButtonNode" && w.json.interactable !== false && w.root && chainVisible(w.obj))
      .sort((a, b) => b.obj.renderOrder - a.obj.renderOrder);
    for (const w of hittable) {
      const p = uiPointFor(w.root, ndc);
      if (!p) continue;
      // 画布空间点 → 世界（画布根矩阵）→ 按钮本地（按钮世界矩阵逆），做矩形命中
      _v.set(p.x, p.y, 0).applyMatrix4(w.root.matrixWorld);
      _inv.copy(w.obj.matrixWorld).invert();
      _v.applyMatrix4(_inv);
      const size = vec2Of(w.json.size, 2, 2);
      if (Math.abs(_v.x) <= size.x / 2 && Math.abs(_v.y) <= size.y / 2) {
        const set = clickHandlers.get(w.json.id);
        if (set && set.size > 0) {
          for (const cb of [...set]) {
            try {
              cb();
            } catch (err) {
              console.error("[ui] onClick 回调出错:", err);
            }
          }
        }
        return;
      }
    }
  }

  let downPos = null;
  const onDown = (e) => {
    downPos = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e) => {
    if (!downPos) return;
    const dx = e.clientX - downPos.x;
    const dy = e.clientY - downPos.y;
    downPos = null;
    if (dx * dx + dy * dy > 25) return;
    dispatchClick(e);
  };
  if (canvas) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
  }

  function dispose() {
    if (canvas) {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
    }
    clickHandlers.clear();
  }

  return { update, beginRender, endRender, applyTextures, settingsOf, updateSettings, onClick, offClick, dispose };
}
