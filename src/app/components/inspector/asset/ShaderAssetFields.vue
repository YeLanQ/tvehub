<script setup lang="ts">
// ---------------------------------------------------------------------------
// 着色器资产字段块（展示型，从 AssetInspector 抽出）：类型标签（创建时固定）+
// 自定义着色器的渲染状态摘要、组装错误、暴露属性表（键 + 标签 · 类型）+
// 「编辑源码」入口 + 源码全文展示（pre）+ 只读/种类说明。
// 只展示与上抛：源码编辑器弹层与保存回写由父组件持有（保存后写引擎缓存并刷新本卡片）。
// ---------------------------------------------------------------------------
import { computed } from "vue";
import {
  shaderKindLabel,
  type ShaderDoc,
  type ShaderPropertyKind,
} from "../../../../framework/material";

const props = defineProps<{
  /** 已读取的着色器文档（父组件仅在读到文档后渲染本组件） */
  doc: ShaderDoc;
  /** 只读（内置着色器；不提供「编辑源码」） */
  isInternal: boolean;
}>();

const emit = defineEmits<{
  /** 打开源码编辑器（弹层由父组件持有） */
  editSource: [];
}>();

/** 着色器属性类型显示名（属性表列表用） */
function propKindLabel(kind: ShaderPropertyKind): string {
  switch (kind) {
    case "color":
      return "颜色";
    case "range":
      return "范围";
    case "float":
      return "浮点";
    case "int":
      return "整数";
    case "vector":
      return "向量";
    default:
      return "贴图";
  }
}

/** 渲染状态摘要（自定义着色器 Tags/ZWrite/Cull 声明） */
const shaderStateText = computed(() => {
  const program = props.doc.program;
  if (!program) return "—";
  const parts = [program.state.transparent ? "半透明" : "不透明"];
  parts.push(program.state.depthWrite ? "写深度" : "不写深度");
  parts.push(
    program.state.side === "double"
      ? "双面"
      : program.state.side === "back"
        ? "只渲染背面"
        : "剔除背面",
  );
  return parts.join(" · ");
});
</script>

<template>
  <div class="field">
    <label>着色器类型</label>
    <span class="type-tag">{{ shaderKindLabel(doc.kind) }}</span>
  </div>
  <template v-if="doc.kind === 'custom'">
    <div class="field">
      <label>渲染状态</label>
      <span class="muted">{{ shaderStateText }}</span>
    </div>
    <div v-if="doc.error" class="hint hint-error">
      组装失败，引用它的材质显示占位材质：{{ doc.error }}
    </div>
    <div class="field">
      <label>暴露属性</label>
      <span class="muted">{{ doc.properties.length }} 项</span>
    </div>
    <div
      v-for="p in doc.properties"
      :key="p.key"
      class="field shader-prop-row"
    >
      <span class="mono shader-prop-key">{{ p.key }}</span>
      <span class="muted">{{ p.label }} · {{ propKindLabel(p.kind) }}</span>
    </div>
    <button
      v-if="!isInternal"
      class="shader-edit-btn"
      title="打开源码编辑器（Monaco GLSL；Ctrl+S 保存并重新组装程序）"
      @click="emit('editSource')"
    >编辑源码</button>
  </template>
  <pre class="shader-source mono">{{ doc.source }}</pre>
  <div class="hint">
    {{ isInternal
      ? "内置着色器只读；可「复制到项目」生成项目内副本，或由材质挂载引用。"
      : doc.kind === "custom"
        ? "自定义着色器：源码编译为 GLSL 程序渲染；Properties 即材质面板暴露的参数（值存 .mat）。"
        : "类型在创建时固定，不可切换；材质在「着色器」下拉中挂载此程序，按该渲染分支渲染。" }}
  </div>
</template>

<style scoped>
.shader-prop-row {
  gap: 6px;
}
.shader-prop-key {
  flex: none;
  font-size: 11px;
  color: var(--text, #ddd);
}
.shader-edit-btn {
  align-self: flex-start;
  margin: 4px 0 2px;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--accent, #4a9eff);
  background: transparent;
  color: var(--accent, #4a9eff);
  cursor: pointer;
}
.shader-edit-btn:hover {
  background: rgba(74, 158, 255, 0.12);
}
.shader-source {  margin: 2px 0 4px;
  padding: 8px 10px;
  max-height: 280px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text, #ddd);
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  user-select: text;
  cursor: text;
}
</style>
