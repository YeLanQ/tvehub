<script setup lang="ts">
/**
 * 相机（Camera）卡片 —— 参数按相机类型（工厂注册表 CameraTypeDef）数据驱动渲染：
 *   透视（Perspective，fov 取景，近小远大）/ 正交（Orthographic，orthoSize 取景，无近大远小）。
 * - 顶部：相机类型切换（切换后视锥辅助线/预览渲染随之重建）；
 * - 渲染分组：清除标志（天空盒/纯色/仅深度/仅颜色；纯色附带清屏色取色器）；
 * - 公共分组（Near/Far）任何类型都显示；
 * - 类型特有分组由工厂类型定义给出（透视 Fov / 正交 OrthoSize），切换类型后自动换组。
 */
import { computed } from "vue";
import { CameraNode } from "../../../framework/prototype/derived/Primitives";
import {
  CAMERA_CLEAR_FLAG_DEFS,
  COMMON_CAMERA_PARAM_GROUPS,
  cameraTypeRegistry,
  parseCameraClearFlags,
  type CameraParamKey,
} from "../../../framework/camera";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: CameraNode; rev?: number }>();

const emit = defineEmits<{
  editParam: [field: CameraParamKey, value: number];
  changeType: [type: string];
  editClearFlags: [flags: string];
  editClearColor: [color: number];
}>();

/** 已注册相机类型（类型下拉选项；特有分组也按当前类型 def 取） */
const typeOptions = cameraTypeRegistry.list();

/** 清除标志选项（下拉；顺序即展示顺序） */
const clearFlagOptions = CAMERA_CLEAR_FLAG_DEFS;

/**
 * 当前类型（相机类型决定属性面板渲染哪些特有参数）。
 * 节点是普通类实例（非响应式），computed 直接读 node.cameraType 不会建立依赖、
 * 切换类型后缓存不失效 → 分组停在旧类型；以 rev（面板刷新号）为失效信号。
 */
const typeDef = computed(() => {
  void props.rev;
  return cameraTypeRegistry.getOrDefault(props.node.cameraType);
});

/** 当前清除标志（以 rev 为失效信号；未知值按框架规则回退天空盒） */
const clearFlags = computed(() => {
  void props.rev;
  return parseCameraClearFlags(props.node.clearFlags);
});

/** 清除标志选项行为说明（title 提示） */
const clearFlagDesc = computed(
  () => clearFlagOptions.find((d) => d.key === clearFlags.value)?.desc ?? "",
);

function onTypeSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.cameraType) emit("changeType", v);
}

function onClearFlagsSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && parseCameraClearFlags(v) !== clearFlags.value) emit("editClearFlags", v);
}

/** 参数当前值（全部为节点数值字段） */
function paramValue(key: CameraParamKey): number {
  const v = props.node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 0xRRGGBB → #rrggbb（取色器） */
function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

/** #rrggbb → 0xRRGGBB（取色器；解析失败回退黑） */
function hexToNum(hex: string): number {
  const v = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(v) ? 0x000000 : v & 0xffffff;
}

function onClearColorInput(e: Event): void {
  emit("editClearColor", hexToNum((e.target as HTMLInputElement).value));
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

    <!-- 渲染分组：清除标志（预览/运行渲染的清屏方式与背景） -->
    <div class="cam-group">
      <span class="cam-group-title">渲染（Rendering）</span>
    </div>
    <div class="field">
      <label title="Clear Flags">清除标志</label>
      <select :value="clearFlags" :title="clearFlagDesc" @change="onClearFlagsSelect">
        <option
          v-if="!clearFlagOptions.some((d) => d.key === clearFlags)"
          :value="clearFlags"
          disabled
        >{{ clearFlags }}（未知标志）</option>
        <option v-for="def in clearFlagOptions" :key="def.key" :value="def.key">
          {{ def.label }}（{{ def.en }}）
        </option>
      </select>
    </div>
    <div v-if="clearFlags === 'solidColor'" class="field">
      <label title="Clear Color">纯色</label>
      <input
        type="color"
        :value="numToHex(node.clearColor)"
        title="清除标志为纯色时的背景色"
        @input="onClearColorInput"
        @change="onClearColorInput"
      />
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
