<script setup lang="ts">
/**
 * Culling Mask 控件（Unity 同名语义，相机/灯光共用）：
 * - 折叠态：按钮回显掩码摘要（Everything / Nothing / 逗号分隔层名）；
 * - 展开：Everything / Nothing 快捷档 + 按项目层表逐层勾选（含掩码里有但项目
 *   已删层的 "Layer N" 兜底行，可取消勾选）；
 * - 变更即 emit change(新掩码)，提交/撤销由父级事件链路负责。
 * 层表来自项目设置（project.config.json 的 layers；检查器随 store 响应刷新）。
 */
import { computed, ref } from "vue";
import { getProjectStore } from "../stores/project";
import {
  ALL_LAYERS_MASK,
  MASK_EVERYTHING_LABEL,
  MASK_NOTHING_LABEL,
  cullingMaskLabel,
  definedLayerIndices,
  layerNameAt,
  maskHasLayer,
  maskWithLayer,
} from "../../framework/layers";

const props = defineProps<{ mask: number; rev?: number }>();

const emit = defineEmits<{ change: [mask: number] }>();

const projectStore = getProjectStore();
const open = ref(false);

/** 当前掩码（以 rev 为失效信号：撤销/重做/属性补丁后重算） */
const current = computed(() => {
  void props.rev;
  return props.mask;
});

const summary = computed(() => cullingMaskLabel(projectStore.layers, current.value));

/** 勾选行：项目已定义层 + 掩码里的未定义层兜底（升序去重） */
const rows = computed(() => {
  void props.rev;
  const indices = new Set<number>(definedLayerIndices(projectStore.layers));
  for (let i = 0; i < 32; i++) {
    if (maskHasLayer(current.value, i)) indices.add(i);
  }
  return [...indices].sort((a, b) => a - b).map((i) => ({
    index: i,
    name: layerNameAt(projectStore.layers, i),
    defined: maskHasLayer(current.value, i) && !!projectStore.layers[i],
    on: maskHasLayer(current.value, i),
  }));
});

function toggle(index: number, on: boolean): void {
  emit("change", maskWithLayer(current.value, index, on));
}

function setAll(): void {
  emit("change", ALL_LAYERS_MASK);
}

function setNone(): void {
  emit("change", 0);
}
</script>

<template>
  <div class="culling-mask">
    <button
      type="button"
      class="culling-mask-btn"
      :title="`Culling Mask：${summary}`"
      @click="open = !open"
    >
      <span class="culling-mask-summary">{{ summary }}</span>
      <span class="culling-mask-caret">{{ open ? "▾" : "▸" }}</span>
    </button>
    <div v-if="open" class="culling-mask-pop">
      <div class="culling-mask-quick">
        <button type="button" @click="setAll">{{ MASK_EVERYTHING_LABEL }}</button>
        <button type="button" @click="setNone">{{ MASK_NOTHING_LABEL }}</button>
      </div>
      <label v-for="r in rows" :key="r.index" class="culling-mask-row" :title="r.defined ? '' : '项目层表中已删除的层（掩码位保留）'">
        <input
          type="checkbox"
          :checked="r.on"
          @change="toggle(r.index, ($event.target as HTMLInputElement).checked)"
        />
        <span class="culling-mask-index">{{ r.index }}</span>
        <span :class="{ dim: !r.defined }">{{ r.name }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.culling-mask {
  flex: 1;
  min-width: 0;
}
.culling-mask-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--text, #ddd);
  background: var(--bg, #222);
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.culling-mask-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.culling-mask-caret {
  flex: 0 0 auto;
  color: var(--text-dim, #888);
  font-size: 10px;
}
.culling-mask-pop {
  margin-top: 4px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow-y: auto;
  background: var(--bg, #222);
  border: 1px solid var(--border, #444);
  border-radius: 4px;
}
.culling-mask-quick {
  display: flex;
  gap: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border, #444);
}
.culling-mask-quick button {
  flex: 1;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text, #ddd);
  background: transparent;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  cursor: pointer;
}
.culling-mask-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.culling-mask-index {
  flex: 0 0 16px;
  font-size: 10px;
  color: var(--text-dim, #888);
  text-align: center;
}
.culling-mask-row .dim {
  color: var(--text-dim, #888);
}
</style>
