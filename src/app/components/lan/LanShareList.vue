<script setup lang="ts">
/**
 * 共享列表：每条 = 标题/类型/体积/访问统计 + 该条自己的二维码（展开显示）。
 *
 * 每条的二维码编的是「该条直链」，而不是服务首页——手机扫完直接进内容，
 * 少一次点击。目录共享额外给出「在文件夹中打开」，便于回源头改内容。
 */
import { computed, ref } from "vue";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import LanQrCode from "./LanQrCode.vue";
import {
  accessSummary,
  humanSize,
  kindLabel,
  lanShare,
  lanShares,
  primaryUrl,
  relativeTime,
  removeLanShare,
  setLanShareItemEnabled,
  shareLink,
} from "../../lib/lan-share";
import { confirm } from "../../lib/confirm";
import { toastErr, toastOk } from "../../lib/toast";
import { isTauri } from "../../../lib/tauri-env";
import "../../../styles/components/lan-share-list.scss";

/** 当前展开了二维码的共享 id（同一时刻只展开一条，避免长列表被二维码淹没） */
const expanded = ref<string | null>(null);
/** 正在切换启停/删除的共享 id（按钮禁用） */
const pending = ref<string | null>(null);

const shares = computed(() => lanShares());
const serviceUp = computed(() => lanShare.status?.running ?? false);

/** 该条共享的直链：服务未开启时为空（二维码位显示提示） */
function linkOf(id: string): string {
  return serviceUp.value ? shareLink(lanShare.status, id) : "";
}

async function toggleEnabled(id: string, enabled: boolean): Promise<void> {
  pending.value = id;
  try {
    await setLanShareItemEnabled(id, enabled);
  } catch (e) {
    toastErr(`操作失败：${e}`);
  } finally {
    pending.value = null;
  }
}

async function remove(id: string, title: string, managed: boolean): Promise<void> {
  const ok = await confirm({
    title: "取消共享",
    message: `确定停止共享「${title}」吗？${managed ? "生成的站点文件会一并删除。" : "只移除共享记录，不动源目录。"}`,
    confirmText: "取消共享",
  });
  if (!ok) return;
  pending.value = id;
  try {
    await removeLanShare(id);
    if (expanded.value === id) expanded.value = null;
    toastOk("已取消共享");
  } catch (e) {
    toastErr(`删除失败：${e}`);
  } finally {
    pending.value = null;
  }
}

async function openInBrowser(url: string): Promise<void> {
  try {
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    toastErr(`打开失败：${e}`);
  }
}

/** 打开共享的源目录（目录共享 = 源目录本身；托管站点 = 生成的站点目录） */
async function revealSource(root: string): Promise<void> {
  try {
    await openPath(root);
  } catch (e) {
    toastErr(`打开目录失败：${e}`);
  }
}
</script>

<template>
  <section class="lan-list-card">
    <header class="lan-list-head">
      <h3>共享内容</h3>
      <span class="lan-list-count">{{ shares.length }} 项</span>
    </header>

    <p v-if="!shares.length" class="lan-list-empty">
      还没有共享内容。白板窗口点「共享」发布放映页。
    </p>

    <ul v-else class="lan-list">
      <li v-for="s in shares" :key="s.id" class="lan-item" :class="{ off: !s.enabled }">
        <div class="lan-item-main">
          <div class="lan-item-line">
            <span class="lan-item-title" :title="s.title">{{ s.title }}</span>
            <span class="lan-item-kind">{{ kindLabel(s.kind) }}</span>
            <span v-if="!s.managed" class="lan-item-kind sub">目录引用</span>
            <span v-if="!s.enabled" class="lan-item-off">已停用</span>
          </div>
          <div class="lan-item-meta">
            <span>{{ s.fileCount }} 个文件 · {{ humanSize(s.size) }}</span>
            <span>·</span>
            <span>更新于 {{ relativeTime(s.updatedAt) }}</span>
            <span>·</span>
            <span>{{ accessSummary(s) }}</span>
          </div>
          <code v-if="linkOf(s.id)" class="lan-item-link" :title="linkOf(s.id)">{{ linkOf(s.id) }}</code>
          <span v-else class="lan-item-link muted">服务未开启，暂时无法访问</span>
        </div>

        <div class="lan-item-actions">
          <button
            v-if="linkOf(s.id)"
            class="lan-btn"
            @click="expanded = expanded === s.id ? null : s.id"
          >
            {{ expanded === s.id ? "收起二维码" : "二维码" }}
          </button>
          <button v-if="linkOf(s.id)" class="lan-btn ghost" @click="openInBrowser(linkOf(s.id))">
            打开
          </button>
          <button
            class="lan-btn ghost"
            :disabled="pending === s.id"
            @click="revealSource(s.root)"
            :title="s.managed ? '打开生成的站点目录' : '打开源目录'"
          >
            目录
          </button>
          <button
            class="lan-btn ghost"
            :disabled="pending === s.id"
            @click="toggleEnabled(s.id, !s.enabled)"
          >
            {{ s.enabled ? "停用" : "启用" }}
          </button>
          <button
            class="lan-btn ghost danger"
            :disabled="pending === s.id"
            @click="remove(s.id, s.title, s.managed)"
          >
            删除
          </button>
        </div>

        <div v-if="expanded === s.id && primaryUrl(lanShare.status)" class="lan-item-qr">
          <LanQrCode
            :value="linkOf(s.id)"
            :title="`扫码打开「${s.title}」`"
            :caption="linkOf(s.id)"
            :size="156"
            :actions="false"
          />
        </div>
      </li>
    </ul>
  </section>
</template>
