<script setup lang="ts">
/**
 * 左侧停靠·「层级」（编辑器层级面板同构复刻）：
 * - 与编辑器共享后端场景会话，scene:changed 实时刷新（数据一致）；
 * - 同款树结构/类型图标/折叠/搜索（复用 hierarchy-panel.scss 与引擎图标数据）；
 * - 行可拖入画布生成原型卡片；双击 = 加入画布中央；右键 = 加入/复制名称。
 */
import { computed, onMounted, ref, watch } from "vue";
import {
  CAMERA_ICON_PATHS,
  MESH_ICON_PATHS,
  GROUP_ICON_PATHS,
  SKYBOX_ICON_PATHS,
  AUDIO_ICON_PATHS,
  PARTICLE_ICON_PATHS,
  TERRAIN_ICON_PATHS,
  FOG_ICON_PATHS,
  LIGHT_POINT_ICON_PATHS,
  LIGHT_DIRECTIONAL_ICON_PATHS,
  LIGHT_AMBIENT_ICON_PATHS,
  LIGHT_SPOT_ICON_PATHS,
  UI_CANVAS_ICON_PATHS,
  UI_IMAGE_ICON_PATHS,
  UI_TEXT_ICON_PATHS,
  UI_BUTTON_ICON_PATHS,
  UI_LAYOUT_ICON_PATHS,
  NAV_AREA_ICON_PATHS,
  NAV_AGENT_ICON_PATHS,
  FSM_RUNNER_ICON_PATHS,
  BT_RUNNER_ICON_PATHS,
} from "../../framework/engine/modules/helpers/icons";
import { openContextMenu } from "../../lib/editor/context-menu";
import { getGraphWindowStore } from "../graphStore";
import {
  buildEntityTree,
  flattenEntityTree,
} from "../lib/scene-index";
import "../../styles/components/hierarchy-panel.scss";

const store = getGraphWindowStore();
const search = ref("");
const loaded = ref(false);
const collapsed = ref(new Set<string>());
const selectedId = ref("");

// 折叠态按窗口持久化（键含 graph 前缀与编辑器隔离；键 = 项目根 + 当前场景，
// 与编辑器层级折叠的持久化规则同构）
const collapseKey = computed(
  () => `three-visual-editor:graph-hierarchy:v1:${store.root ?? ""}::${store.sceneRel}`,
);
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadCollapsed(): void {
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const raw = localStorage.getItem(collapseKey.value);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    collapsed.value = new Set(
      Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    collapsed.value = new Set();
  }
}

function persistCollapsed(): void {
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(collapseKey.value, JSON.stringify([...collapsed.value]));
    } catch {
      /* 存储不可用：折叠态仅本次会话有效 */
    }
  }, 300);
}

watch(collapseKey, loadCollapsed, { immediate: true });

/** 节点类型 → SVG 图标路径 + 颜色（与编辑器层级/引擎视口同一份图标数据） */
const NODE_ICONS: Record<string, { d: string[]; color: string }> = {
  node: { d: GROUP_ICON_PATHS, color: "#9aa4b2" },
  meshNode: { d: MESH_ICON_PATHS, color: "#8ab4f8" },
  cameraNode: { d: CAMERA_ICON_PATHS, color: "#4fc3f7" },
  lightNode: { d: LIGHT_POINT_ICON_PATHS, color: "#ffb84d" },
  pointLightNode: { d: LIGHT_POINT_ICON_PATHS, color: "#ffb84d" },
  directionalLightNode: { d: LIGHT_DIRECTIONAL_ICON_PATHS, color: "#ffd166" },
  ambientLightNode: { d: LIGHT_AMBIENT_ICON_PATHS, color: "#fff3b0" },
  spotLightNode: { d: LIGHT_SPOT_ICON_PATHS, color: "#ffcc66" },
  skyboxNode: { d: SKYBOX_ICON_PATHS, color: "#a78bfa" },
  audioNode: { d: AUDIO_ICON_PATHS, color: "#f48fb1" },
  particleSystemNode: { d: PARTICLE_ICON_PATHS, color: "#80deea" },
  terrainNode: { d: TERRAIN_ICON_PATHS, color: "#a5d6a7" },
  fogNode: { d: FOG_ICON_PATHS, color: "#b0bec5" },
  uiCanvasNode: { d: UI_CANVAS_ICON_PATHS, color: "#ce93d8" },
  uiImageNode: { d: UI_IMAGE_ICON_PATHS, color: "#ce93d8" },
  uiTextNode: { d: UI_TEXT_ICON_PATHS, color: "#ce93d8" },
  uiButtonNode: { d: UI_BUTTON_ICON_PATHS, color: "#ce93d8" },
  uiLayoutNode: { d: UI_LAYOUT_ICON_PATHS, color: "#ce93d8" },
  navAreaNode: { d: NAV_AREA_ICON_PATHS, color: "#80cbc4" },
  navAgentNode: { d: NAV_AGENT_ICON_PATHS, color: "#80cbc4" },
  fsmRunnerNode: { d: FSM_RUNNER_ICON_PATHS, color: "#ff8a65" },
  btRunnerNode: { d: BT_RUNNER_ICON_PATHS, color: "#ff8a65" },
};

