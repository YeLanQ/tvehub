<script setup lang="ts">
// 碰撞体组件字段区（组件卡片主体）：box/sphere/capsule/cylinder/convex +
// 尺寸（自动包围盒或显式）/偏移/摩擦/弹性/传感器。启用开关与增删在卡片头。
import type { ColliderComponentRef } from "../../../framework/prototype/Node";
import NumberField from "../NumberField.vue";

defineProps<{ comp: ColliderComponentRef }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const SHAPE_OPTIONS: { value: string; label: string }[] = [
  { value: "box", label: "盒（Box）" },
  { value: "sphere", label: "球（Sphere）" },
  { value: "capsule", label: "胶囊（Capsule）" },
  { value: "cylinder", label: "圆柱（Cylinder）" },
  { value: "convex", label: "凸包（Convex）" },
];
</script>

<template>
  <div class="field">
    <label>形状</label>
    <select
      :value="comp.collider.shape"
      @change="emit('update', 'Set Collider Shape', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="s in SHAPE_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
    </select>
  </div>
  <label class="comp-check" @click.stop>
    <input
      type="checkbox"
      :checked="comp.collider.autoSize"
      @change="emit('update', 'Set Collider AutoSize', ($event.target as HTMLInputElement).checked)"
    />
    <span>尺寸自适应（按渲染包围盒）</span>
  </label>
  <template v-if="!comp.collider.autoSize">
    <div class="field">
      <label>尺寸</label>
      <div class="comp-vec">
        <NumberField
          :model-value="comp.collider.size.x"
          :step="0.1"
          :min="0.1"
          title="X（球取直径；柱体取直径）"
          @commit="(v) => emit('update', 'Set Collider Size X', v)"
        />
        <NumberField
          :model-value="comp.collider.size.y"
          :step="0.1"
          :min="0.1"
          title="Y（胶囊/圆柱的高）"
          @commit="(v) => emit('update', 'Set Collider Size Y', v)"
        />
        <NumberField
          :model-value="comp.collider.size.z"
          :step="0.1"
          :min="0.1"
          title="Z"
          @commit="(v) => emit('update', 'Set Collider Size Z', v)"
        />
      </div>
    </div>
  </template>
  <div class="field">
    <label>偏移</label>
    <div class="comp-vec">
      <NumberField
        :model-value="comp.collider.offset.x"
        :step="0.1"
        title="偏移 X"
        @commit="(v) => emit('update', 'Set Collider Offset X', v)"
      />
      <NumberField
        :model-value="comp.collider.offset.y"
        :step="0.1"
        title="偏移 Y"
        @commit="(v) => emit('update', 'Set Collider Offset Y', v)"
      />
      <NumberField
        :model-value="comp.collider.offset.z"
        :step="0.1"
        title="偏移 Z"
        @commit="(v) => emit('update', 'Set Collider Offset Z', v)"
      />
    </div>
  </div>
  <div class="field">
    <label>摩擦</label>
    <NumberField
      :model-value="comp.collider.friction"
      :step="0.05"
      :min="0"
      @commit="(v) => emit('update', 'Set Collider Friction', v)"
    />
  </div>
  <div class="field">
    <label>弹性</label>
    <NumberField
      :model-value="comp.collider.restitution"
      :step="0.05"
      :min="0"
      :max="1"
      @commit="(v) => emit('update', 'Set Collider Restitution', v)"
    />
  </div>
  <label class="comp-check" @click.stop>
    <input
      type="checkbox"
      :checked="comp.collider.isSensor"
      @change="emit('update', 'Set Collider Sensor', ($event.target as HTMLInputElement).checked)"
    />
    <span>传感器（只触发，不阻挡）</span>
  </label>
</template>
