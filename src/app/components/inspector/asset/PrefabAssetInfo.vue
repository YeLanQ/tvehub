<script setup lang="ts">
// ---------------------------------------------------------------------------
// 预制体概览块（展示型，从 AssetInspector 抽出）：节点数 + 「实例化到场景」按钮 +
// 使用提示。节点数由父组件读取预制体文本后传入（读取中为 null，显示占位）；
// 实例化动作上抛父组件（要有项目根 + 概览就绪才可点，与拆分前同一禁用条件）。
// ---------------------------------------------------------------------------
defineProps<{
  /** 预制体概览（节点数；读取失败/读取中为 null） */
  info: { nodes: number } | null;
  /** 项目根路径（空则不满足实例化条件） */
  root: string | null;
}>();

const emit = defineEmits<{
  /** 实例化到当前场景（父组件执行 instantiatePrefabAsset） */
  instantiate: [];
}>();
</script>

<template>
  <div class="field">
    <label>节点数</label>
    <span>{{ info ? info.nodes : "读取中…" }}</span>
  </div>
  <button
    class="prefab-instantiate"
    :disabled="!info || !root"
    title="实例化到当前场景（挂到选中节点/根下）"
    @click="emit('instantiate')"
  >实例化到场景</button>
  <div class="hint">右键资产也可「实例化到场景」；层级面板选中实例可「更新预制体」回写资产。</div>
</template>

<style scoped>
.prefab-instantiate {
  width: 100%;
  height: 26px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text, #ddd);
  background: transparent;
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  cursor: pointer;
}
.prefab-instantiate:hover:not(:disabled) {
  color: var(--accent, #4a9eff);
  border-color: var(--accent, #4a9eff);
}
.prefab-instantiate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
