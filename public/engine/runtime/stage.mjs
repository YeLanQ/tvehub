// 渲染器创建与舞台适配：“显示与运行”——渲染器按项目设置的后端创建
// （webgl / webgpu / auto），舞台按项目设计分辨率取景/渲染，再按缩放模式适配
// iframe 显示（noscale=原尺寸 / fixedwidth=等比宽度铺满 / fixedheight=等比高度铺满 /
// fixedauto=固定宽高比铺满(超出裁切) / full=全屏拉伸铺满）。
import * as THREE from "../core/three.module.min.js";

/** 解析项目设计分辨率配置（宽高均为正才算有效） */
function resolveDesignConfig(cfg) {
  const d = cfg.designResolution;
  return d && typeof d === "object" && d.width > 0 && d.height > 0
    ? {
        width: Math.max(1, Math.round(d.width)),
        height: Math.max(1, Math.round(d.height)),
      }
    : null;
}

/** WebGL 渲染器参数：首选高性能 GPU（WebGL 的 powerPreference 各平台均被浏览器
 * 采纳，含 Windows 双显卡）；preserveDrawingBuffer 仅在清除标志需要跨帧保留
 * 颜色/深度缓冲时开启（默认呈现后缓冲失效，关掉可省一整块画布带宽，
 * 对移动端 tiled GPU 影响尤其明显）。 */
function makeWebGL(cfg, preserveDrawingBuffer) {
  return new THREE.WebGLRenderer({
    antialias: cfg.antiAliasing !== 0,
    powerPreference: "high-performance",
    preserveDrawingBuffer: preserveDrawingBuffer === true,
  });
}

