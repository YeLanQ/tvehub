<script setup lang="ts">
/**
 * 全局气泡通知宿主：消费 toasts 队列，右上角堆叠展示。
 * 每个窗口挂载一份（editor/home/graph/whiteboard）。
 */
import { toasts, dismiss, leave } from "../composables/toast";
import "../styles/components/toast.scss";
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" role="status" aria-live="polite">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast-item"
        :class="[t.level, { leaving: t.leaving }]"
        title="点击关闭"
        @click="dismiss(t.id)"
      >
        <svg
          class="toast-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <!-- 成功：对勾 -->
          <template v-if="t.level === 'ok'">
            <path d="M5 12.5 10 17.5 19.5 6.5" />
          </template>
          <!-- 信息：圆圈 i -->
          <template v-else-if="t.level === 'info'">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 11v5.5" />
            <path d="M12 7.8h.01" />
          </template>
          <!-- 警告：三角叹号 -->
          <template v-else-if="t.level === 'warn'">
            <path d="M12 3.5 21.5 20.5H2.5L12 3.5z" />
            <path d="M12 10v4.5" />
            <path d="M12 17.5h.01" />
          </template>
          <!-- 错误：圆圈叉 -->
          <template v-else>
            <circle cx="12" cy="12" r="8.5" />
            <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
          </template>
        </svg>

        <span class="toast-text">{{ t.text }}</span>

        <button
          v-if="t.action"
          class="toast-action"
          @click.stop="
            t.action.run();
            dismiss(t.id);
          "
        >
          {{ t.action.label }}
        </button>

        <!-- 填充条：走满即离场（与 toast() 的定时互为兜底） -->
        <div
          class="toast-fill"
          :style="{ animationDuration: t.duration + 'ms' }"
          @animationend="leave(t.id)"
        ></div>
      </div>
    </div>
  </Teleport>
</template>
