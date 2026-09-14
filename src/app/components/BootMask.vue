<script setup lang="ts">
// ---------------------------------------------------------------------------
// 编辑器顶层装载蒙版（App.vue 根级挂载，fixed 盖住整个编辑器窗口）：
// 从 Manager 打开项目卡片 → 编辑器窗口交接装载期间展示阶段进度，全部就绪
// 后淡出揭幕。数据源为 boot-loading store；standby（布防）态显示等待文案，
// loading 态显示项目名 + 阶段清单 + 总进度条，failed 阶段标红并展示错误。
// ---------------------------------------------------------------------------
import { computed } from "vue";
import { getBootLoadingStore } from "../stores/boot-loading";
import "../../styles/components/boot-mask.scss";

const boot = getBootLoadingStore();

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

/** 各阶段折算进度（等权平均）：done=1，active 有计量按 n/N（留 5% 收尾），
 *  active 无计量按 0.4，failed=1（错误信息另示） */
const percent = computed(() => {
  let sum = 0;
  for (const s of boot.state.stages) {
    if (s.status === "done" || s.status === "failed") sum += 1;
    else if (s.status === "active") {
      sum += s.total > 0 ? Math.min(1, s.done / s.total) * 0.95 : 0.4;
    }
  }
  return Math.round((sum / boot.state.stages.length) * 100);
});

/** 逐项计量文案（如材质 3/12） */
function detail(done: number, total: number): string {
  return total > 0 ? `${done} / ${total}` : "";
}
</script>

<template>
  <Transition name="boot-mask">
    <div v-if="visible" class="boot-mask" @contextmenu.prevent @click.stop>
      <div class="boot-card">
        <div class="boot-brand">TVE <span>EDITOR</span></div>
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
            <span class="stage-detail">{{ detail(s.done, s.total) }}</span>
          </li>
        </ul>

        <div class="boot-bar">
          <div class="boot-bar-fill" :style="{ width: percent + '%' }"></div>
        </div>
        <div class="boot-percent">{{ percent }}%</div>

        <div v-if="boot.state.error" class="boot-error">{{ boot.state.error }}</div>
        <div v-else class="boot-hint">资产与场景全部就绪后进入编辑器</div>
      </div>
    </div>
  </Transition>
</template>
