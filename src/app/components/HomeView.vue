<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页窗口根组件（src/home-main.ts 挂载）：左侧分区导航 + 右侧分区内容。
// - 分区切换状态（section）与导航按钮留在本组件，五个分区各自渲染 home/ 下的
//   子组件（ProjectsSection / TemplatesSection / PreferencesSection /
//   WorkshopSection / DevServiceSection），子组件自读 store、自持局部状态；
// - 跨分区的少量状态与弹层也留在本组件：新建项目对话框（项目分区两处入口触发，
//   创建成功后交接编辑器窗口）、最近项目「⋯」菜单的展开路径（菜单渲染在项目分区，
//   根级点击与关闭对话框要收起它）、内嵌文档查看器与复制提示条（根级 fixed 弹层，
//   由开发者服务分区的事件触发）；
// - 窗口挂载时做应用级初始化：最近项目、开发者服务控制服务器状态与工具权限同步
//   （提前同步，打开开发者服务分区即为最终状态，不再刷新）。
// ---------------------------------------------------------------------------
import { onMounted, ref, watch } from "vue";
import { getProjectStore, type RecentProject } from "../stores/project";
import NewProjectDialog from "./NewProjectDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import TitleBar from "../../ui-kit/components/TitleBar.vue";
import ProjectsSection from "./home/ProjectsSection.vue";
import TemplatesSection from "./home/TemplatesSection.vue";
import PreferencesSection from "./home/PreferencesSection.vue";
import WorkshopSection from "./home/WorkshopSection.vue";
import DevServiceSection from "./home/DevServiceSection.vue";
import "../../styles/components/home-view.scss";
import { isTauri } from "../../lib/tauri-env";
import { handoffToWindow } from "../lib/window-handoff";
import { syncDevToolsStatus } from "../lib/devtools";
import { syncPermsFromBackend } from "../lib/devtools/state";

const projectStore = getProjectStore();

type Section = "projects" | "templates" | "workshop" | "prefs" | "dev";
const section = ref<Section>("projects");

/** 最近项目卡片的「⋯」菜单：当前展开项的项目路径（null = 全部收起；
 *  菜单本体与开关在 ProjectsSection，本组件负责根级点击/对话框关闭时收起） */
const menuPath = ref<string | null>(null);

function closeMenu() {
  menuPath.value = null;
}

/** 新建项目对话框（项目分区页头与空态入口共用） */
const showNewProject = ref(false);

/** 运行环境标记（浏览器直开环境无窗口系统：交接走单窗口回退，桌面端初始化也据此跳过） */
const inTauri = isTauri();

/** 内嵌文档查看器（弹层 iframe 加载 public/docs 静态页） */
const showDocsViewer = ref(false);
const docsViewerSrc = ref("/docs/index.html");

function openDocsViewer(hash: string): void {
  docsViewerSrc.value = `/docs/index.html#${hash}`;
  showDocsViewer.value = true;
}

function closeDocsViewer(): void {
  showDocsViewer.value = false;
  docsViewerSrc.value = "";
}

/** 复制提示（2 秒消失） */
const showCopyToast = ref(false);
let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
/** 弹出复制提示（触发点是开发者服务分区的端点/配置复制） */
function showCopiedTip(): void {
  showCopyToast.value = true;
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => (showCopyToast.value = false), 2000);
}

onMounted(() => {
  projectStore.refreshRecent();
  if (inTauri) {
    // 开发者服务·控制服务器：仅同步展示状态（命令监听器只在编辑器窗口安装）
    void syncDevToolsStatus();
    // 工具权限：Rust 为权威存储，启动时同步一次（同时回写 localStorage 镜像）
    void syncPermsFromBackend();
  }
});

/** 打开新建项目对话框（项目分区的两个入口都经此；同时收起卡片菜单） */
function openNewProject() {
  showNewProject.value = true;
  menuPath.value = null;
}

