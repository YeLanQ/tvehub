<script setup lang="ts">
// ---------------------------------------------------------------------------
// 着色器资产字段块（展示型，从 AssetInspector 抽出）：渲染分支（Base 声明，创建时
// 由模板决定）+ 钩子清单（Hook 名 + 行数）+ 暴露属性表（键 + 标签 · 类型）+
// 解析错误 + 「编辑源码」入口 + 源码全文展示（pre）。
// 着色器是自定义着色效果的唯一载体：Base 选渲染分支（PBR/Unlit/卡通），Hook 是
// 叠加在该分支上的效果片段，Properties 是材质卡片可调的参数。
// 只展示与上抛：源码编辑器弹层与保存回写由父组件持有（保存后写引擎缓存并刷新）。
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

/** 属性类型显示名（属性表列表用） */
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

/** 是否天空程序（内置资产；不参与效果着色器管线） */
const isSky = computed(() => !props.doc.base && props.doc.hooks.length === 0);
</script>

<template>
  <div class="field">
    <label>渲染分支</label>
    <span class="type-tag">{{ shaderKindLabel(doc.kind) }}</span>
  </div>
  <template v-if="!isSky">
    <div class="field">
      <label>Base 声明</label>
      <span class="muted">{{ doc.base || "（未声明）" }}</span>
    </div>
    <div v-if="doc.error" class="hint hint-error">
      解析失败（材质仍按 Base 分支渲染，只是不叠加效果）：{{ doc.error }}
    </div>
    <div class="field">
      <label>钩子</label>
      <span class="muted">{{ doc.hooks.length }} 个</span>
    </div>
    <div v-for="h in doc.hooks" :key="h.name" class="field shader-hook-row">
      <span class="mono shader-hook-name">{{ h.name }}</span>
      <span class="muted">{{ h.code.split("\n").length }} 行</span>
    </div>
    <div class="field">
      <label>暴露属性</label>
      <span class="muted">{{ doc.properties.length }} 项</span>
    </div>
    <div v-for="p in doc.properties" :key="p.key" class="field shader-prop-row">
      <span class="mono shader-prop-key">{{ p.key }}</span>
      <span class="muted">{{ p.label }} · {{ propKindLabel(p.kind) }}</span>
    </div>
    <button
      v-if="!isInternal"
      class="shader-edit-btn"
      title="打开源码编辑器（Monaco GLSL；Ctrl+S 保存并重新解析 Base/Hook/属性）"
      @click="emit('editSource')"
    >编辑源码</button>
  </template>
  <pre class="shader-source mono">{{ doc.source }}</pre>
  <div class="hint">
    {{ isInternal
      ? "内置着色器只读；可「复制到项目」生成项目内副本，或作为新建着色器的模板。"
      : isSky
        ? "内置天空程序：由天空材质引用，无效果着色器入口。"
        : "Base 决定材质走哪个渲染分支（PBR/Unlit/卡通），Hook 是在该分支上叠加的效果片段；Properties 即材质卡片暴露的参数（值存 .mat 的 props）。" }}
  </div>
</template>

<style scoped>
.shader-hook-row,
.shader-prop-row {
  gap: 6px;
}
.shader-hook-name,
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
.shader-source {
  margin: 2px 0 4px;
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
