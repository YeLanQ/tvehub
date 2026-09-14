<script setup lang="ts">
/**
 * 网页预览：
 * - 进入时先保存当前场景 → 从 public/web-preview 读取网页运行产物（three 运行时 +
 *   player），连同 scene.json / project.config.json 一起经 Rust export_web_preview
 *   写入 <项目>/.tmp/web-preview 并启动本地静态服务；
 * - 中央区域用 iframe 嵌入预览页，独立网页运行时渲染场景（与编辑器画布无关）；
 * - 支持「刷新（重新导出并重载）」「在浏览器打开」「停止预览」；
 * - 设备仿真（参考 LQEN）：以设备逻辑分辨率渲染预览，套设备框架并等比缩放适配视口；
 *   DPR 经 ?dpr= 查询参数传给 player，由 stage.mjs 调 setPixelRatio 真实生效。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import Slider from "../../ui-kit/components/Slider.vue";
import { logStore } from "../stores/log";
import { api } from "../../lib/api";
import { saveCurrentSceneToMain } from "../lib/save-scene";
import {
  fetchWebPreviewRuntimeTexts,
  configUsesPhysics,
  configPhysicsBackend,
  configUsesWebgpu,
  configUsesDracoCompression,
  configUsesTextureCompression,
} from "../lib/web-preview-runtime";
import { ensureEntryScript } from "../lib/script-compile";
import { loadProjectScripts, compileProjectScripts } from "../lib/script-compile";
import "../../styles/components/web-preview.scss";
const emit = defineEmits<{ close: [] }>();
const projectStore = getProjectStore();

const phase = ref<"idle" | "starting" | "ok" | "error">("idle");
const baseUrl = ref("");
const frameKey = ref(0);
const errorText = ref("");
const refreshing = ref(false);
const hint = ref("正在导出并启动网页预览…");
/** 代际标记：stop/离开页签会使进行中的导出失效，避免停止后又被异步回调重新拉起 */
let runSeq = 0;

// ---------------------------------------------------------------------------
// 设备仿真（参考 LQEN）：以设备逻辑分辨率（CSS 像素）渲染预览，套设备框架并等比
// 缩放适配视口；DPR 经 ?dpr= 查询参数传给 player，由 stage.mjs 调 setPixelRatio 生效。
// ---------------------------------------------------------------------------
const DEVICE_PRESETS = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, dpr: 2 },
  { id: "iphone-14", label: "iPhone 14", width: 390, height: 844, dpr: 3 },
  { id: "iphone-15pro", label: "iPhone 15 Pro", width: 393, height: 852, dpr: 3 },
  { id: "android-360", label: "安卓 360×800", width: 360, height: 800, dpr: 2.75 },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915, dpr: 2.625 },
  { id: "ipad", label: "iPad 10.2″", width: 768, height: 1024, dpr: 2 },
  { id: "ipad-pro11", label: "iPad Pro 11″", width: 834, height: 1194, dpr: 2 },
] as const;

type DeviceId = "auto" | (typeof DEVICE_PRESETS)[number]["id"] | "custom";

const DEVICE_KEY = "tve:web-preview-device:";

interface DeviceSettings {
  id: DeviceId;
  orientation: "portrait" | "landscape";
  customW: number;
  customH: number;
  /** 自定义设备 DPR（1~4）：画面按 逻辑尺寸 × dpr 渲染 */
  customDpr: number;
  /** 手动缩放比例（%）：相对自动适配的缩放系数，100 = 完整自动适配 */
  zoomPct: number;
}

