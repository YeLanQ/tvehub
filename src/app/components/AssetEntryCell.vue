<script setup lang="ts">
// 资产条目单元格：网格/列表两种视图的呈现与事件透传。
// 选中态/拖放高亮/交互回调由 AssetsPanel 传入（数据与业务留在面板），
// 本组件只做展示与事件转发，供资产面板复用/扩展。
import { isInternalAsset } from "../../lib/internal-assets";
import AssetTypeIcon from "./AssetTypeIcon.vue";
import { fmtSize } from "../lib/format";
import type { ChildEntry } from "../lib/asset-browser";

const props = defineProps<{
  item: ChildEntry;
  /** "grid" 网格（图标+名）/ "list" 列表（路径/类型/大小） */
  view: "grid" | "list";
  selected: boolean;
  /** 内部拖放悬停目录高亮 */
  dropOver: boolean;
}>();

const emit = defineEmits<{
  (e: "click", ev: MouseEvent): void;
  (e: "dblclick"): void;
  (e: "context", ev: MouseEvent): void;
  (e: "mousedown", ev: MouseEvent): void;
}>();

/** 目录可作为拖放目标（内置 internal 目录只读，不作为落点） */
function dropDirAttr(): string | undefined {
  return props.item.kind === "dir" && !isInternalAsset(props.item.path)
    ? props.item.path
    : undefined;
}
</script>

<template>
  <div
    class="am-item"
    :class="[
      view,
      { selected, 'drop-over': dropOver },
    ]"
    :title="item.path"
    :data-drop-dir="dropDirAttr()"
    @click="emit('click', $event)"
    @dblclick="emit('dblclick')"
    @contextmenu.prevent.stop="emit('context', $event)"
    @mousedown="emit('mousedown', $event)"
  >
    <template v-if="view === 'grid'">
      <span class="am-icon"><AssetTypeIcon :kind="item.kind" /></span>
      <span class="am-name">{{ item.name }}</span>
    </template>
    <template v-else>
      <span class="am-icon sm"><AssetTypeIcon :kind="item.kind" /></span>
      <span class="am-name">{{ item.name }}</span>
      <span v-if="item.relPath" class="am-rel">{{ item.relPath }}</span>
      <span v-if="item.kind !== 'dir'" class="am-kind">{{ item.kind }}</span>
      <span v-if="item.kind !== 'dir'" class="am-size">{{ fmtSize(item.size) }}</span>
    </template>
  </div>
</template>
