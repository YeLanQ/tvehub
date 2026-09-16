<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页·「项目」分区：最近项目卡片网格与项目管理操作。
// - 打开项目（页头「打开」选目录 / 卡片点击 / 卡片菜单「打开项目」）成功后
//   emit("opened")，由 HomeView 完成编辑器窗口交接（双窗口架构）；
// - 卡片「⋯」菜单：打开项目 / 在文件夹中显示 / 重命名项目 / 移动到垃圾篓 /
//   从列表移除（移入回收站与重命名走后端 api，随后刷新最近项目）；
// - 「新建项目」入口只 emit("new-project")：对话框由 HomeView 持有（跨分区弹层）。
// 菜单展开路径由 HomeView 持有（根级点击与关闭对话框都要收起菜单），此处经
// v-model:menu-path 读写；项目列表与目录选择走项目 store（无本组件局部副本）。
// ---------------------------------------------------------------------------
import { ref } from "vue";
import { getProjectStore, type RecentProject } from "../../stores/project";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { confirm } from "../../lib/confirm";
import { api } from "../../../lib/api";
import { openScriptGraphWindow } from "../../lib/graph-launch";

const emit = defineEmits<{
  /** 请求新建项目（对话框由 HomeView 持有） */
  newProject: [];
  /** 项目已成功打开：HomeView 据此交接编辑器窗口 */
  opened: [];
}>();

/** 最近项目卡片的「⋯」菜单：当前展开项的项目路径（null = 全部收起） */
const menuPath = defineModel<string | null>("menuPath", { default: null });

const projectStore = getProjectStore();
const busy = ref(false);

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
    return;
  }
  emit("opened");
}

function onOpenProject(path: string) {
  menuPath.value = null;
  void openProject(path);
}

/** 项目卡片菜单「打开脚本图」：不经编辑器窗口，直接打开统一节点图编辑器 */
function onOpenScriptGraph(path: string, name: string) {
  menuPath.value = null;
  void openScriptGraphWindow(path, name);
}

/** 打开新建项目对话框（对话框在 HomeView；此处只发请求事件） */
function openNewProject() {
  emit("newProject");
}

async function removeProject(path: string) {
  // 最近记录现在由后端持久化：仅本地移除会在下次 refresh 时复活，需同步后端
  try {
    await api.removeRecentProject(path);
  } catch (e) {
    console.error("移除最近记录失败:", e);
  }
  await projectStore.removeRecent(path);
  await projectStore.refreshRecent();
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
    await api.trashPath(path);
  } catch (e) {
    console.error("移入回收站失败:", e);
    alert("移入回收站失败");
    return;
  }
  // 移入回收站后同步清除后端最近记录（尽力而为；避免旧路径残留、系统回收站恢复后复活）
  try {
    await api.removeRecentProject(path);
  } catch (e) {
    console.error("清除最近记录失败:", e);
  }
  await projectStore.removeRecent(path);
  await projectStore.refreshRecent();
}

async function renameProject(path: string, name: string) {
  const newName = window.prompt("新项目名:", name);
  if (!newName || newName.trim() === name) return;
  menuPath.value = null;
  try {
    await api.renameProject(path, newName.trim());
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
</script>

<template>
  <section class="page">
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
          <button @click="onOpenScriptGraph(p.path, p.name)">打开脚本图</button>
          <button @click="revealFolder(p.path)">在文件夹中显示</button>
          <button @click="renameProject(p.path, p.name)">重命名项目</button>
          <button class="danger" @click="trashProject(p.path, p.name)">移动到垃圾篓</button>
          <button class="danger" @click="removeProject(p.path)">从列表移除</button>
        </div>
      </div>
    </div>
  </section>
</template>
