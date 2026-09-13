<script setup lang="ts">
// ---------------------------------------------------------------------------
// 地形资产块（展示型 + 动作上抛，从 AssetInspector 拆出的模式）：
// 设置概览（种子/尺寸/网格/起伏/分形/侵蚀/配色）+ 添加到场景。
// 概览由父组件读取 .terrain 文本解析后传入（读取中/失败为 null，显示占位）。
// ---------------------------------------------------------------------------

defineProps<{
  /** 地形设置（读取中/失败为 null） */
  settings: Record<string, number> | null;
  /** 内置只读资产（隐藏「添加到场景」动作由父级守卫，这里仅展示说明） */
  readonly?: boolean;
}>();

const emit = defineEmits<{ addToScene: [] }>();
</script>

<template>
  <template v-if="settings">
    <div class="field">
      <label>种子</label>
      <span>{{ settings.seed }}</span>
    </div>
    <div class="field">
      <label>地表</label>
      <span>{{ settings.size }} × {{ settings.size }}（{{ settings.segments }} 段）</span>
    </div>
    <div class="field">
      <label>起伏</label>
      <span>±{{ settings.heightScale }}</span>
    </div>
    <div class="field">
      <label>分形</label>
      <span>{{ settings.octaves }} 层 · 频率 {{ settings.frequency }} · 腐蚀 {{ settings.erosion }}</span>
    </div>
    <div class="field">
      <label>配色</label>
      <span class="ts-swatches">
        <i :style="{ background: `#${(settings.grassColor ?? 0).toString(16).padStart(6, '0')}` }" />
        <i :style="{ background: `#${(settings.rockColor ?? 0).toString(16).padStart(6, '0')}` }" />
        <i :style="{ background: `#${(settings.snowColor ?? 0).toString(16).padStart(6, '0')}` }" />
      </span>
    </div>
    <button v-if="!readonly" class="ts-add" @click="emit('addToScene')">添加到场景</button>
    <div class="hint">
      {{ readonly ? "内置资产只读：可「复制到项目」后使用。" : "作为地形节点加入当前场景（设置快照到节点，节点检查器可继续调整并存回）。" }}
    </div>
  </template>
  <div v-else class="hint">读取中…</div>
</template>

<style scoped>
.ts-swatches {
  display: inline-flex;
  gap: 3px;
}
.ts-swatches i {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  display: inline-block;
}
.ts-add {
  margin: 6px 0 2px;
  font-size: 11px;
  line-height: 1.4;
  padding: 4px 10px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ts-add:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
</style>
