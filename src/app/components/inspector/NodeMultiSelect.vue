<script setup lang="ts">
/**
 * 场景节点多选下拉（浮动菜单）：触发器显示已选摘要，点击弹出 Teleport 浮层
 * 勾选列表（外点/Escape/滚动关闭，与 ContextMenu 同交互模式，防卡片裁剪）。
 * 供"选场景节点集合"的字段共用（导航区域采样源 / 导航代理目标点）。
 * 勾选即时 emit("update", ids)（顺序 = 勾选顺序），由调用方走撤销历史提交。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  CameraNode,
  LightNode,
  MeshNode,
  NavAreaNode,
  NavAgentNode,
  TerrainNode,
} from "../../../framework/prototype/derived/Primitives";
import type { Node } from "../../../framework/prototype/Node";
import { getEditorStore } from "../../stores/editor";

const props = defineProps<{
  /** 已选节点 id（顺序 = 勾选顺序） */
  selectedIds: string[];
  /** 候选过滤（如仅地形/网格）；缺省 = 全部节点 */
  filter?: (n: Node) => boolean;
  /** 排除的节点 id（如自身及其子树） */
  excludeIds?: string[];
  /** 未选中时的占位文案 */
  placeholder?: string;
  /** 未选中时的悬停提示 */
  placeholderTitle?: string;
  rev?: number;
}>();

const emit = defineEmits<{ update: [ids: string[]] }>();

const editor = () => getEditorStore().engine;

/** 节点类型徽标文案 */
function kindLabel(n: Node): string {
  if (n instanceof TerrainNode) return "地形";
  if (n instanceof MeshNode) return "网格";
  if (n instanceof NavAreaNode) return "区域";
  if (n instanceof NavAgentNode) return "代理";
  if (n instanceof LightNode) return "灯光";
  if (n instanceof CameraNode) return "相机";
  return "节点";
}

interface Row {
  id: string;
  name: string;
  kind: string;
  deleted: boolean;
}

/** 候选行：过滤后的场景节点 + 已删除的选中 id 回显（取消勾选即移除） */
const rows = computed<Row[]>(() => {
  void props.rev;
  const out: Row[] = [];
  const listed = new Set<string>();
  const excluded = new Set(props.excludeIds ?? []);
  for (const n of editor().graph.all()) {
    if (excluded.has(n.id)) continue;
    if (props.filter && !props.filter(n)) continue;
    out.push({ id: n.id, name: n.name, kind: kindLabel(n), deleted: false });
    listed.add(n.id);
  }
  for (const id of props.selectedIds) {
    if (!listed.has(id)) out.push({ id, name: id, kind: "已删除", deleted: true });
  }
  return out;
});

function nameOf(id: string): string {
  return rows.value.find((t) => t.id === id)?.name ?? `${id}（已删除）`;
}

/** 勾选/取消一个节点（提交整个 id 数组，保持勾选顺序） */
function onToggle(id: string): void {
  const cur = props.selectedIds;
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  emit("update", next);
}

/** 触发器摘要：未选 = 占位；单个 = 名称；多个 = 首名 + 等N项 */
const summary = computed(() => {
  const ids = props.selectedIds;
  if (ids.length === 0) return props.placeholder ?? "未选择";
  if (ids.length === 1) return nameOf(ids[0]);
  return `${nameOf(ids[0])} 等 ${ids.length} 项`;
});

/** 触发器悬停提示（列出全部已选） */
const hint = computed(() => {
  const ids = props.selectedIds;
  if (ids.length === 0) return props.placeholderTitle ?? "未选择";
  return `已选：${ids.map(nameOf).join("、")}`;
});

// —— 浮动菜单（Teleport 到 body；与 ContextMenu 同关闭策略） ——

const open = ref(false);
const triggerEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const menuPos = ref({ x: 0, y: 0, w: 0 });

