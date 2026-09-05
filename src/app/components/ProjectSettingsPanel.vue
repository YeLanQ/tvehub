<script setup lang="ts">
/**
 * 项目设置面板（参考 LQEN EditorView 的项目设置弹窗；Unity Project Settings 风格）：
 * 左侧分类标签栏 + 右侧内容页。配置写入项目根 project.config.json。
 * 通过点击工具栏“项目信息”打开（projectStore.openSettings）。
 */
import { computed, onMounted, ref } from "vue";
import { getProjectStore } from "../stores/project";
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
import "../../styles/components/project-settings.scss";

const projectStore = getProjectStore();

type SettingsCat = "basic" | "display" | "about";
const cat = ref<SettingsCat>("basic");
const CATS: { id: SettingsCat; label: string }[] = [
  { id: "basic", label: "基础信息" },
  { id: "display", label: "显示与运行" },
  { id: "about", label: "关于" },
];

const draft = ref<ProjectDraft | null>(null);
const saving = ref(false);

const resolutionGroups = computed(() => groupResolutionPresets());
const resolutionPreset = computed(() =>
  matchResolutionPreset(draft.value?.designWidth, draft.value?.designHeight),
);

const configFileName = PROJECT_CONFIG_REL;
const scenePath = "assets/Main.scene";

function close(): void {
  projectStore.closeSettings();
  draft.value = null;
}

async function save(): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  try {
    await saveProjectDraft(draft.value);
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
                <label for="ps-name">项目名</label>
                <input id="ps-name" v-model="draft.name" placeholder="项目名称" />
              </div>
              <div class="ps-field">
                <label for="ps-pkg">包名</label>
                <input id="ps-pkg" v-model="draft.packageName" placeholder="如 com.example.game" />
              </div>
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
            </section>

            <!-- 关于 -->
            <section v-else class="ps-section">
              <h3 class="ps-section-title">关于</h3>
              <div class="ps-kv">
                <span class="ps-k">项目名</span>
                <span class="ps-v mono">{{ projectStore.projectName ?? "—" }}</span>
              </div>
              <div class="ps-kv">
                <span class="ps-k">项目路径</span>
                <span class="ps-v mono">{{ projectStore.currentPath ?? "—" }}</span>
              </div>
              <div class="ps-kv">
                <span class="ps-k">主场景</span>
                <span class="ps-v mono">{{ scenePath }}</span>
              </div>
              <div class="ps-kv">
                <span class="ps-k">设置文件</span>
                <span class="ps-v mono">{{ configFileName }}</span>
              </div>
              <p class="ps-note">
                项目设置与场景数据分开存放：场景内容保存在 {{ scenePath }}，
                显示/包信息等配置保存在 {{ configFileName }}。
              </p>
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
