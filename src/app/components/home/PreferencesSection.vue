<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页·「偏好设置」分区：顶部类别栏（主题/项目/关于）与对应设置卡片。
// - 主题：颜色项清单展示（编辑器仅深色主题，自定义与持久化待接入）；
// - 项目：默认项目位置（新建项目默认父目录，「浏览…」复用项目 store 的目录选择，
//   经 lib/default-project-dir 持久化到应用配置目录，挂载时读取一次）；
// - 关于：版本信息。
// 主题色定义与类别清单见 lib/home-helpers。
// ---------------------------------------------------------------------------
import { onMounted, ref } from "vue";
import { getProjectStore } from "../../stores/project";
import { PREFS_CATS, THEME_COLOR_DEFS } from "../../lib/home-helpers";
import {
  loadDefaultProjectDir,
  saveDefaultProjectDir,
} from "../../lib/default-project-dir";

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
      </div>
    </template>
  </section>
</template>
