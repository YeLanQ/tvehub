<script setup lang="ts">
/**
 * 中央·预览视图：与编辑器 WebPreviewPanel 同一导出链路的轻量版 ——
 * 场景先落盘（共享会话 sceneApi.save）→ 组装网页运行时 + 项目配置 + 用户脚本
 * 编译产物 → exportWebPreviewFromScene（scene.json/材质/贴图由后端直读磁盘）
 * → 本地静态服务 + iframe。无设备仿真（编辑器内已有完整版）。
 */
import { computed, onMounted, ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../lib/api";
import { sceneApi } from "../../lib/scene-api";
import { getGraphWindowStore } from "../graphStore";
import {
  configPhysicsBackend,
  configUsesDracoCompression,
  configUsesPhysics,
  configUsesTextureCompression,
  configUsesWebgpu,
  fetchWebPreviewRuntimeTexts,
} from "../../app/lib/web-preview-runtime";
import {
  compileProjectScripts,
  ensureEntryScript,
  loadProjectScripts,
} from "../../app/lib/script-compile";

const store = getGraphWindowStore();

const phase = ref<"idle" | "starting" | "ok" | "error">("idle");
const baseUrl = ref("");
const frameKey = ref(0);
const errorText = ref("");
const hint = ref("正在导出并启动预览…");
const refreshing = ref(false);
let runSeq = 0;

const previewUrl = computed(() => (baseUrl.value ? `${baseUrl.value}/index.html` : ""));

/** 组装导出文件：网页运行时 + 项目配置（注入场景图标记）+ 用户脚本编译产物 */
async function buildExportFiles(): Promise<Record<string, string>> {
  const root = store.root;
  if (!root) throw new Error("尚未打开项目");
  let configText = "{}";
  try {
    configText = await api.readText(root, "project.config.json");
  } catch {
    /* 无配置按未启用处理 */
  }
  const files = await fetchWebPreviewRuntimeTexts({
    includePhysics: configUsesPhysics(configText),
    physicsBackend: configPhysicsBackend(configText) ?? undefined,
    includeWebgpu: configUsesWebgpu(configText),
    includeDracoDecoder: configUsesDracoCompression(configText),
    includeBasisDecoder: configUsesTextureCompression(configText),
  });
  // 场景图注入：图会话文档 + config 标记（player 检测到即装配行为解释器）
  const graphDoc = store.canvas?.serializeDoc();
  if (graphDoc) {
    files["script-graph.json"] = JSON.stringify(graphDoc);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(configText) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    cfg.scriptGraph = "./script-graph.json";
    configText = JSON.stringify(cfg, null, 2);
  }
  files["config.json"] = configText;
  // 用户脚本：按磁盘内容全量编译（图窗口无工作台脏状态，磁盘即真相）
  try {
    await ensureEntryScript(root);
    const scripts = await loadProjectScripts(root);
    if (scripts.length) {
      const { files: jsFiles } = await compileProjectScripts(scripts);
      Object.assign(files, jsFiles);
    }
  } catch {
    /* 编译失败不阻断导出（运行时按无脚本运行） */
  }
  return files;
}

/** 导出并启动（首次进入/重试） */
async function start(): Promise<void> {
  if (phase.value === "starting") return;
  const root = store.root;
  if (!root) {
    errorText.value = "尚未打开项目";
    phase.value = "error";
    return;
  }
  const seq = ++runSeq;
  phase.value = "starting";
  errorText.value = "";
  hint.value = "正在导出并启动预览…";
  try {
    // 场景会话（可能继承自编辑器）先落盘：后端导出按磁盘内容读取
    try {
      await sceneApi.save();
    } catch {
      /* 无会话/未改动时按磁盘内容导出 */
    }
    const files = await buildExportFiles();
    await api.exportWebPreviewFromScene(root, store.sceneRel, files);
    if (seq !== runSeq) return;
    const url = await api.startWebPreviewServer(root);
    if (seq !== runSeq) return;
    baseUrl.value = url;
    phase.value = "ok";
  } catch (e) {
    if (seq !== runSeq) return;
    phase.value = "error";
    errorText.value = String(e);
  }
}

/** 重新导出并刷新 iframe（服务器保持运行，按需读盘） */
async function refresh(): Promise<void> {
  if (refreshing.value || phase.value !== "ok") return;
  const root = store.root;
  if (!root) return;
  const seq = ++runSeq;
  refreshing.value = true;
  try {
    try {
      await sceneApi.save();
    } catch {
      /* 按磁盘内容导出 */
    }
    const files = await buildExportFiles();
    await api.exportWebPreviewFromScene(root, store.sceneRel, files);
    if (seq !== runSeq) return;
    frameKey.value++;
  } catch (e) {
    if (seq === runSeq) errorText.value = String(e);
  } finally {
    if (seq === runSeq) refreshing.value = false;
  }
}

async function openInBrowser(): Promise<void> {
  if (!previewUrl.value) return;
  try {
    await openUrl(previewUrl.value);
  } catch {
    /* 打开失败静默 */
  }
}

onMounted(() => {
  void start();
});
</script>

<template>
  <div class="gpreview">
    <div class="gpreview-bar">
      <button :disabled="phase !== 'ok' || refreshing" @click="refresh()">
        {{ refreshing ? "同步中…" : "刷新" }}
      </button>
      <button :disabled="phase === 'starting'" @click="start()">重新导出</button>
      <button :disabled="!previewUrl" @click="openInBrowser()">浏览器打开</button>
      <span class="gpreview-scene">{{ store.sceneRel }}</span>
    </div>
    <div class="gpreview-body">
      <iframe v-if="phase === 'ok'" :key="frameKey" :src="previewUrl" title="场景图预览" />
      <div v-else-if="phase === 'error'" class="gpreview-error">预览失败：{{ errorText }}</div>
      <div v-else class="gpreview-loading">{{ hint }}</div>
    </div>
  </div>
</template>
