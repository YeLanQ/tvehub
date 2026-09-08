<script setup lang="ts">
// 刚体组件字段区（组件卡片主体）：运动学形态 static/kinematic/dynamic +
// 质量/阻尼/重力缩放/CCD。启用开关与增删在卡片头（InspectorPanel）。
import type { RigidBodyComponentRef } from "../../../framework/prototype/Node";
import NumberField from "../NumberField.vue";

defineProps<{ comp: RigidBodyComponentRef }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const MODE_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: "static", label: "静态（Static）", title: "不受模拟影响，位置固定" },
  { value: "kinematic", label: "运动学（Kinematic）", title: "由节点变换/动画驱动，推开展开物" },
  { value: "dynamic", label: "动力学（Dynamic）", title: "受力模拟，位移由物理驱动" },
];
</script>

<template>
  <div class="field">
    <label>形态</label>
    <select
      :value="comp.rigidBody.mode"
      @change="emit('update', 'Set RigidBody Mode', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="m in MODE_OPTIONS" :key="m.value" :value="m.value" :title="m.title">
        {{ m.label }}
      </option>
    </select>
  </div>
  <template v-if="comp.rigidBody.mode === 'dynamic'">
    <div class="field">
      <label>质量</label>
      <NumberField
        :model-value="comp.rigidBody.mass"
        :step="0.1"
        :min="0.001"
        title="质量（kg）"
        @commit="(v) => emit('update', 'Set RigidBody Mass', v)"
      />
    </div>
    <div class="field">
      <label>线性阻尼</label>
      <NumberField
        :model-value="comp.rigidBody.linearDamping"
        :step="0.01"
        :min="0"
        @commit="(v) => emit('update', 'Set RigidBody LinearDamping', v)"
      />
    </div>
    <div class="field">
      <label>角阻尼</label>
      <NumberField
        :model-value="comp.rigidBody.angularDamping"
        :step="0.01"
        :min="0"
        @commit="(v) => emit('update', 'Set RigidBody AngularDamping', v)"
      />
    </div>
  </template>
  <div v-if="comp.rigidBody.mode !== 'static'" class="field">
    <label>重力缩放</label>
    <NumberField
      :model-value="comp.rigidBody.gravityScale"
      :step="0.1"
      :min="0"
      title="0 = 不受重力"
      @commit="(v) => emit('update', 'Set RigidBody GravityScale', v)"
    />
  </div>
  <label class="comp-check" @click.stop>
    <input
      type="checkbox"
      :checked="comp.rigidBody.ccd"
      @change="emit('update', 'Set RigidBody CCD', ($event.target as HTMLInputElement).checked)"
    />
    <span>连续碰撞检测（CCD，高速防穿透）</span>
  </label>
</template>
