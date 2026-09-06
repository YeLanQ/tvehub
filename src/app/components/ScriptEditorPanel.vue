<script setup lang="ts">
// 脚本模式工作台：Monaco 标签页编辑器 + 状态栏（保存 = 写盘 + 内存编译 + props 解析）。
// 脚本的打开/新建入口在资产面板（双击 .ts 进入本视图；src 目录右键「新建脚本」）
// 与检查器（添加脚本组件菜单可新建）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import { confirm } from "../lib/confirm";
import { loadMonaco, ensureScriptModel, type MonacoNamespace } from "./script-editor/monaco-setup";
import "../../styles/components/script-editor.scss";

const scriptsStore = getScriptsStore();

const containerEl = ref<HTMLElement | null>(null);
const loading = ref(true);
const monaco = ref<MonacoNamespace | null>(null);
let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
const contentChangeDisposers = new Map<string, MonacoApi.IDisposable>();

const tabs = computed(() => scriptsStore.tabs);
const active = computed(() => scriptsStore.active);
const activeState = computed(() =>
  active.value ? scriptsStore.fileState(active.value) : undefined,
);

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Monaco 实例与模型挂接
// ---------------------------------------------------------------------------

function bindModel(rel: string): void {
  const m = monaco.value;
  if (!m || !scriptsStore.fileState(rel)) return;
  const model = ensureScriptModel(m, rel, scriptsStore.fileState(rel)!.source);
  if (!contentChangeDisposers.has(rel)) {
    contentChangeDisposers.set(
      rel,
      model.onDidChangeContent(() => scriptsStore.setContent(rel, model.getValue())),
    );
  }
  editor?.setModel(model);
}

onMounted(async () => {
  try {
    const m = await loadMonaco();
    monaco.value = m;
    await nextTick();
    if (!containerEl.value) return;
    editor = m.editor.create(containerEl.value, {
      theme: "vs-dark",
      language: "typescript",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "selection",
    });
    // Ctrl+S / Cmd+S 保存当前脚本
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
      if (active.value) void scriptsStore.saveScript(active.value);
    });
    if (active.value) bindModel(active.value);
    loading.value = false;
  } catch (e) {
    loading.value = false;
    logStore.log("error", `脚本编辑器初始化失败: ${e}`, "script");
  }
});

onBeforeUnmount(() => {
  contentChangeDisposers.forEach((d) => d.dispose());
  contentChangeDisposers.clear();
  editor?.dispose();
  editor = null;
});

// 激活页切换 → 换模型；新开标签 → 绑定模型
watch(active, (rel) => {
  if (rel) bindModel(rel);
  else editor?.setModel(null);
});
watch(tabs, (list) => {
  // 关闭的标签释放模型；激活页保证已绑定
  const m = monaco.value;
  if (!m) return;
  for (const rel of [...contentChangeDisposers.keys()]) {
    if (!list.includes(rel)) {
      contentChangeDisposers.get(rel)?.dispose();
      contentChangeDisposers.delete(rel);
      m.editor.getModel(m.Uri.parse("file:///" + rel))?.dispose();
    }
  }
  if (active.value) bindModel(active.value);
});

// ---------------------------------------------------------------------------
// 标签页操作
// ---------------------------------------------------------------------------

async function saveActive(): Promise<void> {
  if (!active.value) return;
  await scriptsStore.saveScript(active.value);
}

async function closeTab(rel: string): Promise<void> {
  if (scriptsStore.isDirty(rel)) {
    const ok = await confirm({
      title: "关闭未保存的脚本",
      message: `${baseName(rel)} 有未保存的修改，保存后关闭？`,
      confirmText: "保存并关闭",
      cancelText: "放弃修改",
    });
    if (ok) await scriptsStore.saveScript(rel);
  }
  scriptsStore.closeTab(rel);
}

const statusText = computed(() => {
  const rel = active.value;
  if (!rel) return "未打开脚本";
  const st = scriptsStore.fileState(rel);
  if (!st) return rel;
  if (st.compileError) return `编译失败：${st.compileError}`;
  return st.dirty ? "有未保存的修改（Ctrl+S 保存并编译）" : "已保存 · 编译通过";
});
</script>

<template>
  <div class="panel script-editor">
    <section class="script-main">
      <div class="script-tabs mono">
        <div
          v-for="rel in tabs"
          :key="rel"
          class="script-tab"
          :class="{ active: active === rel }"
          @click="scriptsStore.setActive(rel)"
        >
          <span class="tab-name">{{ baseName(rel) }}</span>
          <span v-if="scriptsStore.isDirty(rel)" class="dirty-dot"></span>
          <button class="tab-close" title="关闭" @click.stop="closeTab(rel)">×</button>
        </div>
        <div v-if="!tabs.length" class="script-tabs-empty muted">打开脚本：在资产面板双击 .ts 文件</div>
      </div>

      <div class="monaco-host">
        <div ref="containerEl" class="monaco-container"></div>
        <div v-if="loading" class="monaco-loading mono">正在加载脚本编辑器…</div>
        <div v-else-if="!active" class="monaco-empty mono muted">
          从资产面板打开或新建脚本
        </div>
      </div>

      <footer class="script-status mono">
        <span class="status-path">{{ active ?? "—" }}</span>
        <span class="status-state" :class="{ error: !!activeState?.compileError }">
          {{ statusText }}
        </span>
        <button class="status-save" :disabled="!active" @click="saveActive">保存并编译</button>
      </footer>
    </section>
  </div>
</template>
