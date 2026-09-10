<script setup lang="ts">
/**
 * 着色器源码编辑器（弹层；自定义着色器的 GLSL 顶点/片元 + 全部 ShaderLab 源文件）：
 * - Monaco 以 GLSL 语法着色（monaco-setup 注册的 tve-glsl），Ctrl+S 保存；
 * - 保存走后端 shader_write_source（Shader 指令跟随路径 + 解析校验 + 自动补 .meta），
 *   返回的文档（属性表/程序/组装错误）由调用方写引擎着色器缓存并刷新面板与视口；
 * - 组装错误（缺块/入口函数缺失）不阻断保存，仅提示，便于边写边改。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { saveShaderSource } from "../../lib/shaders";
import { logStore } from "../../stores/log";
import { getProjectStore } from "../../stores/project";
import type { ShaderDoc } from "../../../framework/material";
import {
  ensureShaderModel,
  loadMonaco,
  registerGlslLanguage,
  type MonacoNamespace,
} from "../script-editor/monaco-setup";

const props = defineProps<{
  /** 着色器资产相对路径（保存目标） */
  rel: string;
  /** 初始源码（资产检查器已读取的文档文本） */
  source: string;
}>();

const emit = defineEmits<{
  close: [];
  /** 保存成功（返回后端重新解析后的文档，含属性/程序/组装错误） */
  saved: [doc: ShaderDoc];
}>();

const projectStore = getProjectStore();

const containerEl = ref<HTMLElement | null>(null);
const monaco = ref<MonacoNamespace | null>(null);
const loading = ref(true);
const saving = ref(false);
/** 未保存标记（模型内容与初始源码不一致） */
const dirty = ref(false);
/** 上次保存返回的组装错误（null = 无错误） */
const assemblyError = ref<string | null>(null);
let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let model: MonacoApi.editor.ITextModel | null = null;
let contentDisposer: MonacoApi.IDisposable | null = null;
let keydownDisposer: MonacoApi.IDisposable | null = null;

const title = computed(() => props.rel.split("/").pop() ?? props.rel);

async function save(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !model || saving.value) return;
  saving.value = true;
  try {
    const doc = await saveShaderSource(root, props.rel, model.getValue());
    assemblyError.value = doc.error;
    dirty.value = false;
    logStore.log(
      "success",
      `已保存着色器 ${props.rel}（${doc.kind}${doc.properties.length ? ` · ${doc.properties.length} 个属性` : ""}）`,
      "engine",
    );
    emit("saved", doc);
  } catch (e) {
    logStore.log("error", `保存着色器 ${props.rel} 失败: ${e}`, "engine");
  } finally {
    saving.value = false;
  }
}

/** 恢复为打开时的源码（丢弃未保存修改） */
function reset(): void {
  if (!model) return;
  model.setValue(props.source);
}

function onKeydown(e: KeyboardEvent): void {
  // 模态层：Esc 关闭且不向编辑器其它快捷键泄漏
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
  }
}

onMounted(async () => {
  try {
    const m = await loadMonaco();
    registerGlslLanguage(m);
    monaco.value = m;
    await nextTick();
    if (!containerEl.value) return;
    model = ensureShaderModel(m, props.rel, props.source);
    contentDisposer = model.onDidChangeContent(() => {
      dirty.value = model ? model.getValue() !== props.source : false;
    });
    editor = m.editor.create(containerEl.value, {
      theme: "tve-dark",
      language: "tve-glsl",
      model,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 4,
      bracketPairColorization: { enabled: true },
      renderLineHighlight: "all",
      renderWhitespace: "selection",
      smoothScrolling: true,
      padding: { top: 6, bottom: 6 },
    });
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void save());
    keydownDisposer = editor.onKeyDown((e) => {
      if (e.keyCode === m.KeyCode.Escape) {
        e.stopPropagation();
        emit("close");
      }
    });
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  contentDisposer?.dispose();
  keydownDisposer?.dispose();
  editor?.dispose();
  editor = null;
});

