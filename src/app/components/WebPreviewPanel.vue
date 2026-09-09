<script setup lang="ts">
/**
 * 网页预览：
 * - 进入时先保存当前场景 → 从 public/web-preview 读取网页运行产物（three 运行时 +
 *   player），连同 scene.json / project.config.json 一起经 Rust export_web_preview
 *   写入 <项目>/.tmp/web-preview 并启动本地静态服务；
 * - 中央区域用 iframe 嵌入预览页，独立网页运行时渲染场景（与编辑器画布无关）；
 * - 支持「刷新（重新导出并重载）」「在浏览器打开」「停止预览」。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import { api } from "../../lib/api";
import { saveCurrentSceneToMain } from "../lib/save-scene";
import {
  fetchWebPreviewRuntimeTexts,
  configUsesPhysics,
  configPhysicsBackend,
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

const previewUrl = computed(() =>
  baseUrl.value ? `${baseUrl.value}/index.html` : "",
);

/** 组装导出文件：WebView 打包的网页运行时 + 项目配置 + 用户脚本编译产物（文本）。
 *  scene.json 与场景引用的 .mat 材质、材质引用的贴图二进制由 Rust 直接从磁盘
 *  读取写入导出目录（export_web_preview_from_scene），不再以 base64 过 IPC。 */
async function buildExportFiles(): Promise<Record<string, string>> {
  const root = projectStore.currentPath;
  if (!root) throw new Error("尚未打开项目，无法预览");
  // 项目配置：物理启用状态（磁盘上的 config）决定引擎运行时是否随导出（按需打包）
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
});

onUnmounted(() => {
  runSeq++; // 使进行中的导出/同步失效
  window.removeEventListener("message", onPreviewLog);
  // 离开预览页签即释放端口（再次进入会重新导出并启动）
  void api.stopWebPreview().catch(() => {
    /* ignore */
  });
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

    <div class="wp-body">
      <iframe
        v-if="phase === 'ok'"
        :key="frameKey"
        :src="previewUrl"
        class="wp-frame"
        allow="fullscreen; autoplay"
        title="网页预览"
      ></iframe>
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
