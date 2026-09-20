<script setup lang="ts">
/**
 * 首页「白板」分区：时间轴资产管理（全局白板，不绑定项目）。
 * - 时间轴按最近保存日期分组倒序排列；卡片含预览/标签/时间与悬停操作；
 * - 标签（逗号分隔编辑、单标签移除）与归档状态存全局元数据（ui-state KV），
 *   白板窗口保存时自动刷新 updatedAt，跨窗口经元数据变更事件同步；
 * - 支持文件名搜索与标签筛选；已归档白板通过页头开关单独查看；
 * - 新建白板为紧凑卡片（时间轴首组网格首位），点击打开全局单例白板窗口。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "../../lib/confirm";
import { api } from "../../../lib/api";
import { isTauri } from "../../../lib/tauri-env";
import {
  ensureWhiteboardMeta,
  loadWhiteboardMeta,
  onWhiteboardMetaChange,
  patchWhiteboardMeta,
  removeWhiteboardMeta,
  type WhiteboardMetaEntry,
} from "../../../whiteboard-window/whiteboard-meta";
import { toastOk, toastWarn, toastErr } from "../../lib/toast";
import "../../../styles/components/whiteboard-section.scss";

interface WbItem {
  name: string;
  preview?: string;
  meta: WhiteboardMetaEntry;
}

const items = ref<WbItem[]>([]);
const previews = ref<Record<string, string>>({});
const loading = ref(false);
const errorText = ref("");
const search = ref("");
const filterTag = ref("");
const showArchived = ref(false);
/** 正在编辑标签的白板名（行内编辑区） */
const editingName = ref("");
const tagDraft = ref("");

let unlistenSaved: UnlistenFn | null = null;
let unlistenMeta: UnlistenFn | null = null;

/** 列出全局白板文件 + 预览（data URL）+ 元数据（缺失自动登记） */
async function refresh(): Promise<void> {
  if (!isTauri()) return;
  loading.value = true;
  errorText.value = "";
  try {
    const names = await api.whiteboardListFiles();
    for (const n of names) await ensureWhiteboardMeta(n);
    const meta = await loadWhiteboardMeta();
    items.value = names.map((name) => ({
      name,
      meta:
        meta[name] ??
        { createdAt: Date.now(), updatedAt: Date.now(), tags: [], archived: false },
    }));
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
    items.value = [];
    previews.value = {};
  } finally {
    loading.value = false;
  }
}

