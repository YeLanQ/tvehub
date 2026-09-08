<script setup lang="ts">
/**
 * 物理模拟控制（挂了刚体/碰撞体组件的节点显示）：
 * 播放/暂停/停止为编辑器视口运行时控制（不落盘；停止还原变换）；
 * 引擎/重力/启用开关在项目设置「物理」分类。
 */
import { computed } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import { getEditorStore } from "../../stores/editor";

const props = defineProps<{ node: Node; rev?: number }>();

const editorStore = getEditorStore();
const engine = editorStore.engine;

/** 运行时状态（绑定/世界就绪/模拟中；随 physics:changed 的 rev 刷新） */
const runtime = computed(() => {
  void props.rev;
  return engine.physics.stateFor(props.node.id);
});

/** 项目级物理配置（启用状态/引擎；随 rev 刷新） */
const physCfg = computed(() => {
  void props.rev;
  return engine.physics.getConfig();
});

/** 模拟状态文案 */
const simText = computed(() => {
  void props.rev;
  if (!engine.physics.isSimulating) return "未模拟";
  if (engine.physics.isPaused) return "已暂停";
  if (!engine.physics.isWorldReady) return "引擎加载中…";
  return "模拟中";
});
</script>

<template>
  <div class="phys-sim" :data-rev="rev">
    <button
      title="开始模拟（快照变换，动力学体开始受力）"
      :disabled="engine.physics.isSimulating"
      @click="engine.physics.play()"
    >▶</button>
    <button
      v-if="!engine.physics.isPaused"
      title="暂停模拟"
      :disabled="!engine.physics.isSimulating || engine.physics.isPaused"
      @click="engine.physics.pause()"
    >⏸</button>
    <button
      v-else
      title="继续模拟"
      @click="engine.physics.resume()"
    >⏵</button>
    <button
      title="停止模拟（销毁世界并还原变换）"
      :disabled="!engine.physics.isSimulating"
      @click="engine.physics.stop()"
    >⏹</button>
    <span class="phys-sim-state mono">{{ simText }}</span>
  </div>

  <!-- 运行时状态 -->
  <div v-if="runtime" class="phys-runtime mono">
    <span>{{ runtime.worldLoading ? "引擎加载中…" : runtime.worldReady ? "世界就绪" : runtime.error ? runtime.error : "世界未创建" }}</span>
    <span v-if="runtime.simulating">{{ runtime.paused ? "（已暂停）" : "（模拟中）" }}</span>
  </div>
  <div class="phys-hint">
    引擎/重力/启用开关在 项目设置 → 物理；{{ physCfg.enabled ? "" : "当前项目未启用物理（预览/发布不模拟），可用上方按钮手动模拟；" }}无刚体的碰撞体 = 静态碰撞体；运动学体由节点变换/动画驱动。
  </div>
</template>

<style scoped>
.phys-sim {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}
.phys-sim button {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.phys-sim button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.phys-sim button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.phys-sim-state {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim, #999);
}
.phys-runtime {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim, #999);
  margin-top: 4px;
}
.phys-hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim, #888);
  margin-top: 4px;
}
</style>
