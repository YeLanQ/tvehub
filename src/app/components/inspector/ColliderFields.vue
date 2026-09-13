<script setup lang="ts">
// 碰撞体组件字段区（组件卡片主体）：box/sphere/capsule/cylinder/convex/heightfield +
// 尺寸（自动包围盒或显式）/高度场分辨率/偏移/摩擦/弹性/传感器。启用开关与增删在卡片头。
import { HEIGHTFIELD_RESOLUTIONS } from "../../../framework/physics";
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
  { value: "heightfield", label: "高度场（Terrain）" },
];
const RESOLUTION_OPTIONS = HEIGHTFIELD_RESOLUTIONS;
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
  <template v-if="comp.collider.shape === 'heightfield'">
    <!-- 高度场：尺寸/自适应均来自地形网格，不适用；分辨率 = 碰撞 LOD -->
    <div class="field">
      <label
        title="每轴采样数（碰撞 LOD）。从地形烘焙网格等距取真实高度点：越小越省性能，越大碰撞越贴合；仅 terrainNode 有效"
      >
        碰撞分辨率
      </label>
      <select
        :value="comp.collider.resolution"
        @change="emit('update', 'Set Collider Resolution', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="r in RESOLUTION_OPTIONS" :key="r" :value="r">{{ r }} × {{ r }}</option>
      </select>
    </div>
    <div class="hint">高度场仅对 terrainNode 生效（读取其烘焙地形网格）；建议不挂刚体（隐式静态）。</div>
  </template>
  <template v-else>
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
