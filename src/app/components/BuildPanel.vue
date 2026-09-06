<script setup lang="ts">
/**
 * 构建导出面板：左栏渠道卡片 + 右栏配置区）：
 * - 通用设置：构建场景多选（默认全选）、主场景；
 * - 渠道设置：Web（页面标题/调试模式）；微信小游戏（占位，构建按钮禁用）；
 * - 构建 → Rust 把选中场景 + 引用资产 + 网页运行时打包到 <项目>/build/<渠道>/；
 * - 结果区展示产物信息与缺失资产，支持「打开构建目录」；
 * - 预览复用编辑器「网页预览」的设计：本地静态服务（服务 build/<渠道>）+ 内嵌
 *   iframe + 在浏览器打开 + 停止。
 * 构建配置归属项目自身（项目根 build.config.json）；重开面板读回配置。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import {
  BUILD_CHANNELS,
  BUILD_CONFIG_REL,
  BUILTIN_EXPORT_TEMPLATES,
  defaultExportTemplateId,
  loadBuildPrefs,
  loadExportTemplates,
  saveBuildPrefs,
  resolveExportTemplate,
  runBuild,
  openBuildDir,
  type BuildChannel,
  type BuildPrefs,
  type ExportTemplateInfo,
} from "../lib/build-export";
import { api, type BuildResult } from "../../lib/api";
import { logStore } from "../stores/log";
import "../../styles/components/build-panel.scss";

const projectStore = getProjectStore();
const assetsStore = getAssetsStore();

/** 项目内可选构建场景（.scene 资产路径） */
const projectScenes = computed(() =>
  assetsStore.assets
    .filter((a) => a.kind === "scene" && !a.path.endsWith("/"))
    .map((a) => a.path),
);

const channel = ref<BuildChannel["id"]>("web");
const selectedScenes = ref<string[]>([]);
const mainScene = ref("");
const title = ref("");
const debug = ref(true);
/** 选中的导出模板 id 列表（可多选：首个生成 index.html，其余生成 index-<模板>.html；
 *  多文件与单页模板不能混选） */
const selectedTemplates = ref<string[]>([defaultExportTemplateId()]);
/** 构建错误（面板内直接可见，不再只写控制台） */
const buildError = ref("");
/** 导出模板（内置 + exe 旁自定义合并列表；onMounted 异步补全） */
const exportTemplates = ref<ExportTemplateInfo[]>(BUILTIN_EXPORT_TEMPLATES);
/** 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联 gzip 包） */
const gzip = ref(false);
/** 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩 */
const release = ref(false);
/** CDN 模式：three.js 运行时不内嵌，从 Three CDN 地址在线加载 */
const cdn = ref(false);
/** gzip 资源地址（assets.gzip 归档远程基址；空 = 本地读取） */
const gzipBase = ref("");
/** Three CDN 地址（three.js 远程基址，CDN 模式下生效；空 = 内嵌 three.js） */
const cdnBase = ref("");

// 调试/发布互斥：勾选其一自动取消另一个（两者都未选 = 标准构建）
watch(release, (v) => {
  if (v) debug.value = false;
});
watch(debug, (v) => {
  if (v) release.value = false;
});

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

const building = ref(false);
const result = ref<BuildResult | null>(null);
const resultSource = ref<"fresh" | "persisted" | null>(null);

const currentChannel = computed(
  () => BUILD_CHANNELS.find((c) => c.id === channel.value) ?? BUILD_CHANNELS[0],
);
const canBuild = computed(
  () =>
    currentChannel.value.supported &&
    selectedScenes.value.length > 0 &&
    selectedTemplates.value.length > 0 &&
    !building.value,
);
/** 输出目录预览：<项目>/build/<渠道> */
const outputDirPreview = computed(() => {
  const root = projectStore.currentPath ?? "<项目根>";
  return `${root}\\build\\${channel.value}`;
});

