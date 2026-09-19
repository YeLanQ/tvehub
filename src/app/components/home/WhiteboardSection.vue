<script setup lang="ts">
/**
 * 首页「白板」分区：全局白板文件画廊（不绑定项目，文档为 .svg，落全局白板
 * 目录）。点击卡片 → 打开全局单例白板窗口（label "whiteboard"）并加载该文件；
 * 「新建白板」仅打开/聚焦窗口（不覆盖窗口中进行中的内容）。白板窗口保存后
 * 广播 tve:whiteboard-saved，本分区监听刷新画廊。
 */
import { onMounted, onUnmounted, ref } from "vue";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../../lib/api";
import { isTauri } from "../../../lib/tauri-env";
import "../../../styles/components/whiteboard-section.scss";

const files = ref<string[]>([]);
const previews = ref<Record<string, string>>({});
const loading = ref(false);
const errorText = ref("");
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let unlistenSaved: UnlistenFn | null = null;

function showNotice(text: string): void {
  notice.value = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}

/** 列出全局白板文件并生成 data URL 预览（白板文档是 .svg 文本，直读内联） */
async function refresh(): Promise<void> {
  if (!isTauri()) return;
  loading.value = true;
  errorText.value = "";
  try {
    const names = await api.whiteboardListFiles();
    files.value = names;
    const next: Record<string, string> = {};
    await Promise.all(
      names.map(async (name) => {
        try {
          const text = await api.whiteboardRead(name);
          next[name] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
        } catch {
          /* 单个文件读取失败不阻塞其余预览 */
        }
      }),
    );
    previews.value = next;
  } catch (e) {
    errorText.value = String(e);
    files.value = [];
    previews.value = {};
  } finally {
    loading.value = false;
  }
}

/** 打开白板窗口（单例）：name 非空 = 打开指定文件；null = 新建/聚焦 */
async function openWhiteboard(name: string | null): Promise<void> {
  if (!isTauri()) {
    showNotice("白板窗口需在桌面端使用（浏览器预览无窗口系统）");
    return;
  }
  try {
    await api.showWhiteboardWindow(name);
    // 窗口已存在时热直达（冷启动时事件丢失，由 take_pending_whiteboard_file 兜底）
    if (name) void emit("tve:whiteboard-open", { name }).catch(() => {});
  } catch (e) {
    showNotice(`打开白板失败: ${e}`);
  }
}

onMounted(async () => {
  void refresh();
  try {
    unlistenSaved = await listen<{ name: string }>("tve:whiteboard-saved", () => {
      void refresh();
    });
  } catch {
    /* 浏览器开发环境忽略 */
  }
});

onUnmounted(() => {
  unlistenSaved?.();
  unlistenSaved = null;
  if (noticeTimer) clearTimeout(noticeTimer);
});
</script>

<template>
  <section class="page wb-page">
    <div class="page-head">
      <div>
        <h2>白板</h2>
        <p class="sub">创意白板；让想法不用在不同工具间切换。默认通过.svg保存</p>
      </div>
      <div class="head-actions">
        <button :disabled="loading || !isTauri" title="重新扫描全局白板目录" @click="refresh">
          {{ loading ? "扫描中…" : "刷新" }}
        </button>
        <button class="primary" title="新建一份空白白板并打开窗口" @click="openWhiteboard(null)">
          新建白板
        </button>
      </div>
    </div>

    <div v-if="notice" class="wb-notice">{{ notice }}</div>

    <div v-if="errorText" class="wb-error">
      <strong>扫描白板文件失败</strong>
      <pre class="mono">{{ errorText }}</pre>
      <button @click="refresh">重试</button>
    </div>

    <!-- 画廊（空列表时仅显示新建卡片） -->
    <div v-else class="wb-grid">
      <button class="wb-card wb-card-new" title="新建一份空白白板并打开窗口" @click="openWhiteboard(null)">
        <span class="wb-card-new-plus">＋</span>
        <span class="wb-card-name">新建白板</span>
      </button>
      <button
        v-for="name in files"
        :key="name"
        class="wb-card"
        :title="`在白板窗口中打开 ${name}`"
        @click="openWhiteboard(name)"
      >
        <span class="wb-card-preview">
          <img v-if="previews[name]" :src="previews[name]" :alt="name" loading="lazy" draggable="false" />
        </span>
        <span class="wb-card-name" :title="name">{{ name }}</span>
      </button>
    </div>
  </section>
</template>
