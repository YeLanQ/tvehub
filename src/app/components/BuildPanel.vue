<script setup lang="ts">
/**
 * 构建导出面板：左栏渠道卡片 + 右栏配置区）：
 * - 通用设置：构建场景多选（默认全选）、主场景；
 * - 渠道设置：Web（页面标题/调试模式）；微信小游戏（占位，构建按钮禁用）；
 * - 构建 → Rust 把选中场景 + 引用资产 + 网页运行时打包到 <项目>/build/<渠道>/；
 * - 结果区展示产物信息与缺失资产，支持「打开构建目录」「浏览器预览」。
 * 构建配置归属项目自身（项目根 build.config.json）；重开面板读回配置与 pack-manifest 结果。
 */
import { computed, onMounted, ref, watch } from "vue";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import {
  BUILD_CHANNELS,
  BUILD_CONFIG_REL,
  defaultExportTemplateId,
  loadBuildPrefs,
  saveBuildPrefs,
  resolveExportTemplate,
  runBuild,
  openBuildDir,
  previewBuildInBrowser,
  type BuildChannel,
  type BuildPrefs,
} from "../lib/build-export";
import { api, type BuildResult } from "../../lib/api";
import { logStore } from "../stores/log";
import { WEB_EXPORT_TEMPLATES } from "../../generated/template-registry";
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
/** 导出模板 id（模板 mode 决定产物形态：multi=多文件 / single=单页） */
const template = ref(defaultExportTemplateId());
/** 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联 gzip 包） */
const gzip = ref(false);

/** 当前选中模板与产物形态（由模板 mode 推导） */
const selectedTemplate = computed(() => resolveExportTemplate(template.value));
const singlePage = computed(() => selectedTemplate.value?.mode === "single");

const building = ref(false);
const result = ref<BuildResult | null>(null);
const resultSource = ref<"fresh" | "persisted" | null>(null);

const currentChannel = computed(
  () => BUILD_CHANNELS.find((c) => c.id === channel.value) ?? BUILD_CHANNELS[0],
);
const canBuild = computed(
  () => currentChannel.value.supported && selectedScenes.value.length > 0 && !building.value,
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
    template.value = resolveExportTemplate(prefs.template)?.id ?? defaultExportTemplateId();
    gzip.value = prefs.gzip;
  } else {
    channel.value = "web";
    selectedScenes.value = [...scenes];
    mainScene.value = "";
    title.value = "";
    debug.value = true;
    template.value = defaultExportTemplateId();
    gzip.value = false;
  }
  if (!selectedScenes.value.includes(mainScene.value)) {
    mainScene.value =
      projectStore.sceneRel && selectedScenes.value.includes(projectStore.sceneRel)
        ? projectStore.sceneRel
        : (selectedScenes.value[0] ?? "");
  }
  if (!title.value.trim()) title.value = projectStore.projectName ?? "";

  result.value = null;
  resultSource.value = null;
  if (!root) return;
  // 尝试读回上次构建的自描述清单（无则保持"未构建"）
  void (async () => {
    try {
      const text = await api.readText(root, `build/${channel.value}/pack-manifest.json`);
      const m = JSON.parse(text) as Record<string, unknown>;
      const name = (v: unknown) => (typeof v === "string" ? v : "");
      result.value = {
        ok: true,
        channel: name(m.channel) || channel.value,
        output_dir: `${root}\\build\\${name(m.channel) || channel.value}`,
        main_scene: name(m.main_scene),
        main_scene_name: name(m.main_scene_name),
        scenes: Array.isArray(m.scenes)
          ? (m.scenes as BuildResult["scenes"])
          : [],
        single_page: m.singlePage === true,
        gzip: m.gzip === true,
        assets_packed: typeof m.assets_packed === "number" ? m.assets_packed : 0,
        missing: Array.isArray(m.missing) ? (m.missing as string[]) : [],
        message: "上次构建结果",
      };
      resultSource.value = "persisted";
    } catch {
      /* 从未构建过 */
    }
  })();
}

