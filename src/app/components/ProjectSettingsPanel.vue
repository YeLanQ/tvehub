<script setup lang="ts">
/**
 * 项目设置面板：
 * 左侧分类标签栏 + 右侧内容页。配置写入项目根 project.config.json。
 * 通过点击工具栏“项目信息”打开（projectStore.openSettings）。
 */
import { computed, onMounted, ref } from "vue";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { getEditorStore } from "../stores/editor";
import { logStore } from "../stores/log";
import {
  groupResolutionPresets,
  matchResolutionPreset,
  applyResolutionPreset,
  loadProjectDraft,
  saveProjectDraft,
  PROJECT_CONFIG_REL,
  type ProjectDraft,
} from "../lib/project-settings";
import { physicsBackendRegistry, type PhysicsBackendId } from "../../framework/physics";
import "../../styles/components/project-settings.scss";

const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
const editorStore = getEditorStore();

type SettingsCat = "basic" | "display" | "physics";
const cat = ref<SettingsCat>("basic");
const CATS: { id: SettingsCat; label: string }[] = [
  { id: "basic", label: "基础信息" },
  { id: "display", label: "显示与运行" },
  { id: "physics", label: "物理" },
];

const draft = ref<ProjectDraft | null>(null);
const saving = ref(false);

const resolutionGroups = computed(() => groupResolutionPresets());
const resolutionPreset = computed(() =>
  matchResolutionPreset(draft.value?.designWidth, draft.value?.designHeight),
);

const configFileName = PROJECT_CONFIG_REL;

/** 项目内可选主场景（.scene 资产路径列表） */
const projectScenes = computed(() =>
  assetsStore.assets
    .filter((a) => a.kind === "scene" && !a.path.endsWith("/"))
    .map((a) => a.path),
);

/** 项目内可选用作入口的脚本（src/**.ts） */
const projectScripts = computed(() =>
  assetsStore.assets
    .filter((a) => a.path.startsWith("src/") && a.path.endsWith(".ts") && !a.path.endsWith(".d.ts"))
    .map((a) => a.path),
);

function close(): void {
  projectStore.closeSettings();
  draft.value = null;
}

const backendOptions = physicsBackendRegistry.list();

async function save(): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  try {
    await saveProjectDraft(draft.value);
    // 设计分辨率 → 相机辅助视锥取景即时同步（无需重开编辑器；
    // store 已在 saveProjectDraft 内 setDesignSize 更新）
    getEditorStore().engine.designResolution = {
      width: projectStore.designWidth,
      height: projectStore.designHeight,
    };
    // 物理配置（项目级）即时生效：引擎按最新后端/重力/开关运行
    editorStore.engine.physics.configure({
      backend: projectStore.physicsBackend as PhysicsBackendId,
      enabled: projectStore.physicsEnabled,
      gravity: { ...projectStore.physicsGravity },
    });
    close();
  } catch (e) {
    logStore.log("error", `项目设置保存失败: ${e}`, "toolbar");
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  cat.value = "basic";
  draft.value = await loadProjectDraft();
  // 刷新资产列表以提供主场景下拉选项
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
});
</script>