/** 双后端通用渲染器状态（像素比/色调映射/阴影） */
function applyCommon(cfg, renderer) {
  // 设备仿真：URL ?dpr= 覆盖设备像素比（限 1~4），使预览按设备像素密度渲染；
  // 缺省沿用浏览器 devicePixelRatio（上限 2，避免高 DPR 屏幕过度采样）
  const dprParam = new URLSearchParams(location.search).get("dpr");
  const dpr =
    dprParam != null && dprParam !== ""
      ? Math.max(1, Math.min(4, Number(dprParam) || 1))
      : Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = cfg.hdrMode === "hdr" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  // PCF 采样：每灯的 shadow.radius（Shadow 类型 Hard/Soft）只在 PCF 下生效。
  // WebGPU 后端的阴影过滤表同样覆盖 PCF（Basic/PCF/PCFSoft/VSM 四种）
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/**
 * 创建渲染器：按项目设置 `renderer`（webgl 缺省 / webgpu / auto）选择后端。
 * - webgl → three.module.min.js 的 WebGLRenderer；
 * - webgpu / auto → 动态加载 three 的 WebGPU 构建（体积大，仅在选中时进入页面），
 *   构造失败或不可用时回退 WebGLRenderer（与编辑器视口同一策略）。
 *
 * 两套构建共享 three.core.min.js，场景对象（材质/几何/灯光）可互用，故回退
 * 只影响渲染器本身。返回 { renderer, backend }：backend 为 "webgl" | "webgpu"，
 * 供粒子等"后端相关材质"选择实现（TSL / GLSL）与告警。
 */
export async function createRenderer(cfg) {
  const aa = cfg.antiAliasing !== 0;
  const want = typeof cfg.renderer === "string" ? cfg.renderer : "webgl";
  if (want === "webgl") return { renderer: applyCommon(cfg, makeWebGL(cfg, false)), backend: "webgl" };
  try {
    const mod = await import("../core/three.webgpu.min.js");
    const Ctor = mod.WebGPURenderer;
    if (typeof Ctor !== "function") throw new Error("WebGPURenderer not exported");
    const renderer = new Ctor({
      forceWebGL: false,
      antialias: aa,
      samples: aa ? cfg.antiAliasing : 0,
      // powerPreference 仅在 macOS/Linux 被采纳；Windows 上 requestAdapter 忽略
      // 该参数（Chromium crbug.com/369219127，适配器跟随浏览器/系统首选 GPU）。
      // 仍传递以求在支持的平台上生效；Windows 双显卡无页面侧手段，导出产物
      // 只能靠用户的浏览器/系统 GPU 首选项，编辑器自身窗口则由 tauri.conf 的
      // additionalBrowserArgs 在浏览器进程级强制（该级别 Windows 生效）。
      powerPreference: "high-performance",
    });
    // WebGPU 后端为异步初始化：必须先 await init() 再 render()（WebGL 无此要求）
    await renderer.init();
    return { renderer: applyCommon(cfg, renderer), backend: "webgpu" };
  } catch (e) {
    console.warn(`[renderer] WebGPU 不可用（${e?.message ?? e}），已回退 WebGL`);
    return { renderer: applyCommon(cfg, makeWebGL(cfg, false)), backend: "webgl" };
  }
}

/**
 * 重建 WebGL 渲染器并开启跨帧缓冲保留（仅深度/仅颜色清除标志需要；场景数据在
 * 渲染器创建之后才可读，player 在首个渲染前、挂载舞台前调用本函数换出渲染器，
 * 此时 GPU 资源尚未上传，重建零成本）。
 */
export function recreateWebGLRendererPreserveBuffer(cfg, renderer) {
  renderer.dispose();
  return applyCommon(cfg, makeWebGL(cfg, true));
}

/**
 * 创建舞台挂到容器并接管尺寸自适应（窗口/容器变化 → 重设渲染缓冲与 CSS 尺寸）。
 * renderer 由调用方创建（createRenderer；后端无关）；applyProjection(aspect)
 * 由调用方提供（相机模块），随每次尺寸变化同步取景比例。
 * 返回 renderer（canvas = renderer.domElement）。
 */
export function createStage(app, cfg, applyProjection, renderer) {
  const designCfg = resolveDesignConfig(cfg);
  const scaleMode = typeof cfg.scaleMode === "string" && cfg.scaleMode ? cfg.scaleMode : "full";
  app.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  let stageW = -1;
  let stageH = -1;
  // 容器实测尺寸（#app 铺满页面；iframe/窗口变化时自适应）
  function viewSize() {
    const cw = Math.max(1, app.clientWidth || window.innerWidth || 1);
    const ch = Math.max(1, app.clientHeight || window.innerHeight || 1);
    return { cw, ch };
  }
  function resize() {
    const { cw, ch } = viewSize();
    if (!designCfg) {
      // 未配置设计分辨率：直接铺满窗口渲染
      if (stageW !== cw || stageH !== ch) {
        renderer.setSize(cw, ch, false);
        stageW = cw;
        stageH = ch;
      }
      applyProjection(cw / ch);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      return;
    }
    const dw = designCfg.width;
    const dh = designCfg.height;
    // 渲染缓冲 = 设计分辨率（相机取景比例固定为设计比例）
    if (stageW !== dw || stageH !== dh) {
      renderer.setSize(dw, dh, false);
      stageW = dw;
      stageH = dh;
    }
    applyProjection(dw / dh);

    let cssW = dw;
    let cssH = dh;
    if (scaleMode === "noscale") {
      // 不缩放：按设计分辨率原尺寸显示
    } else if (scaleMode === "fixedwidth") {
      // 固定宽度：宽度铺满，高度按设计比例等比
      cssW = cw;
      cssH = (dh * cw) / dw;
    } else if (scaleMode === "fixedheight") {
      // 固定高度：高度铺满，宽度按设计比例等比
      cssW = (dw * ch) / dh;
      cssH = ch;
    } else if (scaleMode === "fixedauto") {
      // 固定宽高比：保持设计比例并占满全屏（超出部分居中裁切）
      const s = Math.max(cw / dw, ch / dh);
      cssW = dw * s;
      cssH = dh * s;
    } else {
      // full（全屏拉伸，默认）及其它未知值：直接拉伸铺满全屏
      cssW = cw;
      cssH = ch;
    }
    canvas.style.width = `${Math.max(1, Math.round(cssW))}px`;
    canvas.style.height = `${Math.max(1, Math.round(cssH))}px`;
  }
  window.addEventListener("resize", resize);
  // 容器尺寸变化（iframe 元素缩放/应用窗口变化）也触发自适应
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(app);
  }
  resize();

  return renderer;
}
