<script setup lang="ts">
/**
 * 首页「共享」分区：统一配置 + 共享清单。
 *
 * 组成：LanServiceCard（服务与地址二维码）、LanShareList（逐条查看二维码/启停/删除）。
 * 发布入口在白板窗口的「共享」弹层（LanShareDialog，发布成托管放映页）。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import LanServiceCard from "../lan/LanServiceCard.vue";
import LanShareList from "../lan/LanShareList.vue";
import { lanShare, refreshLanShare, removeLanShare, serviceSummary } from "../../lib/lan-share";
import { confirm } from "../../lib/confirm";
import { toastErr, toastOk } from "../../lib/toast";
import "../../../styles/components/lan-share-section.scss";

const busy = ref(false);

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
          把白板放映页发布成一条局域网址，同网段的手机/平板直接扫码打开。
          状态：{{ summary }}
        </p>
      </div>
      <button class="lan-btn ghost" :disabled="busy || !(lanShare.status?.shares.length)" @click="confirmResetAll">
        清空共享
      </button>
    </header>

    <LanServiceCard />

    <LanShareList />
  </div>
</template>
