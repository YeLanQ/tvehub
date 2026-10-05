// 渲染器创建与舞台适配（Runtime 层的设备/舞台组合根）："显示与运行"——
// 渲染设备经 RHI 创建（src/engine/rhi，three 后端按项目设置解析 webgl /
// webgpu / auto，WebGPU 不可用自动回退），渲染管线经 RPI 组装；舞台始终按
// 窗口尺寸渲染并铺满（场景不受缩放模式影响）；缩放模式（scaleMode）仅由
// UI 系统消费，用于 UI 画布在相机空间的适配策略。
import { createRHIDevice } from "../../engine/rhi";
import type { RHIDevice, RHIDeviceOptions, RHIActiveBackend } from "../../engine/rhi";
import { registerThreeRHIBackends } from "../../engine/rhi/backends/three";
import { createRPIPipeline } from "../../engine/rpi";
import type { RPIPipeline } from "../../engine/rpi";

/** 运行时舞台配置（项目设置 renderer 子集；JSON 来源） */
interface StageConfig {
  renderer?: unknown;
  antiAliasing?: unknown;
  hdrMode?: unknown;
  performance?: { powerPreference?: unknown } | null;
  [key: string]: unknown;
}

/** GPU 偏好（功耗）：performance.powerPreference 可配 "high-performance" / "low-power"，
 *  缺省 "default"（浏览器均衡选择，双显卡笔记本不再强制独显——原 high-performance
 *  会使混合 GPU 设备整页功耗数倍提升、持续发热）。 */
function powerPref(cfg: StageConfig): "high-performance" | "low-power" | "default" {
  const v = cfg && cfg.performance && cfg.performance.powerPreference;
  return v === "high-performance" || v === "low-power" ? v : "default";
}

/** 设备创建参数：preserveDrawingBuffer 仅在清除标志需要跨帧保留
 *  颜色/深度缓冲时开启（默认呈现后缓冲失效，关掉可省一整块画布带宽，
 *  对移动端 tiled GPU 影响尤其明显）。 */
function deviceOptions(cfg: StageConfig, preserveDrawingBuffer: boolean): RHIDeviceOptions {
  const aa = cfg.antiAliasing !== 0;
  const samples = typeof cfg.antiAliasing === "number" ? cfg.antiAliasing : 0;
  return {
    antialias: aa,
    msaaSamples: aa ? samples : 0,
    // powerPreference 仅在 macOS/Linux 被采纳；Windows 上 requestAdapter 忽略
    // 该参数（Chromium crbug.com/369219127，适配器跟随浏览器/系统首选 GPU）。
    // 仍传递以求在支持的平台上生效；Windows 双显卡无页面侧手段，导出产物
    // 只能靠用户的浏览器/系统 GPU 首选项，编辑器自身窗口则由 tauri.conf 的
    // additionalBrowserArgs 在浏览器进程级强制（该级别 Windows 生效）。
    powerPreference: powerPref(cfg),
    preserveDrawingBuffer,
  };
}

/** 双后端通用显示配置（像素比/色调映射/阴影） */
function applyCommon(cfg: StageConfig, device: RHIDevice): RHIDevice {
  // 设备仿真：URL ?dpr= 覆盖设备像素比（限 1~4），使预览按设备像素密度渲染；
  // 缺省沿用浏览器 devicePixelRatio（上限 2，避免高 DPR 屏幕过度采样）
  const dprParam = new URLSearchParams(location.search).get("dpr");
  const dpr =
    dprParam != null && dprParam !== ""
      ? Math.max(1, Math.min(4, Number(dprParam) || 1))
      : Math.min(window.devicePixelRatio || 1, 2);
  device.configureDisplay({
    pixelRatio: dpr,
    // HDR 用 ACES 电影级色调映射，LDR 常规输出（不映射）
    toneMapping: cfg.hdrMode === "hdr" ? "aces-filmic" : "none",
    shadowMapEnabled: true,
    // PCF 采样：每灯的 shadow.radius（Shadow 类型 Hard/Soft）只在 PCF 下生效。
    // WebGPU 后端的阴影过滤表同样覆盖 PCF（Basic/PCF/PCFSoft/VSM 四种）
    shadowFilter: "pcf",
  });
  return device;
}

/**
 * 创建渲染设备与管线：按项目设置 `renderer`（webgl 缺省 / webgpu / auto）
 * 经 RHI registry 选择后端（构造失败或不可用时回退 WebGL，与编辑器视口同
 * 一策略）。两套 three 构建共享 three.core，场景对象（材质/几何/灯光）可
 * 互用，故回退只影响设备本身。
 * 返回 { renderer, pipeline, backend }：renderer 为 RHI 设备（场景回放代码
 * 经它渲染/预热/统计），pipeline 为 RPI 管线（主渲染/清除/分层多 pass）；
 * backend 为 "webgl" | "webgpu"，供粒子等"后端相关材质"选择实现与告警。
 */
export async function createRenderer(cfg: StageConfig): Promise<{
  renderer: RHIDevice;
  pipeline: RPIPipeline;
  backend: RHIActiveBackend;
}> {
  const want = typeof cfg.renderer === "string" ? cfg.renderer : "webgl";
  registerThreeRHIBackends();
  const device = await createRHIDevice(want as Parameters<typeof createRHIDevice>[0], deviceOptions(cfg, false));
  const pipeline = createRPIPipeline(device);
  applyCommon(cfg, device);
  return { renderer: device, pipeline, backend: device.kind };
}

/**
 * 重建 WebGL 渲染设备并开启跨帧缓冲保留（仅深度/仅颜色清除标志需要；场景
 * 数据在设备创建之后才可读，player 在首个渲染前、挂载舞台前调用本函数换出
 * 设备，此时 GPU 资源尚未上传，重建零成本）。管线随新设备重建返回。
 */
export async function recreateWebGLRendererPreserveBuffer(
  cfg: StageConfig,
  renderer: RHIDevice,
): Promise<{ renderer: RHIDevice; pipeline: RPIPipeline }> {
  renderer.dispose();
  const device = await createRHIDevice("webgl", deviceOptions(cfg, true));
  applyCommon(cfg, device);
  return { renderer: device, pipeline: createRPIPipeline(device) };
}

/**
 * 创建舞台挂到容器并接管尺寸自适应（窗口/容器变化 → 重设渲染缓冲）。
 * 场景始终按容器实测尺寸渲染并 CSS 铺满；缩放模式不参与舞台适配（仅 UI
 * 系统消费）。renderer 为 RHI 设备（createRenderer 产出；后端无关）；
 * applyProjection(aspect) 由调用方提供（相机模块），随每次尺寸变化同步
 * 取景比例。返回 renderer（canvas = renderer.domElement）。
 */
export function createStage(
  app: HTMLElement,
  _cfg: StageConfig,
  applyProjection: (aspect: number) => void,
  renderer: RHIDevice,
): RHIDevice {
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
    // 场景始终按窗口尺寸渲染并铺满（缩放模式仅影响 UI 画布适配，不影响场景）
    if (stageW !== cw || stageH !== ch) {
      renderer.setSize(cw, ch, false);
      stageW = cw;
      stageH = ch;
    }
    applyProjection(cw / ch);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
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
