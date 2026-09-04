<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getProjectStore, type RecentProject } from "../stores/project";
import NewProjectDialog from "./NewProjectDialog.vue";
import "../../styles/components/home-view.scss";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { confirm } from "../lib/confirm";
import { BUILTIN_PROJECT_TEMPLATES, type ProjectTemplate } from "../lib/project-templates";
import { PREFS_CATS, THEME_COLOR_DEFS } from "../lib/home-helpers";

const projectStore = getProjectStore();

type Section = "projects" | "templates" | "prefs";
const section = ref<Section>("projects");
const prefsCat = ref("theme");

const showNewProject = ref(false);
const menuPath = ref<string | null>(null);
const busy = ref(false);

/** 工程模板（内置数据驱动；后续可接入后端自定义模板） */
const templates = ref<ProjectTemplate[]>(BUILTIN_PROJECT_TEMPLATES);

onMounted(() => {
  projectStore.refreshRecent();
});

async function browseAndOpen() {
  busy.value = true;
  try {
    const p = await projectStore.pickFolder();
    if (p) await openProject(p);
  } finally {
    busy.value = false;
  }
}

async function openProject(project: RecentProject | string) {
  const path = typeof project === "string" ? project : project.path;
  busy.value = true;
  const success = await projectStore.openProject(path);
  busy.value = false;
  if (!success) {
    alert("打开项目失败");
  }
}

function onOpenProject(path: string) {
  menuPath.value = null;
  void openProject(path);
}

function openNewProject() {
  showNewProject.value = true;
  menuPath.value = null;
}

function closeNewProject() {
  showNewProject.value = false;
}

function handleProjectCreated(project: RecentProject) {
  projectStore.addRecent(project);
  projectStore.setView("editor");
  showNewProject.value = false;
}

async function removeProject(path: string) {
  await projectStore.removeRecent(path);
  menuPath.value = null;
}

async function trashProject(path: string, name: string) {
  const ok = await confirm({
    title: "移动到垃圾篓",
    message: `确定要把项目「${name}」移入回收站吗？\n项目文件将从磁盘移除，可从系统回收站恢复。`,
    confirmText: "移入回收站",
    danger: true,
  });
  if (!ok) return;
  menuPath.value = null;
  try {
    await invoke("trash_path", { path });
    await projectStore.removeRecent(path);
    await projectStore.refreshRecent();
  } catch (e) {
    console.error("移入回收站失败:", e);
    alert("移入回收站失败");
  }
}

async function renameProject(path: string, name: string) {
  const newName = window.prompt("新项目名:", name);
  if (!newName || newName.trim() === name) return;
  menuPath.value = null;
  try {
    await invoke("rename_project", { path, newName: newName.trim() });
    await projectStore.refreshRecent();
  } catch (e) {
    console.error("重命名失败:", e);
    alert("重命名失败: " + e);
  }
}

async function revealFolder(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("打开目录失败:", e);
  }
}

function toggleMenu(path: string) {
  menuPath.value = menuPath.value === path ? null : path;
}

function closeMenu() {
  menuPath.value = null;
}

watch(showNewProject, (val) => {
  if (!val) closeMenu();
});
</script>

