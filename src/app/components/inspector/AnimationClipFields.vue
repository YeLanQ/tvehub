<script setup lang="ts">
// 动画剪辑组件字段区（组件卡片主体）：绑定 .anim 剪辑资产 + 播放设置
// （自动播放/循环/速度）。勾选与增删在卡片头（InspectorPanel）。
import { computed } from "vue";
import type { AnimationClipComponentRef } from "../../../framework/prototype/Node";
import { getAssetsStore } from "../../stores/assets";
import { openInAnimEditor } from "../../lib/anim-editor";
import NumberField from "../NumberField.vue";

defineProps<{ comp: AnimationClipComponentRef; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
  openEditor: [];
}>();

const assetsStore = getAssetsStore();

/** .anim 剪辑资产候选（内置 + 项目） */
const clipOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (a.kind === "dir" || a.kind !== "anim") continue;
    if (a.path.startsWith("internal/")) internal.push({ rel: a.path, name: a.name });
    else project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

function onClipChange(e: Event): void {
  emit("update", "Set Anim Clip", (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>动画剪辑</label>
    <select :value="comp.clip.clip" @change="onClipChange($event)">
      <option value="">（未绑定）</option>
      <optgroup v-if="clipOptions.internal.length" label="内置动画">
        <option v-for="o in clipOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </optgroup>
      <optgroup label="项目动画">
        <option
          v-if="clipOptions.project.length === 0"
          value=""
          disabled
        >（项目内暂无动画，可在资产面板「新建动画」）</option>
        <option v-for="o in clipOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </optgroup>
    </select>
  </div>

  <label class="comp-check" @click.stop>
    <input
      type="checkbox"
      :checked="comp.clip.autoplay"
      :disabled="!comp.clip.clip"
      @change="emit('update', 'Set Anim Autoplay', ($event.target as HTMLInputElement).checked)"
    />
    <span>自动播放（进入预览/发布即播）</span>
  </label>
  <label class="comp-check" @click.stop>
    <input
      type="checkbox"
      :checked="comp.clip.loop"
      :disabled="!comp.clip.clip"
      @change="emit('update', 'Set Anim Loop', ($event.target as HTMLInputElement).checked)"
    />
    <span>循环播放</span>
  </label>
  <div class="field">
    <label>速度</label>
    <NumberField
      :model-value="comp.clip.speed"
      :step="0.1"
      :min="0.05"
      title="播放速度倍率"
      @commit="(v) => emit('update', 'Set Anim Speed', Math.max(0.05, v))"
    />
  </div>

  <button
    class="anim-open-editor"
    :disabled="!comp.clip.clip"
    title="在动画编辑窗口中打开该剪辑（底部停靠区）"
    @click="openInAnimEditor(comp.clip.clip)"
  >
    在动画编辑器中打开
  </button>
  <div v-if="!comp.clip.clip" class="hint">未绑定剪辑：绑定后预览/发布时自动应用关键帧动画。</div>
</template>
