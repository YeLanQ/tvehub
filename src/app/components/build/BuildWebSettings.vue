<script setup lang="ts">
/**
 * 构建面板 · Web 渠道设置区：导出模板（可多选，形态互斥）、页面标题、gzip、
 * CDN、发布/调试模式。全部状态经 defineModel 双向绑定到面板（BuildPanel），
 * 本组件无自有状态；模板互斥切换的守卫与提示在此（toggleTemplate）。
 */
import { computed } from "vue";
import { logStore } from "../../stores/log";
import { resolveExportTemplate, type ExportTemplateInfo } from "../../lib/build";

const exportTemplates = defineModel<ExportTemplateInfo[]>("exportTemplates", { required: true });
const selectedTemplates = defineModel<string[]>("selectedTemplates", { required: true });
const gzip = defineModel<boolean>("gzip", { required: true });
const gzipBase = defineModel<string>("gzipBase", { required: true });
const cdn = defineModel<boolean>("cdn", { required: true });
const cdnBase = defineModel<string>("cdnBase", { required: true });
const title = defineModel<string>("title", { required: true });
const release = defineModel<boolean>("release", { required: true });
const debug = defineModel<boolean>("debug", { required: true });

/** 当前选中模板与产物形态（由首个选中模板的 mode 推导） */
const selectedTemplate = computed(() =>
  resolveExportTemplate(selectedTemplates.value[0], exportTemplates.value),
);
const singlePage = computed(() => selectedTemplate.value?.mode === "single");

/** CDN 模式已勾选但地址为空：不生效（three.js 仍内嵌），显式提示避免误解 */
const cdnMissingBase = computed(() => cdn.value && !cdnBase.value.trim());

/** 勾选/取消导出模板（可多选）；勾选与已选形态不同的模板时自动切换为仅选中它
 *  （多文件与单页不能混选——直接替换选择，避免"勾选被静默拒绝→选择为空→构建按钮
 *  一直禁用"的陷阱） */
function toggleTemplate(id: string, checked: boolean): void {
  const tpl = resolveExportTemplate(id, exportTemplates.value);
  if (!tpl) return;
  const set = new Set(selectedTemplates.value);
  if (checked) {
    const firstSel = resolveExportTemplate(selectedTemplates.value[0], exportTemplates.value);
    if (firstSel && firstSel.mode !== tpl.mode) {
      selectedTemplates.value = [tpl.id];
      logStore.log("info", `已切换导出模板为「${tpl.name}」（多文件与单页不能混选）`, "build");
      return;
    }
    set.add(id);
  } else {
    set.delete(id);
  }
  selectedTemplates.value = exportTemplates.value
    .filter((t) => set.has(t.id))
    .map((t) => t.id);
}
</script>

<template>
  <div class="bp-field col">
    <label>
      导出模板
      <span class="bp-label-hint">可多选，多文件与单页不能混选</span>
    </label>
    <div class="bp-tpl-list">
      <label
        v-for="t in exportTemplates"
        :key="t.id"
        class="bp-tpl"
        :class="{ active: selectedTemplates.includes(t.id) }"
        :title="t.description"
      >
        <input
          type="checkbox"
          :checked="selectedTemplates.includes(t.id)"
          @change="toggleTemplate(t.id, ($event.target as HTMLInputElement).checked)"
        />
        <span class="bp-tpl-name">
          {{ t.name }}<span v-if="t.user" class="bp-tpl-user" title="exe 旁 public 目录的自定义模板">自定义</span>
        </span>
        <span class="bp-mode" :class="t.mode">
          {{ t.mode === "single" ? "单页" : "多文件" }}
        </span>
      </label>
    </div>
  </div>
  <p class="bp-note">
    {{ singlePage
      ? "单页：场景、资产与全部运行时代码内联进单文件 index.html，产物只有一个 HTML。"
      : "多文件：场景与资产按相对路径落盘，适合部署到静态服务器。" }}
  </p>
  <div class="bp-field">
    <label for="bp-gzip">Gzip 压缩</label>
    <label class="bp-check">
      <input id="bp-gzip" v-model="gzip" type="checkbox" />
      <span>
        {{
          singlePage
            ? "资产与运行时代码 gzip 归档后内联（体积更小）"
            : "场景与资产打包为 assets.gzip 归档"
        }}
      </span>
    </label>
  </div>
  <div v-if="gzip && !singlePage" class="bp-field col">
    <label for="bp-gzip-base">
      gzip 资源地址
      <span class="bp-label-hint">归档远程基址</span>
    </label>
    <input
      id="bp-gzip-base"
      v-model="gzipBase"
      placeholder="https://res.example.com/pkg"
      spellcheck="false"
    />
    <p class="bp-note">
      非空时运行时从 <code>&lt;地址&gt;/assets.gzip</code>
      拉取归档（产物内仍生成归档，供上传 CDN，需允许跨域）；<strong
        >留空则与当前一致，按本地路径读取</strong
      >。
    </p>
  </div>
  <div class="bp-field">
    <label for="bp-cdn">CDN 模式</label>
    <label class="bp-check">
      <input id="bp-cdn" v-model="cdn" type="checkbox" />
      <span>不内嵌 three.js 运行时，改为从 Three CDN 地址在线加载</span>
    </label>
  </div>
  <div v-if="cdn" class="bp-field col">
    <label for="bp-cdn-base">
      Three CDN 地址
      <span class="bp-label-hint">three.js 远程基址</span>
    </label>
    <input
      id="bp-cdn-base"
      v-model="cdnBase"
      placeholder="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.185.1/"
      spellcheck="false"
    />
    <p class="bp-note">
      填写直接包含 three 构建文件的目录：官方 CDN 版本目录（如
      <code>https://cdnjs.cloudflare.com/ajax/libs/three.js/0.185.1/</code
      >，需与运行时同版本）或自建 CDN 上传产物 <code>engine/core/</code>
      内两个文件后的目录。非空时 three.js
      在线加载、不再内嵌（需允许跨域）；<strong>留空则仍内嵌 three.js</strong>。
    </p>
    <p v-if="cdnMissingBase" class="bp-warn">
      地址为空：CDN 模式不会生效，本次构建仍将内嵌 three.js。
    </p>
  </div>
  <div class="bp-field">
    <label for="bp-title">页面标题</label>
    <input id="bp-title" v-model="title" placeholder="项目名" />
  </div>
  <div class="bp-field">
    <label for="bp-release">发布模式</label>
    <label class="bp-check">
      <input id="bp-release" v-model="release" type="checkbox" />
      <span>使用uuid，压缩 JSON 与脚本库（与调试模式互斥）</span>
    </label>
  </div>
  <div class="bp-field">
    <label for="bp-debug">调试模式</label>
    <label class="bp-check">
      <input id="bp-debug" v-model="debug" type="checkbox" />
      <span>保留运行日志转发（与发布模式互斥）</span>
    </label>
  </div>
</template>
