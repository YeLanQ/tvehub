// ---------------------------------------------------------------------------
// SVG 文档模型（纯数据 + 序列化，无框架依赖）：
// - 文档 = 画布尺寸 + 图层表 + 元素表（元素经 layerId 归属图层，数组顺序即绘制序）；
// - 动画挂在元素上（运动/透明度/填充），导出时生成 SVG 内嵌 <style> @keyframes；
// - 序列化自包含：完整模型 JSON 存进根节点 data-tve-doc 属性（data-* 合法），
//   回读优先解析该属性（无损往返），外部 SVG 走 DOM 遍历兜底（无动画/图层信息降级）。
// ---------------------------------------------------------------------------

export type SvgTool =
  | "select"
  | "rect"
  | "ellipse"
  | "line"
  | "pencil"
  | "pen"
  | "text";

export type SvgElKind = "rect" | "ellipse" | "line" | "pencil" | "path" | "text";

export type SvgAnimKind = "motion" | "opacity" | "fill";

/** 动画：运动（位移/旋转/缩放合成一个 transform 关键帧）、透明度、填充 */
export interface SvgAnim {
  id: string;
  kind: SvgAnimKind;
  /** motion：水平位移 from→to（px） */
  dxFrom: number;
  dxTo: number;
  /** motion：垂直位移 from→to（px） */
  dyFrom: number;
  dyTo: number;
  /** motion：旋转 from→to（deg） */
  rotFrom: number;
  rotTo: number;
  /** motion：缩放 from→to（倍数） */
  sclFrom: number;
  sclTo: number;
  /** opacity：0~1 */
  opFrom: number;
  opTo: number;
  /** fill：颜色 */
  fromColor: string;
  toColor: string;
  /** 时长 / 延迟（秒）；repeat -1 = 无限循环，否则播放次数（≥1） */
  dur: number;
  delay: number;
  repeat: number;
  easing: string;
}

export type SvgTextAlign = "left" | "center" | "right";

export interface SvgStyle {
  fill: string; // "none" 或 #hex
  stroke: string;
  strokeWidth: number;
  opacity: number; // 0~1 元素透明度
  dash: number; // 虚线段长，0 = 实线
  fontSize: number; // text 专用
  textAlign: SvgTextAlign; // text 专用：左/中/右对齐
}

export interface SvgPt {
  x: number;
  y: number;
}

/** 贝塞尔控制柄：相对锚点的偏移（平移元素时无需同步）；无柄 = 直角点 */
export interface SvgCurveHandles {
  /** 入柄（本点与上一点之间的曲线） */
  ci?: SvgPt;
  /** 出柄（本点与下一点之间的曲线） */
  co?: SvgPt;
}

export interface SvgEl {
  id: string;
  kind: SvgElKind;
  layerId: string;
  /** rect/ellipse/text 的包围盒（text 的 x,y 为基线起点） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** line 端点 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** pencil/path 顶点序列 */
  points: SvgPt[];
  /** path 的贝塞尔控制柄（与 points 等长；undefined = 全直线段） */
  curve?: SvgCurveHandles[];
  /** path 是否闭合 */
  closed: boolean;
  text: string;
  /** 富文本样式段（undefined = 全部继承元素默认样式） */
  rich?: SvgRichSpan[];
  style: SvgStyle;
  anims: SvgAnim[];
}

export interface SvgLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0~1
}

export interface SvgDoc {
  w: number;
  h: number;
  /** 绘制顺序：index 0 最底层 */
  layers: SvgLayer[];
  els: SvgEl[];
}

let uid = 0;

/** 生成文档内唯一 id（字母开头，可直接用作 CSS 选择器） */
export function genId(prefix = "e"): string {
  uid += 1;
  return `${prefix}${Date.now().toString(36)}${uid.toString(36)}`;
}

export const DEFAULT_FILL = "#4a9eff";
export const DEFAULT_STROKE = "#1c1c1c";

/** 默认元素样式（铅笔/钢笔默认只描边，其余默认填充） */
export function newStyle(kind: SvgElKind): SvgStyle {
  return {
    fill: kind === "pencil" ? "none" : DEFAULT_FILL,
    stroke: kind === "rect" || kind === "ellipse" ? "none" : DEFAULT_STROKE,
    strokeWidth: 2,
    opacity: 1,
    dash: 0,
    fontSize: 24,
    textAlign: "left",
  };
}