/** 勾选/取消场景；主场景被取消时回退到首个选中项 */
function toggleScene(rel: string, checked: boolean): void {
  const set = new Set(selectedScenes.value);
  if (checked) set.add(rel);
  else set.delete(rel);
  selectedScenes.value = projectScenes.value.filter((s) => set.has(s));
  if (!selectedScenes.value.includes(mainScene.value)) {
    mainScene.value = selectedScenes.value[0] ?? "";
  }
}

/** 打开面板时恢复项目构建配置与上次构建结果（均读项目目录） */
async function restoreState(): Promise<void> {
  const root = projectStore.currentPath;
  const scenes = projectScenes.value;
  const prefs = await loadBuildPrefs(root);
  if (prefs) {
    channel.value = prefs.channel;
    selectedScenes.value = scenes.filter((s) => prefs.scenes.includes(s));
    if (!selectedScenes.value.length) selectedScenes.value = [...scenes];
    mainScene.value = prefs.mainScene;
    title.value = prefs.title;
    debug.value = prefs.debug;
    selectedTemplates.value = exportTemplates.value
      .filter((t) => prefs.templates.includes(t.id))
      .map((t) => t.id);
    if (!selectedTemplates.value.length) {
      selectedTemplates.value = [defaultExportTemplateId()];
    }
    gzip.value = prefs.gzip;
    release.value = prefs.release;
    cdn.value = prefs.cdn;
    gzipBase.value = prefs.gzipBase;
    cdnBase.value = prefs.cdnBase;
    // 兼容旧配置（两者曾可同时为 true）：发布模式优先
    if (release.value) debug.value = false;
  } else {
    channel.value = "web";
    selectedScenes.value = [...scenes];
    mainScene.value = "";
    title.value = "";
    debug.value = true;
    selectedTemplates.value = [defaultExportTemplateId()];
    gzip.value = false;
    release.value = false;
    cdn.value = false;
    gzipBase.value = "";
    cdnBase.value = "";
  }
  if (!selectedScenes.value.includes(mainScene.value)) {
    mainScene.value =
      projectStore.sceneRel && selectedScenes.value.includes(projectStore.sceneRel)
        ? projectStore.sceneRel
        : (selectedScenes.value[0] ?? "");
  }
  if (!title.value.trim()) title.value = projectStore.projectName ?? "";
  result.value = null;
  buildError.value = "";
}

async function persistPrefs(): Promise<void> {
  const prefs: BuildPrefs = {
    channel: channel.value,
    scenes: selectedScenes.value,
    mainScene: mainScene.value,
    title: title.value,
    debug: debug.value,
    templates: selectedTemplates.value,
    gzip: gzip.value,
    release: release.value,
    cdn: cdn.value,
    gzipBase: gzipBase.value,
    cdnBase: cdnBase.value,
  };
  try {
    await saveBuildPrefs(projectStore.currentPath, prefs);
  } catch (e) {
    logStore.log("error", `保存构建配置失败: ${e}`, "build");
  }
}

async function doBuild(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !canBuild.value) return;
  building.value = true;
  buildError.value = "";
  try {
    const res = await runBuild({
      root,
      channel: channel.value,
      scenes: selectedScenes.value,
      mainScene: mainScene.value,
      title: title.value,
      debug: debug.value,
      templates: selectedTemplates.value,
      gzip: gzip.value,
      release: release.value,
      cdn: cdn.value,
      gzipBase: gzipBase.value,
      cdnBase: cdnBase.value,
    });
    result.value = res;
    resultSource.value = "fresh";
    await persistPrefs();
  } catch (e) {
    buildError.value = String(e);
    result.value = null;
    resultSource.value = null;
    logStore.log("error", `构建失败: ${e}`, "build");
  } finally {
    building.value = false;
  }
}

function openDir(): void {
  if (result.value) void openBuildDir(result.value.output_dir);
}

