<script setup lang="ts">
/**
 * 场景图窗口装载蒙版（GraphApp 根级挂载，fixed 盖住整个图窗口）：
 * Hub「打开场景图」→ 项目交接装载期间展示阶段进度，全部就绪后淡出揭幕。
 * 数据源为 graph-window/boot-loading store；视觉复用编辑器 boot-mask.scss，
 * 与编辑器窗口打开体验一致。
 */
import { computed } from "vue";
import { getGraphBootStore } from "../boot-loading";
import "../../styles/components/boot-mask.scss";

const boot = getGraphBootStore();

/** standby（布防等待）与 loading（装载中）可见；ready/idle 揭幕 */
const visible = computed(
  () => boot.state.phase === "standby" || boot.state.phase === "loading",
);

/** 标题：装载中显示项目名，布防态显示通用等待文案 */
const title = computed(() =>
  boot.state.phase === "loading" && boot.state.projectName
    ? boot.state.projectName
    : "正在打开项目",
);
</script>

<template>
  <Transition name="boot-mask">
    <div v-if="visible" class="boot-mask" @contextmenu.prevent @click.stop>
      <div class="boot-card">
        <div class="boot-brand">TVE <span>GRAPH</span></div>
        <div class="boot-title" :title="boot.state.projectName">{{ title }}</div>

        <ul class="boot-stages">
          <li v-for="s in boot.state.stages" :key="s.id" :class="s.status">
            <span class="stage-icon">
              <!-- 进行中：旋转环 -->
              <svg v-if="s.status === 'active'" class="spin" viewBox="0 0 16 16" width="13" height="13">
                <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.6" />
                <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
              <!-- 完成 -->
              <svg v-else-if="s.status === 'done'" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 8.5 6.5 12 13 4.5" />
              </svg>
              <!-- 失败 -->
              <svg v-else-if="s.status === 'failed'" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              <!-- 待处理：空心点 -->
              <span v-else class="dot"></span>
            </span>
            <span class="stage-label">{{ s.label }}</span>
          </li>
        </ul>

        <div class="boot-bar">
          <div class="boot-bar-fill" :style="{ width: boot.percent + '%' }"></div>
        </div>
        <div class="boot-percent">{{ boot.percent }}%</div>

        <div v-if="boot.state.error" class="boot-error">{{ boot.state.error }}</div>
        <div v-else class="boot-hint">资产与场景就绪后进入场景图</div>
      </div>
    </div>
  </Transition>
</template>
