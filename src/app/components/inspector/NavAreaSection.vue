<script setup lang="ts">
/**
 * 导航区域卡（NavAreaNode）：
 * - Sources：采样源多选（场景地形 + 网格；多源按最高面合并；全不选 = 自动取
 *   场景第一块地形）；
 * - Baking：网格分辨率 / 代理半径（净空）/ 最大坡度 / 最大高差 / 障碍收集模式；
 * - Display：可视化模式（关闭 / 可行走叠加 / SDF 热力图）；
 * - 状态：烘焙统计（格数/可行走占比/耗时）+ 手动重烘焙按钮（兜底；采样源/
 *   障碍变化已自动按签名重烘焙）。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案；
 * 改设置 → 签名变化 → 导航系统自动重烘焙。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { NavAreaNode } from "../../../framework/prototype/derived/Primitives";
import { MeshNode, TerrainNode } from "../../../framework/prototype/derived/Primitives";
import { NAV_AREA_LIMITS } from "../../../framework/navigation";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: NavAreaNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const L = NAV_AREA_LIMITS;

/** 节点是普通类实例（非响应式）：以 rev 为失效信号读取设置 */
const s = computed(() => {
  void props.rev;
  return props.node.settings;
});

const editor = () => getEditorStore().engine;

/** 采样源候选行：场景中的地形/网格 + 已删除的绑定 id 回显（取消勾选即移除） */
const sources = computed(() => {
  void props.rev;
  const rows: { id: string; name: string; kind: string; deleted: boolean }[] = [];
  const listed = new Set<string>();
  for (const n of editor().graph.all()) {
    if (n instanceof TerrainNode) {
      rows.push({ id: n.id, name: n.name, kind: "地形", deleted: false });
      listed.add(n.id);
    } else if (n instanceof MeshNode) {
      rows.push({ id: n.id, name: n.name, kind: "网格", deleted: false });
      listed.add(n.id);
    }
  }
  for (const id of s.value.sourceIds) {
    if (!listed.has(id)) rows.push({ id, name: id, kind: "已删除", deleted: true });
  }
  return rows;
});

/** 勾选/取消一个采样源（提交整个 sourceIds 数组，走撤销历史） */
function onToggle(id: string): void {
  const cur = s.value.sourceIds;
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  emit("update", "Set Nav Sources", next);
}

/** 下拉浮层开关（Teleport 到 body 的浮动菜单，与 ContextMenu 同交互模式） */
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
  if (t?.closest?.(".nav-sources-menu")) return;
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

/** 触发器摘要：未选 = 自动；单个 = 名称；多个 = 首名 + 等N项 */
const sourcesSummary = computed(() => {
  const ids = s.value.sourceIds;
  if (ids.length === 0) return "自动（第一块地形）";
  if (ids.length === 1) return sources.value.find((t) => t.id === ids[0])?.name ?? ids[0];
  const first = sources.value.find((t) => t.id === ids[0])?.name ?? ids[0];
  return `${first} 等 ${ids.length} 项`;
});

/** 触发器悬停提示（列出全部已选源） */
const sourcesHint = computed(() => {
  const ids = s.value.sourceIds;
  if (ids.length === 0) return "未选择采样源：自动使用场景第一块地形";
  const names = ids.map((id) => sources.value.find((t) => t.id === id)?.name ?? `${id}（已删除）`);
  return `采样源：${names.join("、")}`;
});

/** 烘焙统计（导航系统在属性变化时自动重烘焙；rev 变化即重读） */
const stats = computed(() => {
  void props.rev;
  return editor().nav.getAreaStats(props.node.id);
});

const baking = ref(false);
/** 手动重烘焙：兜底（采样源/障碍/地形内容变化已自动触发） */
async function onBake(): Promise<void> {
  if (baking.value) return;
  baking.value = true;
  try {
    const r = editor().nav.bakeArea(props.node.id);
    if (!r) logWarn("没有可烘焙的导航区域数据（需要采样源：地形或网格）");
  } finally {
    baking.value = false;
  }
}

