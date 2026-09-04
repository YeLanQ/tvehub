<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { getProjectStore, type RecentProject } from "../stores/project";
import NewProjectDialog from "./NewProjectDialog.vue";
import "../../styles/components/home-view.scss";

const projectStore = getProjectStore();

const showNewProject = ref(false);
const menuPath = ref<string | null>(null);
const busy = ref(false);

const emptyRecent = computed(() => projectStore.recent.length === 0);

onMounted(() => {
  projectStore.refreshRecent();
});

async function openProject(project: RecentProject) {
  busy.value = true;
  const success = await projectStore.openProject(project.path);
  busy.value = false;
  if (!success) {
    alert("打开项目失败");
  }
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
    <div class="home-header">
      <div class="logo">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <h1>Three Visual Editor</h1>
      </div>
      <p class="subtitle">3D 场景可视化编辑器</p>
    </div>

    <div class="home-body">
      <div class="home-main">
        <div class="page-head">
          <div>
            <h2>项目</h2>
            <p class="sub">管理你的工程</p>
          </div>
          <div class="head-actions">
            <button class="primary" @click="openNewProject">新建项目</button>
          </div>
        </div>

        <div v-if="emptyRecent" class="empty">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
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
            @click="openProject(p)"
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

            <div v-if="menuPath === p.path" class="card-menu-pop" @click.stop>
              <button @click="openProject(p)">打开项目</button>
              <button class="danger" @click="removeProject(p.path)">从列表移除</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <NewProjectDialog
      v-if="showNewProject"
      @close="closeNewProject"
      @created="handleProjectCreated"
    />
  </div>
</template>
