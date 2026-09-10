<script setup lang="ts">
// ---------------------------------------------------------------------------
// 资产基本信息块（展示型，从 AssetInspector 抽出）：名称 / 路径 / 类型 + 大小 +
// 内置徽标与「复制到项目」按钮。只读展示；复制动作上抛父组件（父组件持有
// assetService 复制与选中逻辑、copying 进行中标记），本组件不接触写盘。
// ---------------------------------------------------------------------------
import { fmtSize } from "../../../lib/format";

defineProps<{
  /** 资产相对路径 */
  rel: string;
  /** 显示名（资产条目名；无条目时回退路径末段） */
  name: string;
  /** 资产类型（小写扩展名 / "dir"） */
  kind: string;
  /** 字节数（资产条目存在时有值，否则不显示大小） */
  size?: number;
  /** 内置资产（只读；提供「复制到项目」） */
  isInternal: boolean;
  /** 复制进行中（按钮置灰） */
  copying: boolean;
}>();

const emit = defineEmits<{
  /** 复制到项目（父组件执行复制并选中新资产） */
  copyToProject: [];
}>();
</script>

<template>
  <div class="field">
    <label>名称</label>
    <span class="type-tag">{{ name }}</span>
  </div>
  <div class="field">
    <label>路径</label>
    <span class="muted mono asset-rel">{{ rel }}</span>
  </div>
  <div class="field">
    <label>类型</label>
    <span class="type-tag">{{ kind }}</span>
    <span v-if="size !== undefined" class="muted">{{ fmtSize(size) }}</span>
    <span class="asset-badge" :class="{ internal: isInternal }">
      {{ isInternal ? "内置 · 只读" : "项目资产" }}
    </span>
    <button
      v-if="isInternal"
      class="asset-btn"
      :disabled="copying"
      title="复制为项目资产（可编辑）"
      @click="emit('copyToProject')"
    >
      复制到项目
    </button>
  </div>
</template>

<style scoped>
.asset-rel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.asset-badge {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.asset-badge.internal {
  border-color: var(--text-dim, #888);
  color: var(--text-dim, #888);
}
.asset-btn {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.asset-btn:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
</style>
