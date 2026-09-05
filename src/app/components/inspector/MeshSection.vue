<script setup lang="ts">
import type { GeometryKind } from "../../../framework/prototype/derived/Primitives";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";

defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

function onGeometryChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value as GeometryKind;
  emit("update", "Set Geometry", value);
}
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>Geometry</label>
    <select :value="node.geometry" @change="onGeometryChange($event)">
      <option value="box">Box</option>
      <option value="sphere">Sphere</option>
      <option value="cylinder">Cylinder</option>
      <option value="plane">Plane</option>
    </select>
  </div>
  <!-- 材质参数（颜色/金属度/粗糙度/自发光/线框）已资产化，见 Material 卡片 -->
</template>