/** 打开：按触发器矩形定位（下方空间不足时翻转到上方，nextTick 后量高钳制） */
async function toggleMenu(): Promise<void> {
  if (open.value) {
    closeMenu();
    return;
  }
  const r = triggerEl.value?.getBoundingClientRect();
  if (!r) return;
  menuPos.value = { x: r.left, y: r.bottom + 4, w: r.width };
  open.value = true;
  await nextTick();
  const ph = panelEl.value?.offsetHeight ?? 0;
  if (ph > 0 && menuPos.value.y + ph > window.innerHeight - 8) {
    menuPos.value = { ...menuPos.value, y: Math.max(8, r.top - ph - 4) };
  }
}

function closeMenu(): void {
  open.value = false;
}

/** 外点关闭（mousedown 捕获段；菜单内与触发器上的点击除外） */
function onWindowMouseDown(e: MouseEvent): void {
  const t = e.target as Element | null;
  if (t?.closest?.(".node-multiselect-menu")) return;
  if (triggerEl.value?.contains(t)) return;
  closeMenu();
}

function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeMenu();
}

// 浮层与内容滚动/窗口变化脱钩 → 直接关闭（与 ContextMenu 行为一致）
function onWindowDismiss(): void {
  closeMenu();
}

watch(open, (v) => {
  const w = window;
  if (v) {
    w.addEventListener("mousedown", onWindowMouseDown, true);
    w.addEventListener("keydown", onWindowKey);
    w.addEventListener("blur", onWindowDismiss);
    w.addEventListener("scroll", onWindowDismiss, true);
    w.addEventListener("resize", onWindowDismiss);
  } else {
    w.removeEventListener("mousedown", onWindowMouseDown, true);
    w.removeEventListener("keydown", onWindowKey);
    w.removeEventListener("blur", onWindowDismiss);
    w.removeEventListener("scroll", onWindowDismiss, true);
    w.removeEventListener("resize", onWindowDismiss);
  }
});

onBeforeUnmount(closeMenu);
</script>

<template>
  <div class="node-multiselect">
    <button ref="triggerEl" type="button" class="nm-toggle" :title="hint" @click="toggleMenu">
      <span class="nm-summary" :data-empty="selectedIds.length === 0">{{ summary }}</span>
      <span class="nm-caret" :data-open="open">▾</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="node-multiselect-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px', width: menuPos.w + 'px' }"
      >
        <label
          v-for="t in rows"
          :key="t.id"
          class="nm-row"
          :title="t.deleted ? `${t.name}（节点已删除，取消勾选移除）` : t.name"
        >
          <input
            type="checkbox"
            :checked="selectedIds.includes(t.id)"
            @change="onToggle(t.id)"
          />
          <span class="nm-name">{{ t.name }}</span>
          <span class="nm-kind" :data-deleted="t.deleted">{{ t.kind }}</span>
        </label>
        <div v-if="rows.length === 0" class="nm-empty">场景中没有可选项</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.node-multiselect {
  flex: 1;
  min-width: 0;
}
.nm-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  background: var(--bg-input, transparent);
  color: var(--text, #ddd);
  cursor: pointer;
  font-size: 11px;
  text-align: left;
}
.nm-toggle:hover {
  border-color: var(--accent, #4a9eff);
}
.nm-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nm-summary[data-empty="true"] {
  color: var(--text-dim, #888);
}
.nm-caret {
  flex: none;
  font-size: 9px;
  color: var(--text-dim, #999);
  transition: transform 0.12s;
}
.nm-caret[data-open="true"] {
  transform: rotate(180deg);
}
.node-multiselect-menu {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-panel, #232733);
  border: 1px solid var(--border, #333);
  border-radius: 3px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
}
/* 行宽覆盖：不受检查器 .field label width:80px 影响 */
.node-multiselect-menu .nm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 3px 5px;
  border-radius: 3px;
  cursor: pointer;
}
.node-multiselect-menu .nm-row:hover {
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
}
.nm-row input[type="checkbox"] {
  flex: none;
  margin: 0;
}
.nm-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text, #ddd);
}
.nm-kind {
  flex: none;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 2px;
  border: 1px solid var(--border, #444);
  color: var(--text-dim, #999);
}
.nm-kind[data-deleted="true"] {
  color: #e08080;
  border-color: #a06060;
}
.nm-empty {
  font-size: 10px;
  color: var(--text-dim, #777);
  padding: 2px 0;
}
</style>
