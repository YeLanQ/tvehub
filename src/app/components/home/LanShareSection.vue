<script setup lang="ts">
/**
 * 首页「共享」分区：统一配置 + 共享清单 + 目录共享入口。
 *
 * 组成：LanServiceCard（服务与地址二维码）、目录共享行（选目录 → 按引用共享，
 * 构建产物/网页预览产物这类大目录不复制，源目录一变访问者立刻看到）、
 * LanShareList（逐条查看二维码/启停/删除）。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import LanServiceCard from "../lan/LanServiceCard.vue";
import LanShareList from "../lan/LanShareList.vue";
import {
  addLanDirShare,
  lanShare,
  refreshLanShare,
  removeLanShare,
  serviceSummary,
} from "../../lib/lan-share";
import { confirm } from "../../lib/confirm";
import { toastErr, toastOk } from "../../lib/toast";
import { getProjectStore } from "../../stores/project";
import { api } from "../../../lib/api";
import { isTauri } from "../../../lib/tauri-env";
import "../../../styles/components/lan-share-section.scss";

const projectStore = getProjectStore();

const busy = ref(false);
const dirPath = ref("");
const dirTitle = ref("");

/** 服务状态一句话（页面头部展示） */
const summary = computed(() => serviceSummary(lanShare.status));
const running = computed(() => lanShare.status?.running ?? false);

/** 刷新间隔：访问统计（次数/最近访客）只在内存里，靠轮询跟上；服务未开时不轮询 */
let timer: number | null = null;

async function refresh(): Promise<void> {
  try {
    await refreshLanShare();
  } catch (e) {
    // 首次载入失败只提示一次，不打断页面（分区其它内容仍可用）
    console.error("读取共享状态失败:", e);
  }
}

function syncTimer(): void {
  const want = running.value && !document.hidden;
  if (want && timer == null) {
    timer = window.setInterval(() => void refresh(), 5000);
  } else if (!want && timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function onVisibility(): void {
  syncTimer();
  if (!document.hidden) void refresh();
}

onMounted(async () => {
  await refresh();
  syncTimer();
  document.addEventListener("visibilitychange", onVisibility);
});

onUnmounted(() => {
  if (timer != null) window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

/** 选目录（桌面端走系统选择器；浏览器预览环境不可用） */
async function pickDir(): Promise<void> {
  if (!isTauri()) {
    toastErr("浏览器预览环境无法选择目录，请在桌面端使用");
    return;
  }
  try {
    const picked = await api.pickProjectFolder();
    if (!picked) return;
    dirPath.value = picked;
    if (!dirTitle.value.trim()) {
      const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? "目录共享";
      dirTitle.value = name;
    }
  } catch (e) {
    toastErr(`选择目录失败：${e}`);
  }
}

async function shareDir(): Promise<void> {
  const dir = dirPath.value.trim();
  if (!dir) {
    toastErr("请先选择要共享的目录");
    return;
  }
  busy.value = true;
  try {
    await addLanDirShare({ title: dirTitle.value.trim() || "目录共享", dir });
    dirPath.value = "";
    dirTitle.value = "";
    syncTimer();
    toastOk("已开始共享该目录，扫码即可访问");
  } catch (e) {
    toastErr(`共享失败：${e}`);
  } finally {
    busy.value = false;
  }
}

/** 一键共享当前项目的构建产物 / 网页预览产物（尚未构建时给出提示） */
async function shareKnownDir(kind: "build" | "preview"): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) {
    toastErr("请先打开一个项目");
    return;
  }
  const name = projectStore.projectName ?? "项目";
  const path = kind === "build" ? `${root}/build/web` : `${root}/.tmp/web-preview`;
  busy.value = true;
  try {
    await addLanDirShare({
      title: kind === "build" ? `${name} · 构建产物` : `${name} · 网页预览`,
      dir: path,
    });
    syncTimer();
    toastOk("已开始共享，扫码即可访问");
  } catch (e) {
    toastErr(
      kind === "build"
        ? `共享失败：${e}（先在「构建」面板导出 web 产物）`
        : `共享失败：${e}（先在编辑器里打开一次网页预览）`,
    );
  } finally {
    busy.value = false;
  }
}

async function confirmResetAll(): Promise<void> {
  const shares = lanShare.status?.shares ?? [];
  if (!shares.length) return;
  const ok = await confirm({
    title: "清空共享",
    message: `确定停止共享全部 ${shares.length} 项内容吗？托管站点文件会一并删除。`,
    confirmText: "全部取消",
  });
  if (!ok) return;
  busy.value = true;
  try {
    for (const s of shares) await removeLanShare(s.id);
    toastOk("已清空共享");
  } catch (e) {
    toastErr(`操作失败：${e}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="lan-section">
    <header class="section-head">
      <div>
        <h1>共享</h1>
        <p class="section-desc">
          把白板、构建产物或任意目录发布成一条局域网址，同网段的手机/平板直接扫码打开。
          状态：{{ summary }}
        </p>
      </div>
      <button class="lan-btn ghost" :disabled="busy || !(lanShare.status?.shares.length)" @click="confirmResetAll">
        清空共享
      </button>
    </header>

    <LanServiceCard />

    <section class="lan-card lan-dir-card">
      <div class="lan-card-head">
        <div>
          <h3>共享一个目录</h3>
          <p class="lan-hint">
            按引用共享：不复制文件，源目录一变访问者立刻看到。适合构建产物、网页预览产物、
            素材目录等会持续更新的内容。
          </p>
        </div>
      </div>

      <div class="lan-dir-form">
        <label class="lan-field">
          <span class="lan-field-label">标题</span>
          <input v-model="dirTitle" spellcheck="false" placeholder="选填，默认取目录名" />
        </label>
        <label class="lan-field">
          <span class="lan-field-label">目录</span>
          <div class="lan-dir-pick">
            <input
              v-model="dirPath"
              spellcheck="false"
              placeholder="选择或粘贴目录绝对路径"
              @keydown.enter="shareDir"
            />
            <button class="lan-btn" :disabled="busy" @click="pickDir">选择…</button>
            <button class="lan-btn primary" :disabled="busy || !dirPath.trim()" @click="shareDir">
              {{ busy ? "处理中…" : "共享" }}
            </button>
          </div>
          <span class="lan-field-hint">入口文件优先取 index.html，没有则取目录里第一个 .html</span>
        </label>
      </div>

      <div class="lan-quick">
        <span class="lan-quick-label">常用：</span>
        <button class="lan-btn ghost" :disabled="busy" @click="shareKnownDir('build')">
          当前项目 · 构建产物
        </button>
        <button class="lan-btn ghost" :disabled="busy" @click="shareKnownDir('preview')">
          当前项目 · 网页预览
        </button>
      </div>
    </section>

    <LanShareList />
  </div>
</template>