function logWarn(msg: string): void {
  // 延迟引用避免循环依赖（logStore 只在动作时用）
  void import("../../stores/log").then(({ logStore }) => logStore.log("warn", msg));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
</script>

<template>
  <div class="terrain-section" :data-rev="rev">
    <!-- ===== Sources ===== -->
    <div class="ts-group">Sources</div>
    <div class="field nav-sources-field">
      <label title="采样源（地形或网格，可多选）：可行走面按每格最高面合并；全不选 = 自动使用场景第一块地形">Targets</label>
      <div class="nav-sources-wrap">
        <button
          ref="triggerEl"
          type="button"
          class="nav-sources-toggle"
          :title="sourcesHint"
          @click="toggleMenu"
        >
          <span class="nav-sources-summary" :data-empty="s.sourceIds.length === 0">{{ sourcesSummary }}</span>
          <span class="nav-sources-caret" :data-open="open">▾</span>
        </button>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="nav-sources nav-sources-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px', width: menuPos.w + 'px' }"
      >
        <label
          v-for="t in sources"
          :key="t.id"
          class="nav-source-row"
          :title="t.deleted ? `${t.name}（节点已删除，取消勾选移除）` : t.name"
        >
          <input
            type="checkbox"
            :checked="s.sourceIds.includes(t.id)"
            @change="onToggle(t.id)"
          />
          <span class="nav-source-name">{{ t.name }}</span>
          <span class="nav-source-kind" :data-deleted="t.deleted">{{ t.kind }}</span>
        </label>
        <div v-if="sources.length === 0" class="nav-source-empty">场景中没有地形或网格</div>
      </div>
    </Teleport>

    <!-- ===== Baking ===== -->
    <div class="ts-group">Baking</div>
    <div class="field">
      <label title="一格边长（米）：越小越精细，烘焙与内存开销越大">Cell Size</label>
      <NumberField
        :model-value="s.cellSize"
        :step="0.25"
        :min="L.cellSize.min"
        :max="L.cellSize.max"
        title="网格分辨率（格边长，世界单位）"
        @commit="(v) => emit('update', 'Set Cell Size', clamp(v, L.cellSize.min, L.cellSize.max))"
      />
    </div>
    <div class="field">
      <label title="可行走判定净空：到最近障碍的距离 ≥ 此值的格才可行走">Radius</label>
      <NumberField
        :model-value="s.agentRadius"
        :step="0.1"
        :min="L.agentRadius.min"
        :max="L.agentRadius.max"
        title="代理半径（世界单位）"
        @commit="(v) => emit('update', 'Set Agent Radius', clamp(v, L.agentRadius.min, L.agentRadius.max))"
      />
    </div>
    <div class="field">
      <label title="超过此坡度的格不可行走">Max Slope</label>
      <NumberField
        :model-value="s.maxSlope"
        :step="5"
        :min="L.maxSlope.min"
        :max="L.maxSlope.max"
        title="最大可行走坡度（度）"
        @commit="(v) => emit('update', 'Set Max Slope', clamp(v, L.maxSlope.min, L.maxSlope.max))"
      />
    </div>
    <div class="field">
      <label title="相邻格高差超过此值视为陡坎（不可跨）">Step</label>
      <NumberField
        :model-value="s.maxHeightStep"
        :step="0.25"
        :min="L.maxHeightStep.min"
        :max="L.maxHeightStep.max"
        title="相邻格最大高差（世界单位）"
        @commit="(v) => emit('update', 'Set Max Height Step', clamp(v, L.maxHeightStep.min, L.maxHeightStep.max))"
      />
    </div>
    <div class="field">
      <label title="auto = 收集场景静态碰撞体投影为障碍；ignore = 只按采样源烘焙">Obstacles</label>
      <select
        :value="s.obstaclesMode"
        @change="emit('update', 'Set Obstacles Mode', ($event.target as HTMLSelectElement).value)"
      >
        <option value="auto">自动收集</option>
        <option value="ignore">忽略障碍</option>
      </select>
    </div>

    <!-- ===== Display ===== -->
    <div class="ts-group">Display</div>
    <div class="field">
      <label title="可视化叠层：可行走区域叠加 / SDF 距离场热力图（黄近障碍、蓝远离、障碍内红紫）">Mode</label>
      <select
        :value="s.display"
        @change="emit('update', 'Set Display Mode', ($event.target as HTMLSelectElement).value)"
      >
        <option value="off">关闭</option>
        <option value="walkable">可行走叠加</option>
        <option value="sdf">SDF 热力图</option>
      </select>
    </div>

    <!-- ===== 状态 / 操作 ===== -->
    <div class="ts-actions">
      <button
        :disabled="baking"
        title="按当前设置与场景内容重新烘焙（设置与采样源变化会自动触发）"
        @click="onBake"
      >
        {{ baking ? "烘焙中…" : "重新烘焙" }}
      </button>
      <span v-if="stats" class="hint">
        {{ stats.cells }} 格 · 可行走 {{ (stats.walkableRatio * 100).toFixed(0) }}% ·
        {{ stats.bakeMs.toFixed(1) }}ms
      </span>
      <span v-else class="hint">未烘焙（需要采样源：地形或网格）</span>
    </div>
  </div>
</template>

<style scoped>
.ts-group {
  margin: 8px 0 2px;
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
}
.nav-sources-field {
  align-items: flex-start;
}
.nav-sources-field > label {
  padding-top: 4px;
}
.nav-sources-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 触发器：与 .field 的 select 同外观（见 inspector-panel.scss 输入框公共样式） */
.nav-sources-toggle {
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
.nav-sources-toggle:hover {
  border-color: var(--accent, #4a9eff);
}
.nav-sources-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-sources-summary[data-empty="true"] {
  color: var(--text-dim, #888);
}
.nav-sources-caret {
  flex: none;
  font-size: 9px;
  color: var(--text-dim, #999);
  transition: transform 0.12s;
}
.nav-sources-caret[data-open="true"] {
  transform: rotate(180deg);
}
.nav-sources {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 168px;
  overflow-y: auto;
  border: 1px solid var(--border, #333);
  border-radius: 3px;
  padding: 2px 4px;
}
/* 浮层形态：Teleport 到 body 的固定定位菜单（与 ContextMenu 同视觉语言） */
.nav-sources-menu {
  position: fixed;
  z-index: 10000;
  max-height: 220px;
  padding: 4px;
  background: var(--bg-panel, #232733);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
}
/* 选择器带 .nav-sources 前缀：压过全局 .inspector .field label 的 width:80px */
.nav-sources .nav-source-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 3px 5px;
  border-radius: 3px;
  cursor: pointer;
}
.nav-sources .nav-source-row:hover {
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
}
.nav-source-row input[type="checkbox"] {
  flex: none;
  margin: 0;
}
.nav-source-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text, #ddd);
}
.nav-source-kind {
  flex: none;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 2px;
  border: 1px solid var(--border, #444);
  color: var(--text-dim, #999);
}
.nav-source-kind[data-deleted="true"] {
  color: #e08080;
  border-color: #a06060;
}
.nav-source-empty {
  font-size: 10px;
  color: var(--text-dim, #777);
  padding: 2px 0;
}
.ts-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 4px;
}
.ts-actions button {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ts-actions button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.ts-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.ts-actions .hint {
  font-size: 10px;
  color: var(--text-dim, #888);
}
</style>
