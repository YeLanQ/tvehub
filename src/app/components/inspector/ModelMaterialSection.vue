<script setup lang="ts">
/**
 * 模型内嵌材质卡片（source=model 的网格）：
 * 只读列出模型自带的材质清单（名称 + 类型标签）——模型材质与缓存模板
 * （以及同模型的其它实例）共享，编辑会跨实例串改，因此不在编辑器内修改，
 * 需要调整时应在建模/DCC 软件中修改后重新导入。
 */
import { computed } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import type { ModelMaterialInfo } from "../../../framework/mesh";
import { getEditorStore } from "../../stores/editor";

const props = defineProps<{ node: MeshNode; rev?: number }>();

/** 内嵌材质清单（随 model:changed 的 rev 刷新） */
const materials = computed<ModelMaterialInfo[]>(() => {
  void props.rev;
  return props.node.model
    ? (getEditorStore().engine.models.metaFor(props.node.model)?.materials ?? [])
    : [];
});
</script>

<template>
  <div class="mmat-section" :data-rev="rev">
    <div class="mmat-count hint">{{ materials.length }} 个内嵌材质（随模型资产）</div>
    <div v-for="(m, i) in materials" :key="i" class="mmat-row">
      <span class="mmat-name" :title="m.name">{{ m.name }}</span>
      <span class="mmat-type mono">{{ m.type }}</span>
    </div>
    <div class="hint">材质内嵌于模型文件且多实例共享，编辑请在建模软件中修改后重新导入。</div>
  </div>
</template>

<style scoped>
.mmat-count {
  padding: 2px 0;
}
.mmat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.mmat-name {
  flex: 1 1 auto;
  min-width: 60px;
  font-size: 11px;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mmat-type {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--border, #444);
  color: var(--text-dim, #999);
}
</style>