/** 动画默认参数（kind 决定哪些字段生效） */
export function newAnim(kind: SvgAnimKind): SvgAnim {
  return {
    id: genId("a"),
    kind,
    dxFrom: 0,
    dxTo: kind === "motion" ? 80 : 0,
    dyFrom: 0,
    dyTo: 0,
    rotFrom: 0,
    rotTo: kind === "motion" ? 0 : 0,
    sclFrom: 1,
    sclTo: 1,
    opFrom: 1,
    opTo: kind === "opacity" ? 0.2 : 1,
    fromColor: "#4a9eff",
    toColor: kind === "fill" ? "#ff5577" : "#4a9eff",
    dur: 2,
    delay: 0,
    repeat: -1,
    easing: "ease-in-out",
  };
}

export function newLayer(name: string): SvgLayer {
  return { id: genId("l"), name, visible: true, locked: false, opacity: 1 };
}

/** 空白文档：画布 + 一个默认图层 */
export function newDoc(w = 800, h = 600): SvgDoc {
  return { w, h, layers: [newLayer("图层 1")], els: [] };
}

/** 元素包围盒（世界坐标；text 宽度为估算值，仅供选择框显示） */
export function elBBox(el: SvgEl): { x: number; y: number; w: number; h: number } {
  switch (el.kind) {
    case "rect":
    case "ellipse":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "text": {
      const lines = el.text.split("\n");
      const w = Math.max(8, ...lines.map((l) => l.length * el.style.fontSize * 0.62));
      return {
        x: el.x,
        y: el.y - el.style.fontSize * 0.85,
        w,
        h: lines.length * el.style.fontSize * 1.25,
      };
    }
    case "line": {
      const x = Math.min(el.x1, el.x2);
      const y = Math.min(el.y1, el.y2);
      return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
    }
    case "pencil": {
      if (!el.points.length) return { x: el.x, y: el.y, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of el.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case "path": {
      if (!el.points.length) return { x: el.x, y: el.y, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const inc = (x: number, y: number): void => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      };
      el.points.forEach((p, i) => {
        inc(p.x, p.y);
        const h = el.curve?.[i];
        if (h?.co) inc(p.x + h.co.x, p.y + h.co.y);
        if (h?.ci) inc(p.x + h.ci.x, p.y + h.ci.y);
      });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
}

/**
 * path 元素的 d 属性：锚点 + 贝塞尔控制柄生成。
 * 相邻两点中任一带柄 → 三次贝塞尔（C），否则直线段（L）；closed 追加 Z。
 */
export function buildPathD(el: Pick<SvgEl, "points" | "curve" | "closed">): string {
  const pts = el.points;
  if (!pts.length) return "";
  const at = (i: number, which: "ci" | "co"): SvgPt | null => {
    const h = el.curve?.[i]?.[which];
    return h ? { x: pts[i].x + h.x, y: pts[i].y + h.y } : null;
  };
  let d = `M ${num(pts[0].x)} ${num(pts[0].y)}`;
  const n = pts.length;
  const segCount = el.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const c1 = at(i, "co");
    const c2 = at(j, "ci");
    if (c1 || c2) {
      const a = c1 ?? pts[i];
      const b = c2 ?? pts[j];
      d += ` C ${num(a.x)} ${num(a.y)}, ${num(b.x)} ${num(b.y)}, ${num(pts[j].x)} ${num(pts[j].y)}`;
    } else {
      d += ` L ${num(pts[j].x)} ${num(pts[j].y)}`;
    }
  }
  if (el.closed) d += " Z";
  return d;
}

// ---------------------------------------------------------------------------
// 富文本：样式段按字符区间作用于 el.text；渲染/导出统一经 buildTextInner 生成
// 嵌套 tspan（行定位 tspan → 样式运行 tspan），导入时从嵌套 tspan 还原区间。
// ---------------------------------------------------------------------------

/** 单字符生效样式（分组归一化的中间表示） */
export interface SvgRichStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
}

/** 富文本样式段：对 el.text 的字符区间 [start, end) 生效；未设置属性继承元素默认 */
export interface SvgRichSpan {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 文字颜色（覆盖元素 fill） */
  color?: string;
  /** 覆盖字号（px） */
  fontSize?: number;
}

/** 展开为逐字符样式（区间按顺序叠加，后者覆盖前者） */
export function richCharStyles(text: string, rich: SvgRichSpan[] | undefined): SvgRichStyle[] {
  const out: SvgRichStyle[] = Array.from({ length: text.length }, () => ({}));
  for (const sp of rich ?? []) {
    for (let i = Math.max(0, sp.start); i < Math.min(text.length, sp.end); i++) {
      if (sp.bold !== undefined) out[i].bold = sp.bold;
      if (sp.italic !== undefined) out[i].italic = sp.italic;
      if (sp.underline !== undefined) out[i].underline = sp.underline;
      if (sp.color !== undefined) out[i].color = sp.color;
      if (sp.fontSize !== undefined) out[i].fontSize = sp.fontSize;
    }
  }
  return out;
}

/** 相邻同样式字符归组为样式段 */
function groupRichSpans(text: string, styles: SvgRichStyle[]): SvgRichSpan[] | undefined {
  const spans: SvgRichSpan[] = [];
  let start = -1;
  let curKey = "";
  for (let i = 0; i <= text.length; i++) {
    const st = i < text.length ? styles[i] ?? {} : null;
    const key = st ? JSON.stringify(st) : "";
    if (curKey !== "" && key !== curKey) {
      spans.push({ start, end: i, ...(JSON.parse(curKey) as SvgRichStyle) });
      curKey = "";
    }
    if (st && Object.keys(st).length > 0 && curKey === "") {
      start = i;
      curKey = key;
    }
  }
  return spans.length ? spans : undefined;
}

/** 对区间应用样式（布尔属性自动反转：区间内全有则取消）；返回归一化后的样式段 */
export function applyRichSpan(
  text: string,
  rich: SvgRichSpan[] | undefined,
  span: SvgRichSpan,
): SvgRichSpan[] | undefined {
  const styles = richCharStyles(text, rich);
  // 反转决策只看原始状态、循环外一次计算：逐字符重算会因前面的字符已被
  // 改写而逐个翻转，表现为「顺序应用/取消单个字符」
  const decide = (k: "bold" | "italic" | "underline"): boolean => {
    let all = true;
    for (let i = Math.max(0, span.start); i < Math.min(text.length, span.end); i++) {
      if (!styles[i]?.[k]) {
        all = false;
        break;
      }
    }
    return !all;
  };
  const boldVal = span.bold !== undefined ? decide("bold") : undefined;
  const italicVal = span.italic !== undefined ? decide("italic") : undefined;
  const underlineVal = span.underline !== undefined ? decide("underline") : undefined;
  for (let i = Math.max(0, span.start); i < Math.min(text.length, span.end); i++) {
    const st = styles[i];
    if (boldVal !== undefined) st.bold = boldVal;
    if (italicVal !== undefined) st.italic = italicVal;
    if (underlineVal !== undefined) st.underline = underlineVal;
    if (span.color !== undefined) st.color = span.color;
    if (span.fontSize !== undefined) st.fontSize = span.fontSize;
  }
  return groupRichSpans(text, styles);
}

/** 清除区间内的全部富文本样式 */
export function clearRichRange(
  text: string,
  rich: SvgRichSpan[] | undefined,
  start: number,
  end: number,
): SvgRichSpan[] | undefined {
  const styles = richCharStyles(text, rich);
  for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) {
    styles[i] = {};
  }
  return groupRichSpans(text, styles);
}

/** 文本内容变化后收敛样式段（钳制区间、剔除空段） */
export function normalizeRich(text: string, rich: SvgRichSpan[] | undefined): SvgRichSpan[] | undefined {
  if (!rich?.length) return undefined;
  return groupRichSpans(text, richCharStyles(text, rich));
}

/** 逐字符样式 → 渲染运行段 */
function groupRichRuns(
  ln: string,
  styles: SvgRichStyle[],
): { text: string; style: SvgRichStyle }[] {
  const runs: { text: string; style: SvgRichStyle }[] = [];
  let cur: { text: string; style: SvgRichStyle } | null = null;
  for (let i = 0; i < ln.length; i++) {
    const st = styles[i] ?? {};
    if (!cur || JSON.stringify(cur.style) !== JSON.stringify(st)) {
      cur = { text: ln[i], style: st };
      runs.push(cur);
    } else {
      cur.text += ln[i];
    }
  }
  return runs;
}

/**
 * 生成 text 元素的内部标记：按换行拆行（行定位 tspan，行距 1.25 倍字号），
 * 富文本段再拆样式运行 tspan。渲染与导出共用，保证所见即所得。
 */
export function buildTextInner(el: Pick<SvgEl, "x" | "text" | "style" | "rich">): string {
  const lines = el.text.split("\n");
  const styles = richCharStyles(el.text, el.rich);
  let offset = 0;
  return lines
    .map((ln, i) => {
      const lineStart = offset;
      offset += ln.length + 1;
      const pos = `x="${num(el.x)}" dy="${num(i === 0 ? 0 : el.style.fontSize * 1.25)}"`;
      if (!el.rich?.length) {
        return `<tspan ${pos}>${escText(ln)}</tspan>`;
      }
      const body = groupRichRuns(ln, styles.slice(lineStart, lineStart + ln.length))
        .map((r) => {
          const attrs: string[] = [];
          if (r.style.bold) attrs.push(`font-weight="700"`);
          if (r.style.italic) attrs.push(`font-style="italic"`);
          if (r.style.underline) attrs.push(`text-decoration="underline"`);
          if (r.style.color) attrs.push(`fill="${escAttr(r.style.color)}"`);
          if (r.style.fontSize) attrs.push(`font-size="${num(r.style.fontSize)}"`);
          return `<tspan${attrs.length ? " " + attrs.join(" ") : ""}>${escText(r.text)}</tspan>`;
        })
        .join("");
      return `<tspan ${pos}>${body}</tspan>`;
    })
    .join("");
}

/** 从 DOM text 元素还原内容（行 tspan → \n）与富文本段（嵌套样式 tspan） */
export function parseTextContent(el: SvgEl, node: Element): void {
  const lineTspans = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === "tspan");
  if (!lineTspans.length) {
    el.text = node.textContent ?? "";
    return;
  }
  const lines: string[] = [];
  let rich: SvgRichSpan[] | undefined;
  let offset = 0;
  for (const lt of lineTspans) {
    for (const child of Array.from(lt.childNodes)) {
      const seg = child.textContent ?? "";
      const isTspan = child.nodeType === 1 && (child as Element).tagName.toLowerCase() === "tspan";
      if (isTspan && seg) {
        const c = child as Element;
        const sp: SvgRichSpan = { start: offset, end: offset + seg.length };
        const fw = c.getAttribute("font-weight");
        if (fw === "700" || fw === "bold") sp.bold = true;
        if (c.getAttribute("font-style") === "italic") sp.italic = true;
        if ((c.getAttribute("text-decoration") ?? "").includes("underline")) sp.underline = true;
        const col = c.getAttribute("fill");
        if (col) sp.color = col;
        const fs = c.getAttribute("font-size");
        if (fs) sp.fontSize = parseFloat(fs);
        rich = rich ?? [];
        rich.push(sp);
      }
      offset += seg.length;
    }
    lines.push(lt.textContent ?? "");
    offset += 1;
  }
  el.text = lines.join("\n");
  if (rich?.length) el.rich = rich;
}