function loadDeviceSettings(): DeviceSettings {
  const def: DeviceSettings = {
    id: "auto",
    orientation: "portrait",
    customW: 390,
    customH: 844,
    customDpr: 1,
    zoomPct: 100,
  };
  const root = projectStore.currentPath;
  if (!root) return def;
  try {
    const raw = localStorage.getItem(DEVICE_KEY + root);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DeviceSettings>;
      return {
        id:
          p.id === "custom" || DEVICE_PRESETS.some((d) => d.id === p.id)
            ? (p.id as DeviceId)
            : def.id,
        orientation: p.orientation === "landscape" ? "landscape" : "portrait",
        customW:
          typeof p.customW === "number" && p.customW > 0
            ? Math.round(p.customW)
            : def.customW,
        customH:
          typeof p.customH === "number" && p.customH > 0
            ? Math.round(p.customH)
            : def.customH,
        customDpr:
          typeof p.customDpr === "number" && p.customDpr >= 1 && p.customDpr <= 4
            ? p.customDpr
            : def.customDpr,
        zoomPct:
          typeof p.zoomPct === "number" && p.zoomPct >= 25 && p.zoomPct <= 200
            ? Math.round(p.zoomPct)
            : def.zoomPct,
      };
    }
  } catch {
    /* ignore */
  }
  return def;
}

function saveDeviceSettings(): void {
  const root = projectStore.currentPath;
  if (!root) return;
  try {
    localStorage.setItem(
      DEVICE_KEY + root,
      JSON.stringify({
        id: deviceId.value,
        orientation: orientation.value,
        customW: customW.value,
        customH: customH.value,
        customDpr: customDpr.value,
        zoomPct: deviceZoomPct.value,
      }),
    );
  } catch {
    /* ignore */
  }
}

const deviceSettings = loadDeviceSettings();
const deviceId = ref<DeviceId>(deviceSettings.id);
const orientation = ref<"portrait" | "landscape">(deviceSettings.orientation);
const customW = ref(deviceSettings.customW);
const customH = ref(deviceSettings.customH);
/** 自定义设备 DPR（1~4） */
const customDpr = ref(deviceSettings.customDpr);
/** 手动缩放比例（%）：25~200，100 = 自动适配 */
const deviceZoomPct = ref(deviceSettings.zoomPct);

watch(
  [deviceId, orientation, customW, customH, customDpr, deviceZoomPct],
  saveDeviceSettings,
);

/** 是否启用设备框架（auto = 自适应填满视口） */
const deviceActive = computed(() => deviceId.value !== "auto");
const devicePreset = computed(
  () => DEVICE_PRESETS.find((d) => d.id === deviceId.value) ?? null,
);
/** 当前设备的逻辑分辨率（横屏时交换宽高） */
const devW = computed(() => {
  if (deviceId.value === "custom") return Math.max(1, customW.value || 1);
  const p = devicePreset.value;
  if (!p) return 1;
  return orientation.value === "landscape" ? p.height : p.width;
});
const devH = computed(() => {
  if (deviceId.value === "custom") return Math.max(1, customH.value || 1);
  const p = devicePreset.value;
  if (!p) return 1;
  return orientation.value === "landscape" ? p.width : p.height;
});
/** 当前设备 DPR（自定义用 customDpr；预置用标称 DPR），经 ?dpr= 参数生效 */
const deviceDpr = computed(() =>
  deviceId.value === "custom"
    ? Math.max(1, Math.min(4, customDpr.value || 1))
    : devicePreset.value?.dpr ?? 1,
);
/** 预置设备可切换横竖屏（自定义尺寸直接改宽高） */
const canRotate = computed(
  () => deviceActive.value && deviceId.value !== "custom",
);
function toggleOrientation(): void {
  orientation.value = orientation.value === "portrait" ? "landscape" : "portrait";
}

/** 预览容器可用尺寸（ResizeObserver 跟踪），驱动设备框架等比缩放 */
const bodyRef = ref<HTMLElement | null>(null);
const avail = ref({ w: 1, h: 1 });
let resizeObs: ResizeObserver | null = null;

/** 设备框架实际缩放：自动适配（contain）× 手动比例（25%~200%），限制 5%~300% */
const scale = computed(() => {
  if (!deviceActive.value) return 1;
  const fit = Math.min(avail.value.w / devW.value, avail.value.h / devH.value);
  const s = fit * (deviceZoomPct.value / 100);
  return Math.max(0.05, Math.min(3, s || 1));
});

