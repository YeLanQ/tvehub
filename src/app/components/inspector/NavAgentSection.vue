<script setup lang="ts">
/**
 * 导航代理卡（NavAgentNode）：
 * - Area：绑定的导航区域（场景导航区域下拉；空 = 自动取第一个已烘焙区域）；
 * - Movement：移动速度 / 碰撞半径（SDF 净空）；
 * - 路径动作：目标点（世界 XZ）→「计算路径」寻路并开始移动 /「停止」清路径；
 *   路径与行进是运行态（不进场景），路径折线在视口以辅助线显示（选中时）。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案。
 */
import { computed, ref } from "vue";
import type { NavAgentNode } from "../../../framework/prototype/derived/Primitives";
import { NavAreaNode } from "../../../framework/prototype/derived/Primitives";
import { NAV_AGENT_LIMITS } from "../../../framework/navigation";
import { getEditorStore } from "../../stores/editor";
import { logStore } from "../../stores/log";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: NavAgentNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const L = NAV_AGENT_LIMITS;

const s = computed(() => {
  void props.rev;
  return props.node.settings;
});

const editor = () => getEditorStore().engine;

/** 场景中的导航区域节点（绑定候选） */
const areas = computed(() => {
  void props.rev;
  return editor().graph.all().filter((n): n is NavAreaNode => n instanceof NavAreaNode);
});

const areaListed = computed(() => {
  const cur = s.value.areaId;
  if (!cur) return true;
  return areas.value.some((a) => a.id === cur);
});

/** 目标点（世界 XZ；默认代理当前位置附近） */
const targetX = ref(0);
const targetZ = ref(0);
const lastResult = ref<"" | "ok" | "fail" | "noArea">("");

function onFindPath(): void {
  const ok = editor().nav.requestPath(props.node.id, targetX.value, targetZ.value);
  lastResult.value = ok ? "ok" : "fail";
  if (ok) {
    logStore.log("success", "寻路成功：代理开始沿路径移动（可在视口查看路径线）");
  } else {
    logStore.log("warn", "寻路失败：目标不可达（需要已烘焙的导航区域与可达目标点）");
  }
}

function onStop(): void {
  editor().nav.clearPath(props.node.id);
  lastResult.value = "";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
</script>

<template>
  <div class="terrain-section" :data-rev="rev">
    <!-- ===== Area ===== -->
    <div class="ts-group">Area</div>
    <div class="field">
      <label title="绑定的导航区域；空 = 自动使用场景第一个已烘焙区域">Target</label>
      <select :value="s.areaId" @change="emit('update', 'Bind Nav Area', ($event.target as HTMLSelectElement).value)">
        <option value="">（自动：第一个区域）</option>
        <option v-if="!areaListed" :value="s.areaId">（已删除的区域）</option>
        <option v-for="a in areas" :key="a.id" :value="a.id" :title="a.name">
          {{ a.name }}
        </option>
      </select>
    </div>

    <!-- ===== Movement ===== -->
    <div class="ts-group">Movement</div>
    <div class="field">
      <label title="沿路径的移动速度（世界单位/秒）">Speed</label>
      <NumberField
        :model-value="s.speed"
        :step="0.5"
        :min="L.speed.min"
        :max="L.speed.max"
        title="移动速度（世界单位/秒）"
        @commit="(v) => emit('update', 'Set Speed', clamp(v, L.speed.min, L.speed.max))"
      />
    </div>
    <div class="field">
      <label title="碰撞半径：与障碍距离不足时沿 SDF 梯度滑移避障">Radius</label>
      <NumberField
        :model-value="s.radius"
        :step="0.1"
        :min="L.radius.min"
        :max="L.radius.max"
        title="碰撞半径（世界单位）"
        @commit="(v) => emit('update', 'Set Agent Size', clamp(v, L.radius.min, L.radius.max))"
      />
    </div>

    <!-- ===== 路径动作 ===== -->
    <div class="ts-group">Path</div>
    <div class="field">
      <label title="目标点世界坐标 X">Target X</label>
      <NumberField v-model="targetX" :step="1" title="目标点世界坐标 X" />
    </div>
    <div class="field">
      <label title="目标点世界坐标 Z">Target Z</label>
      <NumberField v-model="targetZ" :step="1" title="目标点世界坐标 Z" />
    </div>
    <div class="ts-actions">
      <button title="从代理当前位置到目标点寻路并开始移动（A* + 视线拉直平滑）" @click="onFindPath">
        计算路径
      </button>
      <button title="清除当前路径，代理停下" @click="onStop">停止</button>
    </div>
    <div class="ts-actions">
      <span v-if="lastResult === 'ok'" class="hint">寻路成功，代理移动中…</span>
      <span v-else-if="lastResult === 'fail'" class="hint">目标不可达（检查导航区域与目标点）</span>
      <span v-else class="hint">路径是运行态：移动/避障由烘焙 SDF 查表驱动，不写场景数据</span>
    </div>
  </div>
</template>