// 捕获阶段监听：Esc 在打开期间被吞掉（不触发编辑器全局快捷键）
window.addEventListener("keydown", onKeydown, true);

/** 外部源码变化（如资产被重新加载）后同步模型内容 */
watch(
  () => props.source,
  (v) => {
    if (model && !dirty.value) model.setValue(v);
  },
);
</script>

<template>
  <div class="shader-modal-backdrop" @click.self="emit('close')">
    <div class="shader-modal">
      <div class="shader-modal-head">
        <span class="shader-modal-title">
          着色器源码 · <span class="mono">{{ title }}</span>
        </span>
        <span v-if="dirty" class="shader-modal-dirty">未保存</span>
        <span class="shader-modal-rel mono">{{ rel }}</span>
        <button
          class="shader-modal-btn primary"
          :disabled="saving || !dirty"
          :title="dirty ? '保存源码（Ctrl+S）：写盘 + 重新组装程序并刷新视口' : '源码无改动'"
          @click="save"
        >
          {{ saving ? "保存中…" : "保存" }}
        </button>
        <button
          class="shader-modal-btn"
          :disabled="!dirty"
          title="丢弃未保存修改，恢复为打开时的源码"
          @click="reset"
        >
          重置
        </button>
        <button class="shader-modal-close" title="关闭（Esc）" @click="emit('close')">✕</button>
      </div>
      <div v-if="assemblyError" class="shader-modal-error">
        组装失败（已保存，视口回退占位材质）：{{ assemblyError }}
      </div>
      <div class="shader-modal-body">
        <div ref="containerEl" class="shader-modal-editor"></div>
        <div v-if="loading" class="shader-modal-loading">编辑器加载中…</div>
      </div>
      <div class="shader-modal-foot">
        Shader 指令名 = 资产路径去扩展名（保存时自动同步）；
        Properties 项由引擎自动声明为 uniform，内置 <span class="mono">_Time</span> 为运行秒数。
      </div>
    </div>
  </div>
</template>

<style scoped>
.shader-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.shader-modal {
  display: flex;
  flex-direction: column;
  width: min(1080px, 92vw);
  height: min(760px, 88vh);
  background: #1e1e1e;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.shader-modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #252526;
  border-bottom: 1px solid var(--border, #333);
}
.shader-modal-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text, #ddd);
}
.shader-modal-dirty {
  font-size: 11px;
  color: #e0b878;
}
.shader-modal-rel {
  flex: 1 1 auto;
  font-size: 11px;
  color: var(--text-dim, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shader-modal-btn {
  flex: none;
  font-size: 11px;
  padding: 3px 10px;
  background: #3c3c3c;
  color: var(--text, #ddd);
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  cursor: pointer;
}
.shader-modal-btn:hover:not(:disabled) {
  background: #4a4a4a;
}
.shader-modal-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.shader-modal-btn.primary:not(:disabled) {
  background: #0e639c;
  border-color: #1177bb;
  color: #fff;
}
.shader-modal-btn.primary:hover:not(:disabled) {
  background: #1177bb;
}
.shader-modal-close {
  flex: none;
  width: 22px;
  height: 22px;
  background: transparent;
  color: var(--text-dim, #999);
  border: none;
  cursor: pointer;
  font-size: 13px;
}
.shader-modal-close:hover {
  color: var(--text, #ddd);
}
.shader-modal-error {
  padding: 6px 10px;
  font-size: 11px;
  color: #e08080;
  background: rgba(224, 128, 128, 0.08);
  border-bottom: 1px solid var(--border, #333);
}
.shader-modal-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.shader-modal-editor {
  position: absolute;
  inset: 0;
}
.shader-modal-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-dim, #999);
  background: #1e1e1e;
}
.shader-modal-foot {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--text-dim, #999);
  background: #252526;
  border-top: 1px solid var(--border, #333);
}
.mono {
  font-family: Consolas, "Cascadia Mono", monospace;
}
</style>