const frameStyle = computed(() => ({
  width: `${devW.value}px`,
  height: `${devH.value}px`,
  transform: `scale(${scale.value})`,
}));

/** 完整预览 URL（base + 路径；设备仿真时附加 dpr 使画面达到设备像素密度） */
const previewUrl = computed(() => {
  if (!baseUrl.value) return "";
  const base = `${baseUrl.value}/index.html`;
  if (deviceActive.value && deviceDpr.value > 1) {
    return `${base}?dpr=${encodeURIComponent(String(deviceDpr.value))}`;
  }
  return base;
});

/** 组装导出文件：WebView 打包的网页运行时 + 项目配置 + 用户脚本编译产物（文本）。
 *  scene.json 与场景引用的 .mat 材质、材质引用的贴图二进制由 Rust 直接从磁盘
 *  读取写入导出目录（export_web_preview_from_scene），不再以 base64 过 IPC。 */
async function buildExportFiles(): Promise<Record<string, string>> {
  const root = projectStore.currentPath;
  if (!root) throw new Error("尚未打开项目，无法预览");
  // 项目配置：物理启用状态与渲染后端（磁盘上的 config）决定体积大的可选运行时
  // 是否随产物（按需打包）
  let configText = "{}";
  try {
    configText = await api.readText(root, "project.config.json");
  } catch {
    /* 无配置按未启用处理 */
  }
  const includePhysics = configUsesPhysics(configText);
  const files = await fetchWebPreviewRuntimeTexts({
    includePhysics,
    physicsBackend: configPhysicsBackend(configText) ?? undefined,
    includeWebgpu: configUsesWebgpu(configText),
    includeDracoDecoder: configUsesDracoCompression(configText),
    includeBasisDecoder: configUsesTextureCompression(configText),
  });
  files["config.json"] = configText;
  // 用户脚本：全量编译（src/**.ts → src/**.js）随导出注入；单个失败跳过并告警
  try {
    await ensureEntryScript(root);
    const scripts = await loadProjectScripts(root);
    if (scripts.length) {
      const { files: jsFiles, errors } = await compileProjectScripts(scripts);
      Object.assign(files, jsFiles);
      for (const [rel, err] of Object.entries(errors)) {
        logStore.log("error", `脚本编译失败 ${rel}: ${err}（该脚本不参与预览）`, "preview");
      }
    }
  } catch (e) {
    logStore.log("warn", `脚本编译跳过: ${e}`, "preview");
  }
  return files;
}

/** 导出并启动（首次进入 / 重试） */
async function start(): Promise<void> {
  if (phase.value === "starting") return;
  const root = projectStore.currentPath;
  if (!root) {
    errorText.value = "尚未打开项目";
    return;
  }
  const seq = ++runSeq;
  phase.value = "starting";
  errorText.value = "";
  hint.value = "正在导出并启动网页预览…";
  try {
    // 预览内容与编辑器一致：导出前把当前编辑场景落盘（后端导出按磁盘内容读取）
    try {
      await saveCurrentSceneToMain();
    } catch (e) {
      logStore.log("warn", `预览前保存场景失败（按磁盘内容导出）: ${e}`, "preview");
    }
    // 脚本同理：编辑中的脏脚本先落盘（编译按磁盘内容读取）
    await getScriptsStore().saveAll();
    const files = await buildExportFiles();
    await api.exportWebPreviewFromScene(root, projectStore.sceneRel || "assets/Main.scene", files);
    if (seq !== runSeq) return; // 期间被 stop/离开页签终止
    // 导出成功后再单独启动服务器（两步分离避免竞态拉起）
    const url = await api.startWebPreviewServer(root);
    if (seq !== runSeq) return;
    baseUrl.value = url;
    phase.value = "ok";
    logStore.log("success", `网页预览已启动: ${url}/index.html`, "preview");
  } catch (e) {
    if (seq !== runSeq) return;
    phase.value = "error";
    errorText.value = String(e);
    logStore.log("error", `网页预览启动失败: ${e}`, "preview");
  }
}

