<script setup lang="ts">
/**
 * 场景节点多选下拉：ui-kit MultiSelect 的业务适配（候选来自场景图）。
 * - 候选行：graph 按过滤条件（filter/excludeIds）生成 + 节点类型徽标 +
 *   已删除的选中 id 回显（取消勾选即移除）；
 * - 勾选即时 emit("update", ids)（保持勾选顺序），由调用方走撤销历史提交。
 * 供导航区域采样源（NavAreaSection）与导航代理目标点（NavAgentSection）共用。
 */
import { computed } from "vue";
import MultiSelect from "../../../ui-kit/components/MultiSelect.vue";
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

const emit = defineEmits<{
  update: [ids: string[]];
}>();

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

/** 候选行：过滤后的场景节点 + 已删除的选中 id 回显 */
const options = computed(() => {
  void props.rev;
  const out: { id: string; label: string; badge?: string; badgeDeleted?: boolean }[] = [];
  const listed = new Set<string>();
  const excluded = new Set(props.excludeIds ?? []);
  for (const n of editor().graph.all()) {
    if (excluded.has(n.id)) continue;
    if (props.filter && !props.filter(n)) continue;
    out.push({ id: n.id, label: n.name, badge: kindLabel(n) });
    listed.add(n.id);
  }
  for (const id of props.selectedIds) {
    if (!listed.has(id)) out.push({ id, label: id, badge: "已删除", badgeDeleted: true });
  }
  return out;
});
</script>

<template>
  <MultiSelect
    :selected-ids="selectedIds"
    :options="options"
    :placeholder="placeholder"
    :placeholder-title="placeholderTitle"
    empty-text="场景中没有可选项"
    @update:selected-ids="(ids) => emit('update', ids)"
  />
</template>