/** 坐标精度收敛（保留三位小数，消除拖拽浮点噪声；自由点集在导出时统一处理） */
export function roundElCoords(el: SvgEl): void {
  const r3 = (n: number): number => Math.round(n * 1000) / 1000;
  switch (el.kind) {
    case "rect":
    case "ellipse":
      el.x = r3(el.x);
      el.y = r3(el.y);
      el.w = r3(el.w);
      el.h = r3(el.h);
      break;
    case "text":
      el.x = r3(el.x);
      el.y = r3(el.y);
      break;
    case "line":
      el.x1 = r3(el.x1);
      el.y1 = r3(el.y1);
      el.x2 = r3(el.x2);
      el.y2 = r3(el.y2);
      break;
    case "pencil":
    case "path":
      break;
  }
}

/** 三位小数收敛 */
const r3d = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * 在 path 的第 seg 段（points[seg] → points[(seg+1)%n]）上插入锚点：
 * 直线段直接插入；贝塞尔段按 t 做 De Casteljau 分割并重算两侧手柄。
 * pos = 段上采样得到的插入点（曲线精确过点）。返回新锚点下标。
 */
export function insertPathAnchor(el: SvgEl, seg: number, t: number, pos: SvgPt): number {
  const n = el.points.length;
  const j = (seg + 1) % n;
  const co0 = el.curve?.[seg]?.co;
  const ci1 = el.curve?.[j]?.ci;
  const p0 = el.points[seg];
  const p3 = el.points[j];
  const lerp = (a: SvgPt, b: SvgPt, k: number): SvgPt => ({
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
  });
  if (!co0 && !ci1) {
    // 直线段
    el.points.splice(j, 0, { x: r3d(pos.x), y: r3d(pos.y) });
    if (el.curve) el.curve.splice(j, 0, {});
    return j;
  }
  const a1 = { x: p0.x + (co0?.x ?? 0), y: p0.y + (co0?.y ?? 0) };
  const a2 = { x: p3.x + (ci1?.x ?? 0), y: p3.y + (ci1?.y ?? 0) };
  const q0 = lerp(p0, a1, t);
  const q1 = lerp(a1, a2, t);
  const q2 = lerp(a2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const sp = lerp(r0, r1, t);
  const insertAt = el.closed && seg === n - 1 ? n : j;
  el.points.splice(insertAt, 0, { x: r3d(sp.x), y: r3d(sp.y) });
  if (!el.curve) el.curve = [];
  if (el.curve[seg]) el.curve[seg].co = { x: r3d(q0.x - p0.x), y: r3d(q0.y - p0.y) };
  el.curve.splice(insertAt, 0, {
    ci: { x: r3d(r0.x - sp.x), y: r3d(r0.y - sp.y) },
    co: { x: r3d(r1.x - sp.x), y: r3d(r1.y - sp.y) },
  });
  if (el.curve[j]) el.curve[j].ci = { x: r3d(q2.x - p3.x), y: r3d(q2.y - p3.y) };
  return insertAt;
}

export function deletePathAnchor(el: SvgEl, i: number): boolean {
  const n = el.points.length;
  if (n <= 2 || i < 0 || i >= n) return false;
  el.points.splice(i, 1);
  if (el.curve) {
    el.curve.splice(i, 1);
    const prev = i - 1;
    const next = i;
    if (el.curve[prev]) delete el.curve[prev].co;
    if (el.curve[next]) delete el.curve[next].ci;
  }
  return true;
}

/** 指针位置 → path 上最近的段与段上参数/坐标（采样法） */
export function nearestPathSegment(
  el: SvgEl,
  w: SvgPt,
): { seg: number; t: number; pos: SvgPt } | null {
  const n = el.points.length;
  if (n < 2) return null;
  const segCount = el.closed ? n : n - 1;
  const N = 24;
  let best: { seg: number; t: number; pos: SvgPt; d: number } | null = null;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const p0 = el.points[i];
    const p3 = el.points[j];
    const co = el.curve?.[i]?.co;
    const ci = el.curve?.[j]?.ci;
    const a1 = { x: p0.x + (co?.x ?? 0), y: p0.y + (co?.y ?? 0) };
    const a2 = { x: p3.x + (ci?.x ?? 0), y: p3.y + (ci?.y ?? 0) };
    const curve = !!(co || ci);
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const mt = 1 - t;
      const px = curve
        ? mt * mt * mt * p0.x + 3 * mt * mt * t * a1.x + 3 * mt * t * t * a2.x + t * t * t * p3.x
        : p0.x + (p3.x - p0.x) * t;
      const py = curve
        ? mt * mt * mt * p0.y + 3 * mt * mt * t * a1.y + 3 * mt * t * t * a2.y + t * t * t * p3.y
        : p0.y + (p3.y - p0.y) * t;
      const d = (px - w.x) ** 2 + (py - w.y) ** 2;
      if (!best || d < best.d) best = { seg: i, t, pos: { x: r3d(px), y: r3d(py) }, d };
    }
  }
  return best ? { seg: best.seg, t: best.t, pos: best.pos } : null;
}

