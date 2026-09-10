<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import { getProjectStore } from "../../stores/project";
import {
  UNTAGGED_LABEL,
  clampLayerIndex,
  definedLayerIndices,
  layerNameAt,
} from "../../../framework/layers";

const props = defineProps<{ node: Node; rev?: number }>();

const emit = defineEmits<{
  rename: [name: string];
  setTag: [tag: string];
  setLayer: [layer: number];
  toggleVisible: [value: boolean];
}>();

const projectStore = getProjectStore();

const localName = ref("");
/** 名称输入框是否正在编辑（编辑中不做外部回填，避免打断输入） */
const editingName = ref(false);

const localTag = ref("");
const editingTag = ref(false);

watch(
  () => props.node.id,
  () => {
    localName.value = props.node.name;
    localTag.value = props.node.tag;
  },
  { immediate: true }
);

// 节点是普通类实例（非响应式），直接 watch node.name 永远不会触发；
// 以 rev（面板刷新号）为信号回填：重命名/撤销/重做后输入框跟随节点数据
watch(
  () => props.rev,
  () => {
    if (!editingName.value && localName.value !== props.node.name) {
      localName.value = props.node.name;
    }
    if (!editingTag.value && localTag.value !== props.node.tag) {
      localTag.value = props.node.tag;
    }
  }
);

function commitName(): void {
  if (localName.value !== props.node.name) {
    emit("rename", localName.value);
  }
}

/** 提交标签（GameObject Tag 语义；脚本经 entity.tag / engine.scene.findByTag 查询） */
function commitTag(v: string): void {
  const t = v.trim();
  if (t !== props.node.tag) {
    localTag.value = t;
    emit("setTag", t);
  }
}

/** 选中「添加标签…」→ 打开项目设置（在「标签与层」页维护标签列表）；其余选项提交标签 */
function onTagSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v === "__add__") {
    localTag.value = props.node.tag;
    projectStore.openSettings();
    return;
  }
  commitTag(v);
}

// —— 标签下拉（内置 Untagged + 项目标签列表；节点上不在列表中的旧值原样保留） ——
const tagOptions = computed(() => {
  void props.rev;
  const tags = projectStore.tags;
  const extra = props.node.tag && !tags.includes(props.node.tag) ? [props.node.tag] : [];
  return [...tags, ...extra];
});

// —— 层下拉（项目层表 + 已删除层的 Layer N 兜底；Unity Layer 单选语义） ——
const layerOptions = computed(() => {
  void props.rev;
  const layer = clampLayerIndex(props.node.layer);
  const indices = new Set<number>(definedLayerIndices(projectStore.layers));
  indices.add(layer);
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => ({ index: i, name: layerNameAt(projectStore.layers, i) }));
});

const currentLayer = computed(() => {
  void props.rev;
  return clampLayerIndex(props.node.layer);
});

function onLayerSelect(e: Event): void {
  const v = parseInt((e.target as HTMLSelectElement).value, 10);
  if (Number.isFinite(v) && v !== currentLayer.value) emit("setLayer", v);
}
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>名称</label>
    <input
      v-model="localName"
      type="text"
      @focus="editingName = true"
      @blur="editingName = false"
      @change="commitName"
    />
  </div>
  <div class="field" :data-rev="rev">
    <label title="渲染层级（Unity Layer 语义；相机/灯光的 Culling Mask 按层筛选渲染与光照）">层</label>
    <select :value="currentLayer" @change="onLayerSelect">
      <option v-for="o in layerOptions" :key="o.index" :value="o.index">
        {{ o.name }}（{{ o.index }}）
      </option>
    </select>
  </div>
  <div class="field" :data-rev="rev">
    <label title="标签（GameObject Tag 语义；脚本按标签查找实体）">标签</label>
    <select :value="localTag" @focus="editingTag = true" @change="onTagSelect">
      <option value="">{{ UNTAGGED_LABEL }}</option>
      <option v-for="t in tagOptions" :key="t" :value="t">{{ t }}</option>
      <option value="__add__">添加标签…</option>
    </select>
  </div>
  <div v-if="node.prefab" class="field">
    <label title="实例来源的预制体资产（右键层级可「更新预制体」回写）">预制体</label>
    <span class="mono comp-type" :title="node.prefab">
      {{ node.prefab.split("/").pop() ?? node.prefab }}
    </span>
  </div>
  <div class="field">
    <label>可见</label>
    <input
      type="checkbox"
      :checked="node.visible"
      @change="emit('toggleVisible', ($event.target as HTMLInputElement).checked)"
    />
  </div>
</template>