/** 重新导出当前编辑内容并刷新 iframe（服务器按需读盘，无需重启端口） */
async function refresh(): Promise<void> {
  if (refreshing.value || phase.value !== "ok") return;
  const root = projectStore.currentPath;
  if (!root) return;
  const seq = ++runSeq;
  refreshing.value = true;
  try {
    try {
      await saveCurrentSceneToMain();
    } catch (e) {
      logStore.log("warn", `预览前保存场景失败（按磁盘内容导出）: ${e}`, "preview");
    }
    // 脚本同理：编辑中的脏脚本先落盘（编译按磁盘内容读取）
    await getScriptsStore().saveAll();
    const files = await buildExportFiles();
    await api.exportWebPreviewFromScene(root, projectStore.sceneRel || "assets/Main.scene", files);
    if (seq !== runSeq) return; // 期间被 stop/离开页签终止
    // 服务器保持运行、按需读盘；重新导出完成后重载 iframe 即看到最新内容
    frameKey.value++;
    logStore.log("info", "网页预览已同步当前编辑内容并刷新", "preview");
  } catch (e) {
    if (seq === runSeq) logStore.log("error", `网页预览同步失败: ${e}`, "preview");
  } finally {
    if (seq === runSeq) refreshing.value = false;
  }
}

/** 在默认浏览器中打开当前预览 */
async function openInBrowser(): Promise<void> {
  if (!previewUrl.value) return;
  try {
    await openUrl(previewUrl.value);
    logStore.log("info", `已在浏览器打开网页预览: ${previewUrl.value}`, "preview");
  } catch (e) {
    logStore.log("error", `打开浏览器失败: ${e}`, "preview");
  }
}

/** 停止预览服务（释放端口）；并使进行中的导出/同步失效 */
async function stopPreview(): Promise<void> {
  runSeq++;
  try {
    await api.stopWebPreview();
    phase.value = "idle";
    baseUrl.value = "";
    logStore.log("info", "网页预览服务已停止", "preview");
  } catch (e) {
    logStore.log("error", `停止网页预览失败: ${e}`, "preview");
  }
}

function close(): void {
  emit("close");
}

/** 预览页 console/错误 → 编辑器控制台（player.mjs 经 postMessage 转发） */
function onPreviewLog(e: MessageEvent): void {
  const d = e.data as { __editorPreviewLog?: boolean; level?: string; text?: string } | null;
  if (!d || d.__editorPreviewLog !== true) return;
  const level = d.level === "warn" || d.level === "error" ? d.level : "info";
  logStore.log(level, `[预览] ${d.text ?? ""}`, "preview");
}

onMounted(() => {
  void start();
  window.addEventListener("message", onPreviewLog);
  resizeObs = new ResizeObserver(() => {
    const el = bodyRef.value;
    if (el)
      avail.value = {
        w: Math.max(1, el.clientWidth || 1),
        h: Math.max(1, el.clientHeight || 1),
      };
  });
  if (bodyRef.value) resizeObs.observe(bodyRef.value);
});

onUnmounted(() => {
  runSeq++; // 使进行中的导出/同步失效
  window.removeEventListener("message", onPreviewLog);
  resizeObs?.disconnect();
  resizeObs = null;
  // 不随页签关闭而停服务：固定端口（39110）正是「在外部浏览器里打开预览」的入口，
  // 停服会让常驻的浏览器标签页在加载中途成片中断（net::ERR_CONNECTION_ABORTED）。
  // 再次进入页签会重新导出并复用既有服务（后端按目录热切换，不重建监听）。
  // 需要释放端口时用工具条的「停止预览服务」（preview.stop）。
});
</script>