/** 打开白板窗口（单例）：name 非空 = 打开指定文件；null = 新建/聚焦 */
async function openWhiteboard(name: string | null): Promise<void> {
  if (!isTauri()) {
    toastWarn("白板窗口需在桌面端使用（浏览器预览无窗口系统）");
    return;
  }
  try {
    await api.showWhiteboardWindow(name);
    // 窗口已存在时热直达（冷启动时事件丢失，由待打开状态兜底）
    if (name) void emit("tve:whiteboard-open", { name }).catch(() => {});
  } catch (e) {
    toastErr(`打开白板失败: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// 筛选与时间轴分组
// ---------------------------------------------------------------------------
const filteredItems = computed<WbItem[]>(() => {
  const kw = search.value.trim().toLowerCase();
  return items.value.filter((it) => {
    if (it.meta.archived !== showArchived.value) return false;
    if (filterTag.value && !it.meta.tags.includes(filterTag.value)) return false;
    if (kw && !it.name.toLowerCase().includes(kw)) return false;
    return true;
  });
});

const allTags = computed<string[]>(() => {
  const set = new Set<string>();
  for (const it of items.value) it.meta.tags.forEach((t) => set.add(t));
  return [...set].sort();
});

const dayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

/** 按最近保存日期分组（键倒序 = 时间轴顺序），组内按 updatedAt 倒序 */
const timeline = computed<[string, WbItem[]][]>(() => {
  const map = new Map<string, WbItem[]>();
  for (const it of filteredItems.value) {
    const key = dayKey(it.meta.updatedAt || it.meta.createdAt);
    const list = map.get(key);
    if (list) list.push(it);
    else map.set(key, [it]);
  }
  const groups = [...map.entries()];
  groups.sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, list] of groups) {
    list.sort(
      (a, b) => (b.meta.updatedAt || b.meta.createdAt) - (a.meta.updatedAt || a.meta.createdAt),
    );
  }
  return groups;
});

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------------------
// 标签编辑 / 归档 / 删除
// ---------------------------------------------------------------------------
function startTagEdit(name: string): void {
  const it = items.value.find((x) => x.name === name);
  tagDraft.value = it ? it.meta.tags.join("，") : "";
  editingName.value = name;
}

async function commitTagEdit(): Promise<void> {
  const name = editingName.value;
  editingName.value = "";
  if (!name) return;
  const tags = tagDraft.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  await patchWhiteboardMeta(name, { tags });
  await refresh();
}

async function removeTag(name: string, tag: string): Promise<void> {
  const it = items.value.find((x) => x.name === name);
  if (!it) return;
  await patchWhiteboardMeta(name, { tags: it.meta.tags.filter((t) => t !== tag) });
  await refresh();
}

async function toggleArchive(name: string): Promise<void> {
  const it = items.value.find((x) => x.name === name);
  if (!it) return;
  await patchWhiteboardMeta(name, { archived: !it.meta.archived });
  await refresh();
}

async function deleteWhiteboard(name: string): Promise<void> {
  const ok = await confirm({
    title: "删除白板",
    message: `确定删除「${name}」吗？该操作不可恢复。`,
    confirmText: "删除",
  });
  if (!ok) return;
  try {
    await api.whiteboardDelete(name);
    await removeWhiteboardMeta(name);
    await refresh();
    toastOk(`已删除 ${name}`);
  } catch (e) {
    toastErr(`删除失败：${e}`);
  }
}

// ---------------------------------------------------------------------------
// 生命周期：刷新 + 双通道监听（保存事件 / 元数据变更）
// ---------------------------------------------------------------------------
onMounted(async () => {
  void refresh();
  try {
    unlistenSaved = await listen<{ name: string }>("tve:whiteboard-saved", () => {
      void refresh();
    });
    unlistenMeta = await onWhiteboardMetaChange(() => void refresh());
  } catch {
    /* 浏览器开发环境忽略 */
  }
});

onUnmounted(() => {
  unlistenSaved?.();
  unlistenSaved = null;
  unlistenMeta?.();
  unlistenMeta = null;
});
</script>

<template>
  <section class="page wb-page">
    <div class="page-head">
      <input v-model="search" class="wb-search wb-search-head" placeholder="搜索白板名称…" />
      <div class="head-actions">
        <span class="wb-count">{{ filteredItems.length }} 个白板</span>
        <button
          class="wb-chip"
          :class="{ 'is-on': showArchived }"
          :disabled="loading || !isTauri"
          title="查看已归档的白板"
          @click="showArchived = !showArchived"
        >
          {{ showArchived ? "返回时间轴" : "已归档" }}
        </button>
        <button :disabled="loading || !isTauri" title="重新扫描全局白板目录" @click="refresh">
          {{ loading ? "扫描中…" : "刷新" }}
        </button>
        <button class="primary" title="新建一份空白白板并打开窗口" @click="openWhiteboard(null)">
          新建白板
        </button>
      </div>
    </div>

    <!-- 筛选：标签 chips（搜索已移至页头） -->
    <div v-if="allTags.length" class="wb-filters">
      <span class="wb-chip-row">
        <span class="wb-chip" :class="{ 'is-on': !filterTag }" @click="filterTag = ''">全部</span>
        <span
          v-for="t in allTags"
          :key="t"
          class="wb-chip"
          :class="{ 'is-on': filterTag === t }"
          @click="filterTag = filterTag === t ? '' : t"
        >
          {{ t }}
        </span>
      </span>
    </div>

    <div v-if="errorText" class="wb-error">
      <strong>扫描白板文件失败</strong>
      <pre class="mono">{{ errorText }}</pre>
      <button @click="refresh">重试</button>
    </div>

    <!-- 时间轴（首组网格首位放紧凑新建卡片） -->
    <div v-else-if="timeline.length" class="wb-timeline">
      <div v-for="[day, list] in timeline" :key="day" class="wb-tl-group">
        <div class="wb-tl-date">
          <span>{{ day }}</span>
          <span class="wb-tl-count">{{ list.length }} 个</span>
        </div>
        <div class="wb-tl-grid">
          <div
            v-for="it in list"
            :key="it.name"
            class="wb-card"
            :class="{ archived: it.meta.archived }"
            :title="it.name"
          >
            <div class="wb-thumb" @click="openWhiteboard(it.name)">
              <img v-if="previews[it.name]" :src="previews[it.name]" :alt="it.name" decoding="async" />
              <span v-else class="wb-thumb-empty">无预览</span>
              <div class="wb-hover" @click.stop>
                <button class="wb-icon-btn" title="在白板窗口中打开" @click="openWhiteboard(it.name)">↗</button>
                <button
                  class="wb-icon-btn"
                  :title="it.meta.archived ? '恢复归档' : '归档'"
                  @click="toggleArchive(it.name)"
                >
                  {{ it.meta.archived ? "↩" : "▣" }}
                </button>
                <button class="wb-icon-btn" title="编辑标签" @click="startTagEdit(it.name)">✎</button>
                <button class="wb-icon-btn wb-danger" title="删除白板" @click="deleteWhiteboard(it.name)">✕</button>
              </div>
            </div>
            <div class="wb-info">
              <div class="wb-name" :title="it.name">{{ it.name }}</div>
              <div class="wb-meta">{{ fmtTime(it.meta.updatedAt || it.meta.createdAt) }}</div>
              <div class="wb-chips">
                <span
                  v-for="t in it.meta.tags"
                  :key="t"
                  class="wb-tag"
                  title="移除标签"
                  @click.stop="removeTag(it.name, t)"
                >
                  {{ t }} ×
                </span>
                <button class="wb-tag-add" @click.stop="startTagEdit(it.name)">＋ 标签</button>
              </div>
            </div>
            <div v-if="editingName === it.name" class="wb-edit" @click.stop>
              <input
                v-model="tagDraft"
                placeholder="标签，逗号分隔"
                @keydown.enter="commitTagEdit"
              />
              <div class="wb-edit-actions">
                <button class="primary" @click="commitTagEdit">保存</button>
                <button @click="editingName = ''">取消</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空态引导（新建入口在页头「新建白板」按钮） -->
    <div v-else class="wb-empty-hint">
      {{ showArchived ? "没有已归档的白板。" : "还没有白板——点击右上角「新建白板」开始。" }}
    </div>
  </section>
</template>
