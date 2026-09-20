<script setup lang="ts">
/**
 * 文档窗口壳（全局单例：Tauri 窗口 label "docs"，docs-main.ts 启动）：
 * 顶部标题栏（可拖拽移动/窗口控制）+ 内嵌 public/docs 静态文档站 iframe。
 * 指定文档页双通道：冷启动 take_pending_docs_hash 兜底（随 iframe 首载带上
 * hash，规避加载竞态），热路径监听 tve:docs-open 同源改写 iframe hash（不重载，
 * 文档站 hashchange 完成页内路由）。iframe 加载完成后主动 show() 窗口，
 * 避免空白闪现（与白板/编辑器一致）。浏览器直开 docs.html 时无窗口系统：
 * 跳过 Tauri 调用，仅呈现文档站本身。
 */
import { onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TitleBar from "../ui-kit/components/TitleBar.vue";
import { isTauri } from "../lib/tauri-env";
import { api } from "../lib/api";

const inTauri = isTauri();
const DOCS_URL = "/docs/index.html";
/** 浏览器直开即刻可载；桌面端等 pending hash 取回后再定首载地址（避免竞态） */
const frameSrc = ref(inTauri ? "" : DOCS_URL);
const frameReady = ref(false);
let unlisten: UnlistenFn | null = null;

/** 同源改写 iframe hash：直改 location.hash 触发文档站路由，不整页重载 */
function navigate(hash: string): void {
  const frame = document.querySelector<HTMLIFrameElement>(".docs-frame");
  const target = `#${hash.replace(/^#/, "")}`;
  const win = frame?.contentWindow;
  if (!win || win.location.hash === target) return;
  win.location.hash = target;
}

onMounted(async () => {
  if (!inTauri) return;
  let pending: string | null = null;
  try {
    pending = await api.takePendingDocsHash();
  } catch {
    /* 后端不可用（异常环境）：保持默认首页 */
  }
  frameSrc.value = DOCS_URL + (pending ? `#${pending.replace(/^#/, "")}` : "");
  try {
    unlisten = await listen<string>("tve:docs-open", (e) => navigate(e.payload));
  } catch {
    /* 事件桥不可用：跳转双通道降级为仅冷启动 */
  }
});

onUnmounted(() => unlisten?.());

function onFrameLoad(): void {
  if (frameReady.value) return;
  frameReady.value = true;
  if (inTauri) void getCurrentWindow().show().catch(() => {});
}
</script>

<template>
  <div class="docs-window">
    <TitleBar title="tve 文档" />
    <iframe v-if="frameSrc" class="docs-frame" :src="frameSrc" title="tve 文档" @load="onFrameLoad" />
  </div>
</template>

<style scoped>
.docs-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #141414;
}
.docs-frame {
  flex: 1 1 auto;
  width: 100%;
  border: 0;
}
</style>
