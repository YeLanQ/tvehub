<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页·「偏好设置」分区：顶部类别栏（主题/项目/关于）与对应设置卡片。
// - 主题：颜色项清单展示（编辑器仅深色主题，自定义与持久化待接入）；
// - 项目：默认项目位置（新建项目默认父目录，「浏览…」复用项目 store 的目录选择，
//   经 lib/default-project-dir 持久化到应用配置目录，挂载时读取一次）；
// - 关于：版本信息 + 第三方依赖开源许可清单（动态清单见 src/generated/
//   license-registry.ts，由 scripts/sync-licenses.mjs 扫描 public/licenses/ 生成；
//   「查看全文」按需 fetch 副本文本，许可正文不进主包）。
// 主题色定义与类别清单见 lib/home-helpers。
// ---------------------------------------------------------------------------
import { onMounted, onUnmounted, ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getProjectStore } from "../../stores/project";
import { PREFS_CATS, THEME_COLOR_DEFS } from "../../lib/home-helpers";
import {
  loadDefaultProjectDir,
  saveDefaultProjectDir,
} from "../../lib/default-project-dir";
import {
  DEPENDENCY_LICENSES,
  type DependencyLicense,
} from "../../../generated/license-registry";
import { isTauri } from "../../../lib/tauri-env";

const projectStore = getProjectStore();

/** 应用显示版本（构建期注入；改版本只需改 src-tauri/tauri.conf.json 的 version） */
const APP_VERSION = __APP_VERSION__;

const prefsCat = ref("theme");

/** 默认项目位置（新建项目默认父目录） */
const defaultProjectDir = ref("");
const prefBusy = ref(false);

onMounted(() => {
  void loadDefaultProjectDir().then((dir) => {
    defaultProjectDir.value = dir;
  });
});

async function browseDefaultDir() {
  prefBusy.value = true;
  try {
    const dir = await projectStore.pickFolder();
    if (dir) {
      defaultProjectDir.value = dir;
      await saveDefaultProjectDir(dir);
    }
  } finally {
    prefBusy.value = false;
  }
}

async function onChangeDefaultDir() {
  await saveDefaultProjectDir(defaultProjectDir.value);
}

// ---- 第三方依赖许可清单（关于）----

/** 详情弹窗：当前条目 / 选中的副本文件 / 正文文本 */
const licEntry = ref<DependencyLicense | null>(null);
const licFile = ref("");
const licText = ref("");
const licLoading = ref(false);
const licError = ref("");

function openLicense(entry: DependencyLicense) {
  licEntry.value = entry;
  licFile.value = entry.files[0]?.name ?? "";
  void loadLicenseText();
}

function closeLicense() {
  licEntry.value = null;
  licText.value = "";
  licError.value = "";
}

