// 渲染器与舞台适配：“显示与运行”——预览画布按项目设计分辨率取景/渲染，
// 再按缩放模式适配 iframe 显示（noscale=原尺寸 / fixedwidth=等比宽度铺满 /
// fixedheight=等比高度铺满 / fixedauto=固定宽高比铺满(超出裁切) / full=全屏拉伸铺满）。
import * as THREE from "./three.module.min.js";

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

/**
 * 创建 WebGLRenderer 挂到容器并接管尺寸自适应（窗口/容器变化 → 重设渲染缓冲与 CSS 尺寸）。
 * applyProjection(aspect) 由调用方提供（相机模块），随每次尺寸变化同步取景比例。
 * 返回 renderer（canvas = renderer.domElement）。
 */
export function createStage(app, cfg, applyProjection) {
  const designCfg = resolveDesignConfig(cfg);
  const scaleMode = typeof cfg.scaleMode === "string" && cfg.scaleMode ? cfg.scaleMode : "full";
  const renderer = new THREE.WebGLRenderer({
    antialias: cfg.antiAliasing !== 0,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping =
    cfg.hdrMode === "hdr" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
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
