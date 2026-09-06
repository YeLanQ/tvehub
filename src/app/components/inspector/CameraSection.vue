<script setup lang="ts">
/**
 * 相机（Camera）卡片 —— 参数按相机类型（工厂注册表 CameraTypeDef）数据驱动渲染：
 *   透视（Perspective，fov 取景，近小远大）/ 正交（Orthographic，orthoSize 取景，无近大远小）。
 * - 顶部：相机类型切换（切换后视锥辅助线/预览渲染随之重建）；
 * - 公共分组（Near/Far）任何类型都显示；
 * - 类型特有分组由工厂类型定义给出（透视 Fov / 正交 OrthoSize），切换类型后自动换组。
 */
import { computed } from "vue";
import { CameraNode } from "../../../framework/prototype/derived/Primitives";
import {
  COMMON_CAMERA_PARAM_GROUPS,
  cameraTypeRegistry,
  type CameraParamKey,
} from "../../../framework/camera";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: CameraNode; rev?: number }>();

const emit = defineEmits<{
  editParam: [field: CameraParamKey, value: number];
  changeType: [type: string];
}>();

/** 已注册相机类型（类型下拉选项；特有分组也按当前类型 def 取） */
const typeOptions = cameraTypeRegistry.list();

/** 当前类型（相机类型决定属性面板渲染哪些特有参数） */
const typeDef = computed(() => cameraTypeRegistry.getOrDefault(props.node.cameraType));

function onTypeSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.cameraType) emit("changeType", v);
}

/** 参数当前值（全部为节点数值字段） */
function paramValue(key: CameraParamKey): number {
  const v = props.node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
</script>

<template>
  <div class="cam-section" :data-rev="rev">
    <div class="field">
      <label>相机类型</label>
      <select
        :value="node.cameraType"
        title="切换后重建视锥辅助线并按新类型渲染预览"
        @change="onTypeSelect"
      >
        <option
          v-if="!typeOptions.some((d) => d.key === node.cameraType)"
          :value="node.cameraType"
          disabled
        >{{ node.cameraType }}（未注册类型）</option>
        <option v-for="def in typeOptions" :key="def.key" :value="def.key">{{ def.label }}</option>
      </select>
    </div>

    <!-- 公共参数（任何相机类型都显示） -->
    <template v-for="group in COMMON_CAMERA_PARAM_GROUPS" :key="group.title">
      <div class="cam-group">
        <span class="cam-group-title">{{ group.title }}</span>
      </div>
      <div v-for="def in group.defs" :key="def.key" class="field">
        <label :title="def.en">{{ def.label }}</label>
        <NumberField
          :model-value="paramValue(def.key)"
          :step="def.step ?? 0.01"
          :min="def.min"
          :max="def.max"
          :title="def.en"
          @commit="(v) => emit('editParam', def.key, v)"
        />
      </div>
    </template>

    <!-- 当前类型特有参数（透视 Fov / 正交 OrthoSize…） -->
    <template v-for="group in typeDef.paramGroups" :key="group.title">
      <div class="cam-group">
        <span class="cam-group-title">{{ group.title }}</span>
      </div>
      <div v-for="def in group.defs" :key="def.key" class="field">
        <label :title="def.en">{{ def.label }}</label>
        <NumberField
          :model-value="paramValue(def.key)"
          :step="def.step ?? 0.01"
          :min="def.min"
          :max="def.max"
          :title="def.en"
          @commit="(v) => emit('editParam', def.key, v)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.cam-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
  padding: 6px 0 2px;
  margin-top: 4px;
}
.cam-group-title {
  flex: 1 1 auto;
}
</style>