/** 删除 path 的第 i 个锚点（保留至少 2 个）；接缝处柄失效（直线过渡）。返回是否删除。 */
/** 平移元素（拖拽移动共用） */
export function moveElBy(el: SvgEl, dx: number, dy: number): void {
  switch (el.kind) {
    case "rect":
    case "ellipse":
    case "text":
      el.x += dx;
      el.y += dy;
      break;
    case "line":
      el.x1 += dx;
      el.y1 += dy;
      el.x2 += dx;
      el.y2 += dy;
      break;
    case "pencil":
    case "path":
      for (const p of el.points) {
        p.x += dx;
        p.y += dy;
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

const num = (n: number): string => String(Math.round(n * 100) / 100);

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 单个元素 → SVG 标签（id 必写：动画 CSS 按元素 id 定位；各属性仅输出一次） */
export function elToSvg(el: SvgEl): string {
  const s = el.style;
  const a: string[] = [`id="${escAttr(el.id)}"`];
  switch (el.kind) {
    case "rect":
      a.push(`x="${num(el.x)}"`, `y="${num(el.y)}"`, `width="${num(el.w)}"`, `height="${num(el.h)}"`);
      a.push(`fill="${escAttr(s.fill)}"`);
      if (s.stroke !== "none") a.push(`stroke="${escAttr(s.stroke)}"`, `stroke-width="${num(s.strokeWidth)}"`);
      break;
    case "ellipse":
      a.push(
        `cx="${num(el.x + el.w / 2)}"`,
        `cy="${num(el.y + el.h / 2)}"`,
        `rx="${num(Math.max(0, el.w / 2))}"`,
        `ry="${num(Math.max(0, el.h / 2))}"`,
      );
      a.push(`fill="${escAttr(s.fill)}"`);
      if (s.stroke !== "none") a.push(`stroke="${escAttr(s.stroke)}"`, `stroke-width="${num(s.strokeWidth)}"`);
      break;
    case "line":
      a.push(
        `x1="${num(el.x1)}"`,
        `y1="${num(el.y1)}"`,
        `x2="${num(el.x2)}"`,
        `y2="${num(el.y2)}"`,
        `stroke="${escAttr(s.stroke)}"`,
        `stroke-width="${num(s.strokeWidth)}"`,
        `stroke-linecap="round"`,
      );
      break;
    case "pencil":
      a.push(`points="${el.points.map((p) => `${num(p.x)},${num(p.y)}`).join(" ")}"`, `fill="none"`);
      a.push(`stroke="${escAttr(s.stroke)}"`, `stroke-width="${num(s.strokeWidth)}"`, `stroke-linecap="round"`, `stroke-linejoin="round"`);
      break;
    case "path":
      a.push(`d="${escAttr(buildPathD(el))}"`);
      a.push(`fill="${escAttr(s.fill)}"`);
      if (s.stroke !== "none") {
        a.push(`stroke="${escAttr(s.stroke)}"`, `stroke-width="${num(s.strokeWidth)}"`, `stroke-linejoin="round"`);
      }
      break;
    case "text":
      a.push(`x="${num(el.x)}"`, `y="${num(el.y)}"`, `fill="${escAttr(s.fill)}"`, `font-size="${num(s.fontSize)}"`, `font-family="system-ui, 'Segoe UI', sans-serif"`);
      if (s.textAlign === "center") a.push(`text-anchor="middle"`);
      else if (s.textAlign === "right") a.push(`text-anchor="end"`);
      break;
  }
  if (s.dash > 0 && s.stroke !== "none" && el.kind !== "text") {
    a.push(`stroke-dasharray="${num(s.dash)}"`);
  }
  if (s.opacity < 1) a.push(`opacity="${num(s.opacity)}"`);
  const tag =
    el.kind === "rect" ? "rect"
    : el.kind === "ellipse" ? "ellipse"
    : el.kind === "line" ? "line"
    : el.kind === "pencil" ? "polyline"
    : el.kind === "path" ? "path"
    : "text";
  let inner = "";
  if (el.kind === "text") {
    // 多行 + 富文本：行定位 tspan / 样式运行 tspan（与画布渲染同源）
    inner = buildTextInner(el);
  }
  return `<${tag} ${a.join(" ")}${inner ? ">" + inner + `</${tag}>` : "/>"}`;
}

function keyframesFor(a: SvgAnim): string {
  const kf = (decls: (which: "from" | "to") => string): string =>
    `@keyframes tve-k-${a.id}{from{${decls("from")}}to{${decls("to")}}}`;
  const f3 = (n: number): string => String(Math.round(n * 1000) / 1000);
  if (a.kind === "motion") {
    return kf((which) => {
      const dx = which === "from" ? a.dxFrom : a.dxTo;
      const dy = which === "from" ? a.dyFrom : a.dyTo;
      const rot = which === "from" ? a.rotFrom : a.rotTo;
      const scl = which === "from" ? a.sclFrom : a.sclTo;
      return `transform:translate(${f3(dx)}px,${f3(dy)}px) rotate(${f3(rot)}deg) scale(${f3(scl)});`;
    });
  }
  if (a.kind === "opacity") {
    return kf((which) => `opacity:${f3(which === "from" ? a.opFrom : a.opTo)};`);
  }
  return kf((which) => `fill:${escAttr(which === "from" ? a.fromColor : a.toColor)};`);
}

/** 文档动画 → SVG 内嵌 <style> 内容（keyframes + 按 id 定位的 animation 规则） */
export function buildAnimCss(doc: SvgDoc): string {
  const keyframes: string[] = [];
  const elRules: string[] = [];
  for (const el of doc.els) {
    if (!el.anims?.length) continue;
    const shorts: string[] = [];
    for (const a of el.anims) {
      keyframes.push(keyframesFor(a));
      shorts.push(
        `tve-k-${a.id} ${num(a.dur)}s ${a.easing} ${num(a.delay)}s ${a.repeat < 0 ? "infinite" : Math.max(1, a.repeat)} both`,
      );
    }
    elRules.push(
      `#${el.id}{animation:${shorts.join(",")};transform-box:fill-box;transform-origin:center;}`,
    );
  }
  // 暂停：预览未播放时挂起全部动画（播放状态经根节点 class 切换）
  return [...keyframes, ...elRules, ".tve-paused *{animation-play-state:paused !important;}"].join("\n");
}

/** 文档 → 独立 SVG 文本（图层为 <g>，模型 JSON 存 data-tve-doc；可直接在浏览器打开） */
export function serializeDoc(doc: SvgDoc, playing: boolean): string {
  const layers: string[] = [];
  for (const layer of doc.layers) {
    const els = doc.els.filter((e) => e.layerId === layer.id);
    const attrs = [
      `data-tve-layer="${escAttr(layer.id)}"`,
      `data-tve-name="${escAttr(layer.name)}"`,
    ];
    if (!layer.visible) attrs.push(`display="none"`);
    if (layer.opacity < 1) attrs.push(`opacity="${num(layer.opacity)}"`);
    layers.push(`<g ${attrs.join(" ")}>\n${els.map(elToSvg).join("\n")}\n</g>`);
  }
  const css = buildAnimCss(doc);
  const docJson = escAttr(JSON.stringify(doc));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(doc.w)}" height="${num(doc.h)}" viewBox="0 0 ${num(doc.w)} ${num(doc.h)}" data-tve-doc="${docJson}"${playing ? "" : ` class="tve-paused"`}>`,
    css ? `<style>\n${css}\n</style>` : "",
    ...layers,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const nf = (v: string | null, def = 0): number => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : def;
};

function sanitizeDoc(d: SvgDoc): SvgDoc {
  const doc = d;
  doc.w = doc.w > 0 ? doc.w : 800;
  doc.h = doc.h > 0 ? doc.h : 600;
  doc.layers = Array.isArray(doc.layers) ? doc.layers : [];
  doc.els = Array.isArray(doc.els) ? doc.els : [];
  for (const l of doc.layers) {
    l.id = l.id || genId("l");
    l.name = l.name || "图层";
    l.visible = l.visible !== false;
    l.locked = l.locked === true;
    l.opacity = typeof l.opacity === "number" ? Math.min(1, Math.max(0, l.opacity)) : 1;
  }
  const layerIds = new Set(doc.layers.map((l) => l.id));
  const fallbackLayer = (): SvgLayer => {
    const l = newLayer("图层");
    doc.layers.push(l);
    layerIds.add(l.id);
    return l;
  };
  for (const el of doc.els) {
    el.id = el.id || genId("e");
    el.kind = el.kind ?? "rect";
    if (!el.layerId || !layerIds.has(el.layerId)) el.layerId = fallbackLayer().id;
    el.x = el.x ?? 0;
    el.y = el.y ?? 0;
    el.w = el.w ?? 0;
    el.h = el.h ?? 0;
    el.x1 = el.x1 ?? 0;
    el.y1 = el.y1 ?? 0;
    el.x2 = el.x2 ?? 0;
    el.y2 = el.y2 ?? 0;
    el.points = Array.isArray(el.points) ? el.points : [];
    el.curve =
      Array.isArray(el.curve) && el.curve.length === el.points.length
        ? el.curve.map((h) => ({
            ci: h?.ci ? { x: Math.round(h.ci.x * 1000) / 1000, y: Math.round(h.ci.y * 1000) / 1000 } : undefined,
            co: h?.co ? { x: Math.round(h.co.x * 1000) / 1000, y: Math.round(h.co.y * 1000) / 1000 } : undefined,
          }))
        : undefined;
    el.closed = el.closed === true;
    el.text = el.text ?? "";
    el.rich = normalizeRich(el.text, el.rich);
    el.style = { ...newStyle(el.kind), ...(el.style ?? {}) };
    el.anims = Array.isArray(el.anims)
      ? el.anims.map((a) => ({ ...newAnim(a?.kind ?? "motion"), ...a, id: a?.id || genId("a") }))
      : [];
  }
  return doc;
}

function attrToEl(node: Element, layerId: string): SvgEl | null {
  const tag = node.tagName.toLowerCase();
  const styleOf = (kind: SvgElKind): SvgStyle => {
    const fill = node.getAttribute("fill");
    const stroke = node.getAttribute("stroke");
    const dashStr = node.getAttribute("stroke-dasharray");
    const fontSize = node.getAttribute("font-size");
    return {
      fill: fill ?? (kind === "pencil" ? "none" : "#000000"),
      stroke: stroke ?? (kind === "line" || kind === "pencil" ? "#000000" : "none"),
      strokeWidth: nf(node.getAttribute("stroke-width"), 1),
      opacity: nf(node.getAttribute("opacity"), 1),
      dash: dashStr ? nf(dashStr.split(/[\s,]+/)[0], 0) : 0,
      fontSize: fontSize ? nf(fontSize, 16) : 16,
      textAlign: "left",
    };
  };
  const base = (kind: SvgElKind): SvgEl => ({
    id: node.getAttribute("id") || genId("e"),
    kind,
    layerId,
    x: 0, y: 0, w: 0, h: 0,
    x1: 0, y1: 0, x2: 0, y2: 0,
    points: [],
    closed: false,
    text: "",
    style: styleOf(kind),
    anims: [],
  });
  const parsePoints = (str: string | null): SvgPt[] => {
    if (!str) return [];
    const nums = str.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
    const pts: SvgPt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    return pts;
  };
  switch (tag) {
    case "rect": {
      const el = base("rect");
      el.x = nf(node.getAttribute("x"));
      el.y = nf(node.getAttribute("y"));
      el.w = nf(node.getAttribute("width"));
      el.h = nf(node.getAttribute("height"));
      return el;
    }
    case "ellipse":
    case "circle": {
      const el = base("ellipse");
      const cx = nf(node.getAttribute("cx"));
      const cy = nf(node.getAttribute("cy"));
      const rx = tag === "circle" ? nf(node.getAttribute("r")) : nf(node.getAttribute("rx"));
      const ry = tag === "circle" ? rx : nf(node.getAttribute("ry"));
      el.x = cx - rx;
      el.y = cy - ry;
      el.w = rx * 2;
      el.h = ry * 2;
      return el;
    }
    case "line": {
      const el = base("line");
      el.x1 = nf(node.getAttribute("x1"));
      el.y1 = nf(node.getAttribute("y1"));
      el.x2 = nf(node.getAttribute("x2"));
      el.y2 = nf(node.getAttribute("y2"));
      return el;
    }
    case "polyline": {
      const el = base("pencil");
      el.points = parsePoints(node.getAttribute("points"));
      return el;
    }
    case "polygon": {
      const el = base("path");
      el.points = parsePoints(node.getAttribute("points"));
      el.closed = true;
      return el;
    }
    case "text": {
      const el = base("text");
      el.x = nf(node.getAttribute("x"));
      el.y = nf(node.getAttribute("y"));
      el.style.fontSize = nf(node.getAttribute("font-size"), 16);
      parseTextContent(el, node);
      const ta = node.getAttribute("text-anchor");
      el.style.textAlign = ta === "middle" ? "center" : ta === "end" ? "right" : "left";
      return el;
    }
    default:
      return null;
  }
}

/** SVG 文本 → 文档。优先 data-tve-doc（无损）；外部 SVG 遍历 DOM 兜底（无动画） */
export function parseSvg(text: string): { doc: SvgDoc; warning: string | null } {
  const xml = new DOMParser().parseFromString(text, "image/svg+xml");
  if (xml.getElementsByTagName("parsererror").length || xml.documentElement.nodeName.toLowerCase() !== "svg") {
    throw new Error("不是有效的 SVG 文件");
  }
  const root = xml.documentElement;
  const docAttr = root.getAttribute("data-tve-doc");
  if (docAttr) {
    try {
      const parsed = JSON.parse(docAttr) as SvgDoc;
      return { doc: sanitizeDoc(parsed), warning: null };
    } catch {
      /* JSON 损坏 → 走 DOM 兜底 */
    }
  }
  const w = nf(root.getAttribute("width"), 0) || 800;
  const h = nf(root.getAttribute("height"), 0) || 600;
  const doc = newDoc(w, h);
  doc.layers = [];
  doc.els = [];
  // 顶层 <g> 一个图层；顶层散落的形状收进一个兜底图层
  for (const child of Array.from(root.children)) {
    if (child.tagName.toLowerCase() === "style") continue;
    if (child.tagName.toLowerCase() === "g") {
      const layer = newLayer(child.getAttribute("data-tve-name") || child.getAttribute("id") || `图层 ${doc.layers.length + 1}`);
      layer.visible = child.getAttribute("display") !== "none";
      layer.opacity = nf(child.getAttribute("opacity"), 1);
      doc.layers.push(layer);
      for (const node of Array.from(child.children)) {
        const el = attrToEl(node, layer.id);
        if (el) doc.els.push(el);
      }
    } else {
      let loose = doc.layers.find((l) => l.name === "导入内容");
      if (!loose) {
        loose = newLayer("导入内容");
        doc.layers.push(loose);
      }
      const el = attrToEl(child, loose.id);
      if (el) doc.els.push(el);
    }
  }
  if (!doc.layers.length) doc.layers.push(newLayer("图层 1"));
  return { doc, warning: "外部 SVG：动画与图层信息不可用，已按图形内容导入" };
}
