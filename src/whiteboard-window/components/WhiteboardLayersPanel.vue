<script setup lang="ts">
/**
 * 图层面板：图层列表（顶部图层显示在最上），可见性/锁定/重命名/不透明度/
 * 上下移动/删除；点击行设为活动图层（新元素落位）。锁定层元素不可选中/编辑。
 */
import { ref } from "vue";
import { getWhiteboardStore } from "../whiteboardStore";
import {
  EYE_ICON,
  EYE_OFF_ICON,
  LOCK_ICON,
  UNLOCK_ICON,
} from "../tool-icons";

const store = getWhiteboardStore();

/** 正在重命名的图层 id（行内输入） */
const renamingId = ref<string | null>(null);
const renameText = ref("");

function startRename(id: string, name: string): void {
  renamingId.value = id;
  renameText.value = name;
}

function commitRename(): void {
  if (renamingId.value) {
    const name = renameText.value.trim();
    if (name) store.renameLayer(renamingId.value, name);
  }
  renamingId.value = null;
}

function setOpacity(id: string, ev: Event): void {
  const v = parseFloat((ev.target as HTMLInputElement).value);
  const opacity = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : 1;
  store.patchLayer(id, { opacity }, "图层不透明度");
}

/** 顶部图层在前（绘制顺序倒置展示） */
function layersDesc() {
  return [...store.state.doc.layers].reverse();
}

function elCount(id: string): number {
  return store.state.doc.els.filter((e) => e.layerId === id).length;
}
</script>

<template>
  <div class="sv-panel">
    <div class="sv-panel-head">
      <span class="sv-panel-title">图层</span>
      <span class="spacer"></span>
      <button class="sv-mini-btn" title="新建图层（置于最上层）" @click="store.addLayer()">＋</button>
    </div>

    <div class="sv-layer-list">
      <div
        v-for="layer in layersDesc()"
        :key="layer.id"
        class="sv-layer-row"
        :class="{ active: layer.id === store.state.activeLayerId, dimmed: !layer.visible }"
        @click="store.selectLayer(layer.id)"
      >
        <button
          class="sv-eye"
          :class="{ off: !layer.visible }"
          :title="layer.visible ? '隐藏图层' : '显示图层'"
          @click.stop="store.patchLayer(layer.id, { visible: !layer.visible }, layer.visible ? '隐藏图层' : '显示图层')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="layer.visible ? EYE_ICON : EYE_OFF_ICON"></svg>
        </button>
        <button
          class="sv-lock"
          :class="{ on: layer.locked }"
          :title="layer.locked ? '解锁图层' : '锁定图层（元素不可选中/编辑）'"
          @click.stop="store.patchLayer(layer.id, { locked: !layer.locked }, layer.locked ? '解锁图层' : '锁定图层')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="layer.locked ? LOCK_ICON : UNLOCK_ICON"></svg>
        </button>

        <input
          v-if="renamingId === layer.id"
          v-model="renameText"
          class="sv-layer-name-input"
          @click.stop
          @keyup.enter="commitRename"
          @blur="commitRename"
        />
        <span
          v-else
          class="sv-layer-name"
          :title="`${layer.name}（双击重命名，${elCount(layer.id)} 个元素）`"
          @dblclick.stop="startRename(layer.id, layer.name)"
        >
          {{ layer.name }}
        </span>
        <span class="sv-layer-count mono">{{ elCount(layer.id) }}</span>

        <span class="sv-layer-op-wrap" @click.stop>
          <input
            class="sv-layer-op"
            type="number"
            min="0"
            max="100"
            :value="Math.round(layer.opacity * 100)"
            title="图层不透明度（%）"
            @change="setOpacity(layer.id, $event)"
          />
          <span class="sv-layer-op-unit">%</span>
        </span>

        <button class="sv-mini-btn" title="上移（靠顶层）" @click.stop="store.moveLayer(layer.id, true)">↑</button>
        <button class="sv-mini-btn" title="下移（靠底层）" @click.stop="store.moveLayer(layer.id, false)">↓</button>
        <button
          v-if="store.state.doc.layers.length > 1"
          class="sv-mini-btn sv-danger"
          title="删除图层（连同其元素）"
          @click.stop="store.removeLayer(layer.id)"
        >
          ✕
        </button>
      </div>
    </div>

    <div class="sv-panel-foot">
      双击名称重命名 · 点击行切换活动图层（新元素落位于此）
    </div>
  </div>
</template>