// ---- 预览（复用编辑器「网页预览」的设计：本地静态服务 + iframe + 浏览器打开）----
const previewBase = ref("");
const previewLoading = ref(false);
const previewKey = ref(0);
const previewUrl = computed(() =>
  previewBase.value
    ? `${previewBase.value}/index.html${
        result.value?.main_scene_name
          ? `?scene=${encodeURIComponent(result.value.main_scene_name)}`
          : ""
      }`
    : "",
);

/** 起本地静态服务（服务 build/<渠道>），内嵌 iframe 预览构建产物 */
async function startPreview(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !result.value || previewLoading.value) return;
  previewLoading.value = true;
  try {
    previewBase.value = await api.startWebPreviewServer(root, `build/${channel.value}`);
    previewKey.value++;
    logStore.log("info", `构建预览已启动: ${previewBase.value}/index.html`, "build");
  } catch (e) {
    logStore.log("error", `构建预览启动失败: ${e}`, "build");
  } finally {
    previewLoading.value = false;
  }
}

function refreshPreview(): void {
  previewKey.value++;
}

async function openInBrowser(): Promise<void> {
  if (!previewUrl.value) return;
  try {
    await openUrl(previewUrl.value);
  } catch (e) {
    logStore.log("error", `打开浏览器失败: ${e}`, "build");
  }
}

async function stopPreview(): Promise<void> {
  try {
    await api.stopWebPreview();
  } finally {
    previewBase.value = "";
    logStore.log("info", "构建预览服务已停止", "build");
  }
}

// 关闭面板即释放预览服务（与编辑器网页预览「离开页签即停」一致）
onUnmounted(() => {
  if (previewBase.value) void api.stopWebPreview().catch(() => {});
});

onMounted(async () => {
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
  exportTemplates.value = await loadExportTemplates();
  // 恢复配置放在模板列表就绪之后（模板 id 解析依赖列表）
  await restoreState();
});

// 场景资产变化（导入/新建场景后打开面板）时补齐默认勾选
watch(projectScenes, (next, prev) => {
  if (!prev) return;
  const added = next.filter((s) => !prev.includes(s));
  if (added.length) {
    const set = new Set(selectedScenes.value);
    for (const s of added) set.add(s);
    selectedScenes.value = next.filter((s) => set.has(s));
  }
});
</script>