<template>
  <div class="home" @click="closeMenu">
    <div class="home-body">
      <!-- 左侧导航 -->
      <nav class="home-nav">
        <button
          :class="{ active: section === 'projects' }"
          @click="section = 'projects'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M1.5 3.5h4l1.6 2h7.4v7.5H1.5z" />
          </svg>
          <span>项目</span>
        </button>
        <button
          :class="{ active: section === 'templates' }"
          @click="section = 'templates'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <rect x="2" y="2" width="5.2" height="5.2" rx="1" />
            <rect x="8.8" y="2" width="5.2" height="5.2" rx="1" />
            <rect x="2" y="8.8" width="5.2" height="5.2" rx="1" />
            <path d="M8.8 11.4h5.2M11.4 8.8v5.2" />
          </svg>
          <span>模板</span>
        </button>
        <button
          :class="{ active: section === 'prefs' }"
          @click="section = 'prefs'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <path d="M2 4.5h12" />
            <path d="M2 8h12" />
            <path d="M2 11.5h12" />
            <circle cx="5.5" cy="4.5" r="1.7" fill="var(--bg-panel)" />
            <circle cx="10.5" cy="8" r="1.7" fill="var(--bg-panel)" />
            <circle cx="6.5" cy="11.5" r="1.7" fill="var(--bg-panel)" />
          </svg>
          <span>偏好设置</span>
        </button>
      </nav>

      <!-- 主区域 -->
      <main class="home-main">
        <!-- ========== 项目管理 ========== -->
        <section v-if="section === 'projects'" class="page">
          <div class="page-head">
            <div>
              <h2>项目</h2>
              <p class="sub">管理你的工程</p>
            </div>
            <div class="head-actions">
              <button :disabled="busy" @click="browseAndOpen">
                {{ busy ? "打开中…" : "打开" }}
              </button>
              <button class="primary" @click="openNewProject">新建项目</button>
            </div>
          </div>

          <div v-if="projectStore.recent.length === 0" class="empty">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </div>
            <p>还没有打开过项目</p>
            <button class="primary" @click="openNewProject">新建项目</button>
          </div>

          <div v-else class="project-grid">
            <div
              v-for="p in projectStore.recent"
              :key="p.path"
              class="project-card"
              @click="onOpenProject(p.path)"
            >
              <div class="card-top">
                <span class="card-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </span>
                <button
                  class="card-menu"
                  title="更多操作"
                  @click.stop="toggleMenu(p.path)"
                >
                  ⋯
                </button>
              </div>
              <div class="card-name" :title="p.name">{{ p.name }}</div>
              <div class="card-meta">
                <span>{{ p.sceneCount }} 个场景</span>
                <span class="card-path" :title="p.path">{{ p.path }}</span>
              </div>

              <!-- 卡片操作菜单 -->
              <div v-if="menuPath === p.path" class="card-menu-pop" @click.stop>
                <button @click="onOpenProject(p.path)">打开项目</button>
                <button @click="revealFolder(p.path)">在文件夹中显示</button>
                <button @click="renameProject(p.path, p.name)">重命名项目</button>
                <button class="danger" @click="trashProject(p.path, p.name)">移动到垃圾篓</button>
                <button class="danger" @click="removeProject(p.path)">从列表移除</button>
              </div>
            </div>
          </div>
        </section>

        <!-- ========== 模板管理 ========== -->
        <section v-if="section === 'templates'" class="page">
          <div class="page-head">
            <div>
              <h2>模板</h2>
              <p class="sub">项目创建时使用的页面骨架</p>
            </div>
          </div>

          <div class="settings-card">
            <h3>工程模板</h3>
            <p class="sub">项目创建时使用的页面骨架（新建面板可选择）</p>
            <div v-if="templates.length === 0" class="tpl-empty">暂无工程模板。</div>
            <div v-for="t in templates" :key="t.id" class="tpl-row">
              <div class="tpl-info">
                <div class="tpl-name">{{ t.name }}</div>
                <div class="tpl-desc">{{ t.description }}</div>
              </div>
              <span class="tpl-tag">{{ t.builtin ? "内置" : "自定义" }}</span>
            </div>
          </div>
        </section>

        <!-- ========== 偏好设置 ========== -->
        <section v-if="section === 'prefs'" class="page">
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
                <input type="text" placeholder="选择父目录" />
                <button>浏览…</button>
              </div>
              <p class="hint">新建项目时默认使用该位置。</p>
            </div>
          </template>

          <!-- 关于 -->
          <template v-if="prefsCat === 'about'">
            <div class="settings-card">
              <h3>关于</h3>
              <div class="about-row">
                <span>v0.1.0</span>
                <span class="dim">开发测试版</span>
              </div>
            </div>
          </template>
        </section>
      </main>
    </div>

    <NewProjectDialog
      v-if="showNewProject"
      @close="closeNewProject"
      @created="handleProjectCreated"
    />
  </div>
</template>