function iconOf(type: string): { d: string[]; color: string } {
  return NODE_ICONS[type] ?? NODE_ICONS.node;
}

const tree = computed(() => buildEntityTree(store.sceneEntities));

/** 搜索过滤：命中项与其祖先链保留（子级命中则父链可见） */
const flat = computed(() => {
  const kw = search.value.trim().toLowerCase();
  const rows = flattenEntityTree(tree.value, (id) => collapsed.value.has(id));
  if (!kw) return rows;
  const hitIds = new Set(
    store.sceneEntities.filter((e) => e.name.toLowerCase().includes(kw) || e.type.toLowerCase().includes(kw)).map((e) => e.id),
  );
  const byId = new Map(store.sceneEntities.map((e) => [e.id, e]));
  const keep = new Set<string>();
  for (const id of hitIds) {
    let cur: string | undefined = id;
    while (cur && !keep.has(cur)) {
      keep.add(cur);
      cur = byId.get(cur)?.parentId;
    }
  }
  return rows.filter((r) => keep.has(r.entity.id));
});

function hasChildren(id: string): boolean {
  const t = tree.value;
  const find = (nodes: ReturnType<typeof buildEntityTree>): boolean => {
    for (const n of nodes) {
      if (n.entity.id === id) return n.children.length > 0;
      if (find(n.children)) return true;
    }
    return false;
  };
  return find(t);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  persistCollapsed();
}

function onDragStart(e: DragEvent, id: string): void {
  e.dataTransfer?.setData("application/x-tve-entity", id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
}

function addToCanvas(id: string): void {
  store.canvas?.addProto(id);
}

function copyName(name: string): void {
  void navigator.clipboard
    .writeText(name)
    .then(() => store.showToast(`已复制实体名: ${name}`))
    .catch(() => store.showToast("复制失败"));
}

function onRowContext(e: MouseEvent, id: string, name: string): void {
  openContextMenu(e, [
    { label: "加入画布", onClick: () => addToCanvas(id) },
    { label: "复制名称", onClick: () => copyName(name) },
  ]);
}

onMounted(async () => {
  await store.ensureSceneSession();
  loaded.value = true;
});
</script>

<template>
  <div class="panel hierarchy">
    <div class="h-actions">
      <input v-model="search" class="h-search" placeholder="搜索节点…" />
    </div>

    <div class="tree">
      <div
        v-for="{ entity, depth } in flat"
        :key="entity.id"
        class="node-row"
        :data-node-id="entity.id"
        :class="{ sel: selectedId === entity.id }"
        :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
        draggable="true"
        :title="`${entity.name}（${entity.type}）— 拖入画布生成原型`"
        @dragstart="onDragStart($event, entity.id)"
        @click="selectedId = entity.id"
        @dblclick="addToCanvas(entity.id)"
        @contextmenu.prevent="onRowContext($event, entity.id, entity.name)"
      >
        <span
          class="h-caret"
          :class="{ leaf: !hasChildren(entity.id) }"
          :title="hasChildren(entity.id) ? (collapsed.has(entity.id) ? '展开子级' : '折叠子级') : ''"
          @click.stop="toggleCollapse(entity.id)"
        >{{ hasChildren(entity.id) ? (collapsed.has(entity.id) ? "▸" : "▾") : "" }}</span>
        <span class="badge" :class="[entity.type]" :style="{ color: iconOf(entity.type).color }">
          <svg
            class="badge-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path v-for="(d, i) in iconOf(entity.type).d" :key="i" :d="d" />
          </svg>
        </span>
        <span class="name">{{ entity.name }}</span>
      </div>
      <div v-if="loaded && !flat.length" class="gempty">暂无实体（项目还没有场景或场景为空）</div>
    </div>
    <div class="gpanel-tip">拖动实体到画布生成原型卡片；双击加入画布</div>
  </div>
</template>
