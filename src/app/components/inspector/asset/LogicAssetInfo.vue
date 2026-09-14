<script setup lang="ts">
// ---------------------------------------------------------------------------
// 逻辑资产概览块（.fsm 状态机 / .bt 行为树；展示型，自读资产文本）：
// FSM 显示状态/过渡/入口状态；BT 显示节点数/根类型。
// 「打开编辑器」按钮上抛 open 事件（父组件调起可视化编辑器弹窗）。
// ---------------------------------------------------------------------------
import { ref, watch } from "vue";
import { api } from "../../../../lib/api";
import { parseFsmGraph, type FsmGraph } from "../../../../framework/fsm";
import { btNodeDef, countBtNodes, parseBehaviorTree, type BTNode } from "../../../../framework/behavior";

const props = defineProps<{
  /** 资产相对路径 */
  rel: string;
  /** 资产 kind（"fsm" | "bt"） */
  kind: string;
  /** 项目根（空 = 未打开项目，显示读取中） */
  root: string | null;
}>();

const emit = defineEmits<{ open: [] }>();

const fsm = ref<FsmGraph | null>(null);
const bt = ref<BTNode | null>(null);

watch(
  () => [props.root, props.rel, props.kind] as const,
  async () => {
    fsm.value = null;
    bt.value = null;
    if (!props.root) return;
    try {
      const text = await api.readText(props.root, props.rel);
      const doc = JSON.parse(text) as { graph?: unknown; tree?: unknown };
      if (props.kind === "fsm") fsm.value = parseFsmGraph(doc.graph);
      else bt.value = parseBehaviorTree(doc.tree);
    } catch {
      /* 读取失败保持 null（显示占位） */
    }
  },
  { immediate: true },
);
</script>

<template>
  <template v-if="kind === 'fsm' && fsm">
    <div class="field">
      <label>状态数</label>
      <span>{{ fsm.states.length }}</span>
    </div>
    <div class="field">
      <label>过渡数</label>
      <span>{{ fsm.transitions.length }}</span>
    </div>
    <div class="field">
      <label>入口状态</label>
      <span>{{ fsm.states.find((s) => s.id === fsm?.entry)?.name ?? "—" }}</span>
    </div>
  </template>
  <template v-else-if="kind === 'bt' && bt">
    <div class="field">
      <label>节点数</label>
      <span>{{ countBtNodes(bt) }}</span>
    </div>
    <div class="field">
      <label>根节点</label>
      <span>{{ btNodeDef(bt.type)?.label ?? bt.type }}</span>
    </div>
  </template>
  <div v-else class="hint">读取中…</div>
  <div class="hint">
    {{ kind === "fsm" ? "状态机" : "行为树" }}资产：双击资产或点击下方按钮打开可视化编辑器。
  </div>
  <button class="logic-open" @click="emit('open')">打开编辑器</button>
</template>

<style scoped>
.logic-open {
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
.logic-open:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
</style>