async function persistPrefs(): Promise<void> {
  const prefs: BuildPrefs = {
    channel: channel.value,
    scenes: selectedScenes.value,
    mainScene: mainScene.value,
    title: title.value,
    debug: debug.value,
    template: template.value,
    gzip: gzip.value,
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
  try {
    const res = await runBuild({
      root,
      channel: channel.value,
      scenes: selectedScenes.value,
      mainScene: mainScene.value,
      title: title.value,
      debug: debug.value,
      template: template.value,
      gzip: gzip.value,
    });
    result.value = res;
    resultSource.value = "fresh";
    await persistPrefs();
  } catch (e) {
    logStore.log("error", `构建失败: ${e}`, "build");
  } finally {
    building.value = false;
  }
}

function openDir(): void {
  if (result.value) void openBuildDir(result.value.output_dir);
}

function previewInBrowser(): void {
  const root = projectStore.currentPath;
  if (!root || !result.value) return;
  void previewBuildInBrowser(root, channel.value, result.value.main_scene_name);
}

onMounted(() => {
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
  void restoreState();
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
              <div class="bp-field">
                <label>导出模板</label>
                <div class="bp-tpl-list">
                  <label
                    v-for="t in WEB_EXPORT_TEMPLATES"
                    :key="t.id"
                    class="bp-tpl"
                    :class="{ active: template === t.id }"
                  >
                    <input v-model="template" type="radio" :value="t.id" name="bp-tpl" />
                    <span class="bp-tpl-name">
                      {{ t.name }}
                      <span class="bp-channel-badge">{{ t.mode === "single" ? "单页" : "多文件" }}</span>
                    </span>
                    <span class="bp-tpl-desc">{{ t.description }}</span>
                  </label>
                </div>
              </div>
              <p class="bp-note">
                {{ singlePage
                  ? "单页：场景与资产内联进 index.html（运行时代码保留为 player/libs 文件）。"
                  : "多文件：场景与资产按相对路径落盘，适合部署到静态服务器。" }}
              </p>
              <div class="bp-field">
                <label for="bp-gzip">Gzip 压缩</label>
                <label class="bp-check">
                  <input id="bp-gzip" v-model="gzip" type="checkbox" />
                  <span>
                    {{
                      singlePage
                        ? "资产 gzip 归档后内联（体积更小）"
                        : "场景与资产打包为 assets.gzip 归档"
                    }}
                  </span>
                </label>
              </div>
              <div class="bp-field">
                <label for="bp-title">页面标题</label>
                <input id="bp-title" v-model="title" placeholder="项目名" />
              </div>
              <div class="bp-field">
                <label for="bp-debug">调试模式</label>
                <label class="bp-check">
                  <input id="bp-debug" v-model="debug" type="checkbox" />
                  <span>保留运行日志转发（正式发布可关闭）</span>
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
            <div v-if="result" class="bp-result">
              <div class="bp-result-line">
                <span :class="resultSource === 'fresh' ? 'bp-ok' : 'bp-muted'">
                  {{ resultSource === "fresh" ? result.message : "上次构建结果" }}
                </span>
              </div>
              <div class="bp-result-line bp-muted">
                {{ result.single_page ? "单页" : "多文件" }}{{ result.gzip ? " · gzip" : "" }} ·
                场景 {{ result.scenes.length }} 个 · 资产 {{ result.assets_packed }} 项 · 主场景
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
        </div>
      </div>

      <div class="bp-foot">
        <span class="bp-hint">配置写入 <code>{{ BUILD_CONFIG_REL }}</code> · 产物写入 <code>build/{{ channel }}/</code></span>
        <button :disabled="!result" title="在文件管理器中打开构建目录" @click="openDir">
          打开构建目录
        </button>
        <button
          :disabled="!result"
          title="在浏览器中预览构建产物（本地静态服务）"
          @click="previewInBrowser"
        >
          浏览器预览
        </button>
        <button class="primary" :disabled="!canBuild" @click="doBuild">
          {{ building ? "构建中…" : "开始构建" }}
        </button>
      </div>
    </div>
  </div>
</template>