function closeNewProject() {
  showNewProject.value = false;
}

async function handleProjectCreated(project: RecentProject) {
  projectStore.addRecent(project);
  showNewProject.value = false;
  await handoffToEditor();
}

/**
 * 打开/新建项目成功后交接给编辑器窗口（统一窗口交接）：
 * 写入后端待交付状态 + 显示编辑器窗口 + 广播事件（冷启动由拉取兜底）。
 */
async function handoffToEditor(): Promise<void> {
  if (!inTauri) {
    // 浏览器环境无窗口系统，回退单窗口视图切换
    projectStore.setView("editor");
    return;
  }
  const root = projectStore.currentPath;
  if (!root) return;
  try {
    await handoffToWindow(
      "main",
      root,
      projectStore.projectName ?? "",
      projectStore.sceneRel,
    );
  } catch (e) {
    console.error("切换到编辑器窗口失败:", e);
    alert("切换到编辑器窗口失败：" + e);
  }
}

watch(showNewProject, (val) => {
  if (!val) closeMenu();
});
</script>

<template>
  <div class="home" @click="closeMenu">
    <!-- 自定义标题栏（无边框窗口） -->
    <TitleBar title="TvE Hub" />

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
        <button
          :class="{ active: section === 'workshop' }"
          @click="section = 'workshop'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 4.5a1.5 1.5 0 0 1 3 0V12a1.5 1.5 0 0 1-3 0z" />
            <path d="M6 12.5h6a1 1 0 0 0 1-1v-1.5" />
            <path d="M8.5 5 7 6.5 8.5 8M11 5l1.5 1.5L11 8" />
          </svg>
          <span>创意工坊</span>
        </button>
        <button
          :class="{ active: section === 'dev' }"
          @click="section = 'dev'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5.5 4 2.5 8l3 4" />
            <path d="M10.5 4l3 4-3 4" />
          </svg>
          <span>开发者服务</span>
        </button>
      </nav>

      <!-- 主区域 -->
      <main class="home-main">
        <!-- ========== 项目管理 ========== -->
        <ProjectsSection
          v-if="section === 'projects'"
          v-model:menu-path="menuPath"
          @new-project="openNewProject"
          @opened="handoffToEditor"
        />

        <!-- ========== 模板管理 ========== -->
        <TemplatesSection v-if="section === 'templates'" />

        <!-- ========== 偏好设置 ========== -->
        <PreferencesSection v-if="section === 'prefs'" />

        <!-- ========== 创意工坊 ========== -->
        <WorkshopSection v-if="section === 'workshop'" />

        <!-- ========== 开发者服务 ========== -->
        <DevServiceSection
          v-if="section === 'dev'"
          @open-docs="openDocsViewer"
          @copied="showCopiedTip"
        />
      </main>
    </div>

    <!-- 复制成功提示（开发者服务·端点/配置复制） -->
    <Transition name="fade">
      <div v-if="showCopyToast" class="copy-toast">已复制到剪贴板</div>
    </Transition>

    <!-- 内嵌文档查看器（public/docs 静态页） -->
    <Transition name="fade">
      <div v-if="showDocsViewer" class="docs-viewer-backdrop" @click.self="closeDocsViewer">
        <div class="docs-viewer">
          <div class="docs-viewer-head">
            <span class="docs-viewer-title">tve 文档</span>
            <button class="docs-viewer-close" title="关闭文档" @click="closeDocsViewer">✕</button>
          </div>
          <iframe
            class="docs-viewer-frame"
            :src="docsViewerSrc"
            title="tve 文档"
          ></iframe>
        </div>
      </div>
    </Transition>

    <!-- 全局确认弹窗（首页窗口独立挂载：垃圾篓/移除等 confirm 依赖它） -->
    <ConfirmDialog />

    <NewProjectDialog
      v-if="showNewProject"
      @close="closeNewProject"
      @created="handleProjectCreated"
    />
  </div>
</template>