<template>
  <div class="ps-backdrop">
    <div class="ps-modal">
      <div class="ps-head">
        <span class="ps-title">项目设置</span>
        <button class="ps-close" title="关闭" @click="close">✕</button>
      </div>

      <div class="ps-body">
        <!-- 左侧：分类标签栏 -->
        <nav class="ps-nav">
          <button
            v-for="c in CATS"
            :key="c.id"
            class="ps-nav-item"
            :class="{ active: cat === c.id }"
            @click="cat = c.id"
          >
            {{ c.label }}
          </button>
        </nav>

        <!-- 右侧：当前分类内容 -->
        <div class="ps-content">
          <template v-if="draft">
            <!-- 基础信息 -->
            <section v-if="cat === 'basic'" class="ps-section">
              <h3 class="ps-section-title">基础信息</h3>
              <div class="ps-field">
                <label for="ps-version">版本</label>
                <input id="ps-version" v-model="draft.version" placeholder="0.0.1" />
              </div>
              <div class="ps-field">
                <label for="ps-desc">描述</label>
                <textarea
                  id="ps-desc"
                  v-model="draft.description"
                  rows="2"
                  placeholder="项目描述（可选）"
                ></textarea>
              </div>
              <div class="ps-field">
                <label for="ps-main-scene">主场景</label>
                <select id="ps-main-scene" v-model="draft.mainScene">
                  <option value="">未设置（默认空）</option>
                  <option v-for="s in projectScenes" :key="s" :value="s">{{ s }}</option>
                </select>
              </div>
              <div class="ps-field">
                <label for="ps-entry-script">入口脚本</label>
                <select id="ps-entry-script" v-model="draft.entryScript">
                  <option value="">无（仅脚本组件运行）</option>
                  <option v-for="s in projectScripts" :key="s" :value="s">{{ s }}</option>
                </select>
                <p class="ps-note">
                  入口脚本随预览/发布运行（挂载在场景根节点）；节点级行为请在检查器
                  Components 卡片挂载脚本组件。
                </p>
              </div>
            </section>

            <!-- 显示与运行 -->
            <section v-else-if="cat === 'display'" class="ps-section">
              <h3 class="ps-section-title">显示与运行</h3>
              <div class="ps-field">
                <label>设计分辨率</label>
                <div class="ps-res">
                  <input v-model.number="draft.designWidth" type="number" min="1" />
                  <span class="ps-x">×</span>
                  <input v-model.number="draft.designHeight" type="number" min="1" />
                </div>
                <select
                  class="ps-preset"
                  :value="resolutionPreset"
                  title="常用分辨率预设"
                  @change="applyResolutionPreset(draft, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="__custom__" disabled>自定义…</option>
                  <optgroup v-for="[g, items] in resolutionGroups" :key="g" :label="g">
                    <option v-for="p in items" :key="p.label" :value="p.label">{{ p.label }}</option>
                  </optgroup>
                </select>
              </div>
              <div class="ps-field">
                <label for="ps-orient">屏幕方向</label>
                <select id="ps-orient" v-model="draft.orientation">
                  <option value="auto">自动（跟随设备）</option>
                  <option value="portrait">竖屏</option>
                  <option value="landscape">横屏</option>
                </select>
              </div>
              <div class="ps-field">
                <label for="ps-scale">缩放模式</label>
                <select id="ps-scale" v-model="draft.scaleMode">
                  <option value="noscale">不缩放</option>
                  <option value="fixedwidth">固定宽度</option>
                  <option value="fixedheight">固定高度</option>
                  <option value="fixedauto">固定宽高比</option>
                  <option value="full">全屏拉伸</option>
                </select>
              </div>
              <div class="ps-field">
                <label for="ps-hdrmode">渲染合成</label>
                <select id="ps-hdrmode" v-model="draft.hdrMode">
                  <option value="hdr">HDR 合成</option>
                  <option value="ldr">LDR 合成</option>
                </select>
              </div>
              <div class="ps-field">
                <label for="ps-aa">抗锯齿</label>
                <select id="ps-aa" v-model.number="draft.antiAliasing">
                  <option :value="0">无</option>
                  <option :value="2">MSAA 2x</option>
                  <option :value="4">MSAA 4x</option>
                  <option :value="8">MSAA 8x</option>
                </select>
              </div>
              <div class="ps-field">
                <label for="ps-renderer">渲染后端</label>
                <select id="ps-renderer" v-model="draft.renderer">
                  <option value="webgl">WebGL（稳定）</option>
                  <option value="webgpu">WebGPU（实验，不可用时自动回退 WebGL2）</option>
                  <option value="auto">自动（优先 WebGPU）</option>
                </select>
              </div>
              <p class="ps-note">
                渲染后端在编辑器启动/重载视口时生效；WebGPU 与 WebGL 的后端在运行时不可切换，
                修改后请重新打开编辑器查看效果。设计分辨率修改会即时同步到相机辅助视锥线框。
              </p>
            </section>

            <!-- 物理 -->
            <section v-else-if="cat === 'physics'" class="ps-section">
              <h3 class="ps-section-title">物理</h3>
              <label class="ps-field ps-physics-toggle">
                <input
                  id="ps-physics-enabled"
                  v-model="draft.physicsEnabled"
                  type="checkbox"
                />
                <span>启用物理模拟</span>
              </label>
              <p class="ps-note">
                启用后，预览/发布产物对挂了「刚体」组件的节点自动开始模拟；
                编辑器视口的模拟经检查器 Physics 卡片的 ▶/⏹ 控制。
              </p>
              <div class="ps-field">
                <label for="ps-physics-backend">物理引擎</label>
                <select
                  id="ps-physics-backend"
                  v-model="draft.physicsBackend"
                >
                  <option v-for="b in backendOptions" :key="b.key" :value="b.key">
                    {{ b.label }}
                  </option>
                </select>
                <p class="ps-note">
                  预览/发布产物按所选引擎按需加载（未启用物理的产物不打包引擎）。
                </p>
              </div>
              <div class="ps-field">
                <label>重力</label>
                <div class="ps-res">
                  <span class="ps-axis">X</span>
                  <input
                    v-model.number="draft.physicsGravity.x"
                    type="number"
                    step="0.1"
                    title="重力 X"
                  />
                  <span class="ps-axis">Y</span>
                  <input
                    v-model.number="draft.physicsGravity.y"
                    type="number"
                    step="0.1"
                    title="重力 Y"
                  />
                  <span class="ps-axis">Z</span>
                  <input
                    v-model.number="draft.physicsGravity.z"
                    type="number"
                    step="0.1"
                    title="重力 Z"
                  />
                </div>
                <p class="ps-note">世界加速度（米/秒²；地球重力约为 -9.81 沿 -Y），影响全部动力学体。</p>
              </div>
            </section>
          </template>
          <div v-else class="ps-loading muted mono">加载中…</div>
        </div>
      </div>

      <div class="ps-foot">
        <span class="ps-hint">配置写入 <code>{{ configFileName }}</code></span>
        <button @click="close">取消</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? "保存中…" : "保存设置" }}
        </button>
      </div>
    </div>
  </div>
</template>