/** 读取副本正文（public/licenses 下，站内路径；dev 由静态服务，prod 随 dist 打包） */
async function loadLicenseText() {
  const file = licEntry.value?.files.find((f) => f.name === licFile.value);
  licText.value = "";
  licError.value = "";
  if (!file) return;
  licLoading.value = true;
  try {
    const res = await fetch(`/${file.path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    licText.value = await res.text();
  } catch (e) {
    licError.value = e instanceof Error ? e.message : String(e);
  } finally {
    licLoading.value = false;
  }
}

/** 外链（上游主页）：桌面端经 opener 打开，浏览器环境直接开新窗口 */
function openHomepage(url: string) {
  if (isTauri()) void openUrl(url).catch(() => {});
  else window.open(url, "_blank", "noreferrer");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && licEntry.value) closeLicense();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h2>偏好设置</h2>
        <p class="sub">编辑器外观与默认项目位置</p>
      </div>
    </div>

    <!-- 顶部类别栏 -->
    <div class="prefs-tabs">
      <button
        v-for="c in PREFS_CATS"
        :key="c.id"
        class="prefs-tab"
        :class="{ active: prefsCat === c.id }"
        @click="prefsCat = c.id"
      >
        {{ c.label }}
      </button>
    </div>

    <!-- 主题设置 -->
    <template v-if="prefsCat === 'theme'">
      <div class="settings-card">
        <h3>主题</h3>
        <div class="theme-colors">
          <div class="theme-color-grid">
            <div
              v-for="def in THEME_COLOR_DEFS"
              :key="def.label"
              class="theme-color-item"
            >
              <span class="theme-color-label">{{ def.label }}</span>
              <input class="color-input" type="color" :value="def.defaultValue" />
              <span class="mono color-hex">{{ def.defaultValue }}</span>
              <button class="tpl-remove theme-color-reset">重置</button>
            </div>
          </div>
          <div class="theme-color-actions">
            <button>全部重置</button>
          </div>
        </div>
        <p class="hint">编辑器仅提供深色主题；颜色自定义与持久化待接入。</p>
      </div>
    </template>

    <!-- 项目设置 -->
    <template v-if="prefsCat === 'project'">
      <div class="settings-card">
        <h3>项目</h3>
        <div class="set-row">
          <label>默认项目位置</label>
          <input
            v-model="defaultProjectDir"
            type="text"
            placeholder="选择新建项目的默认父目录"
            @change="onChangeDefaultDir"
          />
          <button :disabled="prefBusy" @click="browseDefaultDir">
            {{ prefBusy ? "打开中…" : "浏览…" }}
          </button>
        </div>
        <p class="hint">新建项目时默认使用该位置；留空则每次手动选择。</p>
      </div>
    </template>

    <!-- 关于 -->
    <template v-if="prefsCat === 'about'">
      <div class="settings-card">
        <h3>关于</h3>
        <div class="about-row">
          <!-- 显示版本自动注入（vite define __APP_VERSION__，来源 src-tauri/tauri.conf.json） -->
          <span>v{{ APP_VERSION }}</span>
          <span class="dim">开发测试版</span>
        </div>

        <!-- 第三方依赖开源许可（清单动态生成：public/licenses/** → license-registry） -->
        <div class="license-block">
          <div class="license-head">
            <h4>开源许可</h4>
            <span class="dim">第三方依赖 {{ DEPENDENCY_LICENSES.length }} 项</span>
          </div>
          <p class="hint">
            许可证副本随应用分发（public/licenses）；点击条目查看全文，上游未随附正文的条目注明来源。
          </p>
          <div class="license-list">
            <button
              v-for="l in DEPENDENCY_LICENSES"
              :key="l.id"
              class="license-row"
              @click="openLicense(l)"
            >
              <span class="license-name">{{ l.name }}</span>
              <span class="mono license-version">{{ l.version }}</span>
              <span class="license-tag">{{ l.license }}</span>
              <span class="dim license-action">
                {{ l.files.length ? "查看全文" : "见上游" }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 许可详情弹窗 -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="licEntry" class="lic-backdrop" @click.self="closeLicense">
          <div class="lic-modal" role="dialog" aria-modal="true" aria-label="开源许可详情">
            <div class="lic-head">
              <div class="lic-head-info">
                <div class="lic-title">
                  {{ licEntry.name }}
                  <span class="mono license-version">{{ licEntry.version }}</span>
                </div>
                <div class="lic-sub">
                  <span class="license-tag">{{ licEntry.license }}</span>
                  <button
                    v-if="licEntry.homepage"
                    class="lic-link"
                    :title="licEntry.homepage"
                    @click="openHomepage(licEntry.homepage!)"
                  >
                    {{ licEntry.homepage }}
                  </button>
                  <span v-if="licEntry.source" class="dim mono">{{ licEntry.source }}</span>
                </div>
              </div>
              <button class="lic-close" title="关闭" @click="closeLicense">✕</button>
            </div>

            <div v-if="licEntry.note" class="lic-note">{{ licEntry.note }}</div>

            <div v-if="licEntry.files.length > 1" class="lic-files">
              <button
                v-for="f in licEntry.files"
                :key="f.name"
                class="lic-file"
                :class="{ active: licFile === f.name }"
                @click="
                  licFile = f.name;
                  loadLicenseText();
                "
              >
                {{ f.name }}
              </button>
            </div>

            <div class="lic-body">
              <div v-if="!licEntry.files.length" class="lic-empty">
                上游包未随附许可证正文{{ licEntry.homepage ? "，请见上游仓库" : "" }}。
              </div>
              <div v-else-if="licLoading" class="lic-empty">读取中…</div>
              <div v-else-if="licError" class="lic-empty">读取失败：{{ licError }}</div>
              <pre v-else class="lic-text mono">{{ licText }}</pre>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>
