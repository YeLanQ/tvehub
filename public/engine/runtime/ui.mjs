// ---------------------------------------------------------------------------
// UI 回放系统（Canvas-Widget，屏幕叠加 / 相机叠加）。
//
// 与编辑器 src/framework/engine/modules/ui.ts 镜像（改动需两侧同步）：
// - 画布（uiCanvasNode）空间每帧贴合渲染相机：
//   - 透视：画布平面放相机前方 d = UI_HALF_HEIGHT / tan(fov/2)，纵向可见范围
//     恒为 2×UI_HALF_HEIGHT 个 UI 单位；正交：缩放 s = orthoTop / UI_HALF_HEIGHT。
//   - 画布根矩阵每帧覆写（matrixAutoUpdate=false），画布自身变换不参与取景，
//     子节点 transform 即 UI 坐标（原点=屏幕中心，+x 右 +y 上）。
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
/** 文本光栅化像素密度（像素 / UI 单位） */
const UI_TEXT_PPU = 128;

const UI_WIDGET_KINDS = new Set(["uiImageNode", "uiTextNode", "uiButtonNode"]);
const UI_LABEL_CHILD_NAME = "__uiLabel";

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

function colorOf(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) & 0xffffff : fallback;
}

/** 字号（1080p 参考像素）→ UI 单位 */
function uiFontSizeToUnits(fontSize) {
  return (num(fontSize, 24) / 1080) * UI_HALF_HEIGHT * 2;
}

function fontCss(style, px) {
  const italic = style.italic ? "italic " : "";
  const weight = style.bold ? "700" : "400";
  const family = FONT_STACKS[style.fontFamily] || FONT_STACKS.system;
  return `${italic}${weight} ${px}px ${family}`;
}

/**
 * 相机叠加贴合矩阵 M：camSpace = M × uiSpace（透视平移 / 正交平移后缩放）。
 * 与编辑器 uiGlueMatrixForCamera 同一数学。
 */
export function glueMatrixForCamera(cam, out) {
  if (cam.isOrthographicCamera === true) {
    const halfH = Math.abs(cam.top) > 1e-6 ? Math.abs(cam.top) : 1;
    const s = halfH / UI_HALF_HEIGHT;
    out.makeTranslation(0, 0, -(cam.near + cam.far) / 2);
    out.scale(_scaleVec.set(s, s, s));
    return out;
  }
  const fovDeg = cam.fov > 0 ? cam.fov : 50;
  out.makeTranslation(0, 0, -(UI_HALF_HEIGHT / Math.tan((fovDeg * Math.PI) / 360)));
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
  const canvases = []; // { json, obj, sort, top }
  const widgets = []; // { json, obj, root }
  const byId = new Map();
  const clickHandlers = new Map(); // 按钮节点 id → Set<cb>
  const topRoots = []; // 顶层画布根（主渲染隐藏；endRender 恢复 + 叠加渲染）
  let lastCam = null;

  for (const entry of nodes) {
    const { json, obj } = entry;
    byId.set(json.id, entry);
    if (json.type === "uiCanvasNode") {
      canvases.push({ json, obj, sort: clampCanvasSort(json.sortOrder, 0), top: false });
    } else if (UI_WIDGET_KINDS.has(json.type)) {
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

  /** 每帧（渲染前）：画布根贴合相机（脚本/动画已更新相机位姿之后调用） */
  function update(cam) {
    if (!cam) return;
    lastCam = cam;
    cam.updateMatrixWorld();
    _camMat.copy(cam.matrixWorld);
    for (const c of canvases) {
      c.obj.matrixAutoUpdate = false;
      if (!c.top || !c.obj.visible) continue;
      glueMatrixForCamera(cam, _m);
      c.obj.matrix.multiplyMatrices(_camMat, _m);
      c.obj.matrixWorldNeedsUpdate = true;
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
      if (w.json.type === "uiTextNode") continue;
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
    if (json.type === "uiCanvasNode") return { sortOrder: json.sortOrder ?? 0 };
    if (!UI_WIDGET_KINDS.has(json.type)) return null;
    const snap = {
      sortOrder: clampSort(json.sortOrder, 0),
      size: { ...vec2Of(json.size, 2, 2) },
    };
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

  /**
   * 合并 Widget/画布设置（运行态生效，不回写场景文件）。
   * 支持字段：sortOrder / size / image / color / text / fontSize / bold /
   * italic / fontFamily / align / label / labelColor / labelBold / interactable。
   */
  function updateSettings(id, patch) {
    const w = widgets.find((x) => x.json.id === id);
    if (!w || !patch || typeof patch !== "object") return;
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
        case "image":
          if (j.type !== "uiTextNode" && typeof v === "string" && v !== j.image) {
            j.image = v;
            imageChanged = true;
          }
          break;
        case "color":
          if (j.type !== "uiTextNode") {
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
    if (sizeChanged) rebuildGeometry(w, vec2Of(j.size, 2, 2));
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

  /** 指针 NDC → 画布根本地空间点（与 glueMatrixForCamera 同一数学的逆） */
  function uiPointFor(root, ndc) {
    const cam = lastCam;
    if (!cam || !root) return null;
    const aspect = canvas.clientWidth > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
    if (cam.isOrthographicCamera === true) {
      const s = Math.abs(cam.top) > 1e-6 ? Math.abs(cam.top) / UI_HALF_HEIGHT : 1;
      return { x: (ndc.x * Math.abs(cam.right)) / s, y: (ndc.y * cam.top) / s };
    }
    const fovDeg = cam.fov > 0 ? cam.fov : 50;
    const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
    const d = UI_HALF_HEIGHT / tanHalf;
    return { x: ndc.x * tanHalf * aspect * d, y: ndc.y * tanHalf * d };
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