<template>
  <div class="bp-backdrop">
    <div class="bp-modal">
      <div class="bp-head">
        <span class="bp-title">构建导出</span>
        <button class="bp-close" title="关闭" @click="projectStore.closeBuild()">✕</button>
      </div>

      <div class="bp-body">
        <!-- 左：构建渠道卡片 -->
        <nav class="bp-channels">
          <button
            v-for="c in BUILD_CHANNELS"
            :key="c.id"
            class="bp-channel"
            :class="{ active: channel === c.id }"
            :title="c.desc"
            @click="channel = c.id"
          >
            <span class="bp-channel-label">
              {{ c.label }}
              <span v-if="!c.supported" class="bp-channel-badge">即将支持</span>
            </span>
            <span class="bp-channel-desc">{{ c.desc }}</span>
          </button>
        </nav>

        <!-- 右：配置区 -->
        <div class="bp-content">
          <!-- 通用设置 -->
          <section class="bp-section">
            <h3 class="bp-section-title">通用设置</h3>
            <div class="bp-field">
              <label>构建场景</label>
              <div class="bp-scene-list">
                <div v-if="!projectScenes.length" class="bp-scene-empty">
                  项目内暂无 .scene 场景
                </div>
                <label
                  v-for="s in projectScenes"
                  :key="s"
                  class="bp-scene-item"
                  :title="s"
                >
                  <input
                    type="checkbox"
                    :checked="selectedScenes.includes(s)"
                    @change="toggleScene(s, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="bp-scene-name">{{ s }}</span>
                </label>
              </div>
            </div>
            <div class="bp-field">
              <label for="bp-main-scene">主场景</label>
              <select id="bp-main-scene" v-model="mainScene" :disabled="!selectedScenes.length">
                <option v-if="!selectedScenes.length" value="">请先选择构建场景</option>
                <option v-for="s in selectedScenes" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <p class="bp-note">主场景为构建产物的默认入口场景；产物内可用 <code>?scene=场景名</code> 切换其他场景。</p>
          </section>

          <!-- 渠道设置 -->
          <section class="bp-section">
            <h3 class="bp-section-title">渠道设置 · {{ currentChannel.label }}</h3>
            <template v-if="channel === 'web'">
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
                  >，需与运行时同版本）或自建 CDN 上传产物 <code>libs/</code>
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
            <p v-else class="bp-note">
              微信小游戏渠道即将支持：计划输出 game.json / adapter 与微信开发者工具所需的项目结构。
              当前可先用 Web 渠道验证内容。
            </p>
          </section>

          <!-- 输出与结果 -->
          <section class="bp-section">
            <h3 class="bp-section-title">输出</h3>
            <div class="bp-field">
              <label>输出目录</label>
              <code class="bp-outdir" :title="outputDirPreview">{{ outputDirPreview }}</code>
            </div>
            <div v-if="buildError" class="bp-result">
              <div class="bp-result-line bp-error">构建失败</div>
              <pre class="bp-err-detail">{{ buildError }}</pre>
            </div>
            <div v-else-if="result" class="bp-result">
              <div class="bp-result-line">
                <span :class="resultSource === 'fresh' ? 'bp-ok' : 'bp-muted'">
                  {{ resultSource === "fresh" ? result.message : "上次构建结果" }}
                </span>
              </div>
              <div class="bp-result-line bp-muted">
                {{ result.single_page ? "单页" : "多文件" }}{{ result.gzip ? " · gzip" : "" }}{{
                  result.release ? " · 发布" : ""
                }}{{ result.cdn ? " · CDN" : "" }}{{
                  result.bin_converted.length ? ` · 模型→bin ${result.bin_converted.length}` : ""
                }}
                · 场景 {{ result.scenes.length }} 个 · 资产 {{ result.assets_packed }} 项 · 主场景
                {{ result.main_scene_name || result.main_scene || "—" }}
              </div>
              <div v-if="result.missing.length" class="bp-missing">
                <span class="bp-missing-title">缺失资产（已跳过 {{ result.missing.length }} 项）：</span>
                <ul>
                  <li v-for="m in result.missing" :key="m">{{ m }}</li>
                </ul>
              </div>
            </div>
          </section>
          <!-- 预览（复用编辑器网页预览设计：本地静态服务 + 内嵌 iframe） -->
          <section v-if="previewBase" class="bp-section">
            <h3 class="bp-section-title">预览</h3>
            <div class="bp-preview-head">
              <input class="bp-preview-url mono" readonly :value="previewUrl" title="预览 URL" />
              <button class="bp-btn" title="重新加载预览" @click="refreshPreview">刷新</button>
              <button class="bp-btn" title="在默认浏览器中打开" @click="openInBrowser">在浏览器打开</button>
              <button class="bp-btn" title="停止预览服务" @click="stopPreview">停止</button>
            </div>
            <iframe
              :key="previewKey"
              :src="previewUrl"
              class="bp-preview-frame"
              title="构建预览"
            ></iframe>
          </section>
        </div>
      </div>

      <div class="bp-foot">
        <span class="bp-hint">配置写入 <code>{{ BUILD_CONFIG_REL }}</code> · 产物写入 <code>build/{{ channel }}/</code></span>
        <button :disabled="!result" title="在文件管理器中打开构建目录" @click="openDir">
          打开构建目录
        </button>
        <button
          :disabled="!result || previewLoading"
          title="在面板内预览构建产物（本地静态服务）"
          @click="startPreview"
        >
          {{ previewBase ? "重新预览" : "预览" }}
        </button>
        <button class="primary" :disabled="!canBuild" @click="doBuild">
          {{ building ? "构建中…" : "开始构建" }}
        </button>
      </div>
    </div>
  </div>
</template>