<template>
  <div class="web-preview">
    <div class="wp-head">
      <span class="wp-title">网页预览</span>
      <input
        class="wp-url mono"
        readonly
        :value="previewUrl"
        :title="previewUrl"
        placeholder="预览 URL"
      />
      <span class="spacer"></span>
      <button
        class="wp-btn"
        :disabled="phase !== 'ok' || refreshing"
        title="重新导出当前场景并刷新预览"
        @click="refresh"
      >
        {{ refreshing ? "同步中…" : "刷新" }}
      </button>
      <button
        class="wp-btn"
        :disabled="phase !== 'ok'"
        title="在默认浏览器中打开当前预览"
        @click="openInBrowser"
      >
        在浏览器打开
      </button>
      <button
        class="wp-btn"
        :disabled="phase === 'idle'"
        title="停止网页预览服务（释放端口）"
        @click="stopPreview"
      >
        停止预览
      </button>
      <button class="wp-btn wp-close" title="关闭预览，返回场景编辑" @click="close">✕</button>
    </div>

    <!-- 设备仿真条 -->
    <div class="wp-device-bar">
      <span class="wpd-label">设备仿真</span>
      <select
        v-model="deviceId"
        class="wpd-device"
        title="以设备逻辑分辨率渲染预览；自适应 = 填满视口"
      >
        <option value="auto">自适应（无框架）</option>
        <option v-for="d in DEVICE_PRESETS" :key="d.id" :value="d.id">
          {{ d.label }} ({{ d.width }}×{{ d.height }})
        </option>
        <option value="custom">自定义…</option>
      </select>
      <button
        v-if="canRotate"
        class="wp-btn wpd-orient"
        :title="`切换横竖屏（当前${orientation === 'portrait' ? '竖屏' : '横屏'}）`"
        @click="toggleOrientation"
      >
        {{ orientation === "portrait" ? "竖屏" : "横屏" }}
      </button>
      <template v-if="deviceId === 'custom'">
        <input
          v-model.number="customW"
          class="wpd-size-input"
          type="number"
          min="1"
          title="自定义宽度（逻辑像素）"
        />
        <span class="wpd-x">×</span>
        <input
          v-model.number="customH"
          class="wpd-size-input"
          type="number"
          min="1"
          title="自定义高度（逻辑像素）"
        />
        <span class="wpd-x">@</span>
        <input
          v-model.number="customDpr"
          class="wpd-dpr-input"
          type="number"
          min="1"
          max="4"
          step="0.25"
          title="自定义 DPR（画面按 逻辑尺寸 × DPR 渲染，1=桌面 1x，3≈手机 3x）"
        />
        <span class="wpd-x">x</span>
      </template>
      <span v-if="deviceActive" class="wpd-zoom">
        <span class="wpd-zoom-label">缩放</span>
        <Slider
          v-model="deviceZoomPct"
          :min="25"
          :max="200"
          :step="5"
          title="手动缩放比例（相对自动适配，100% = 完整适配视口）"
        />
        <button class="wp-btn wpd-fit" title="恢复自动适配（100%）" @click="deviceZoomPct = 100">
          适应
        </button>
      </span>
      <span v-if="deviceActive" class="wpd-info">
        {{ devW }}×{{ devH }} · {{ deviceDpr }}x · 缩放 {{ Math.round(scale * 100) }}%
      </span>
    </div>

    <!-- 预览内容（设备仿真时套设备框架并等比缩放，iframe 不重建避免重载） -->
    <div ref="bodyRef" class="wp-body">
      <template v-if="phase === 'ok'">
        <div class="wp-device-stage" :class="{ auto: !deviceActive }">
          <div
            class="wp-device-frame"
            :class="{ auto: !deviceActive }"
            :style="deviceActive ? frameStyle : null"
          >
            <iframe
              :key="frameKey"
              :src="previewUrl"
              class="wp-frame"
              allow="fullscreen; autoplay"
              title="网页预览"
            ></iframe>
          </div>
        </div>
      </template>
      <div v-else-if="phase === 'starting'" class="wp-hint mono">{{ hint }}</div>
      <div v-else-if="phase === 'error'" class="wp-error">
        <strong>预览启动失败</strong>
        <pre class="mono">{{ errorText }}</pre>
        <button @click="start">重试</button>
      </div>
      <div v-else class="wp-hint mono">
        <div class="wp-idle">
          网页预览未启动
          <button class="wp-btn" @click="start">启动预览</button>
        </div>
      </div>
    </div>
  </div>
</template>
