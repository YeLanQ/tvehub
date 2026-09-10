<script setup lang="ts">
// ---------------------------------------------------------------------------
// 天空材质字段块（展示型，从 AssetInspector 抽出）：天空类型/挂载着色器只读行 +
// 立方体天空（TextureCube 引用 + 旋转/强度/世界不透明度/模糊）与程序化 Nishita
// 天空（多重散射/日轮 + 太阳/大气参数）两组可编辑参数。
// 只展示与上抛：父组件持有天空文档、执行整卡 JSON 防抖写回与引擎重载；
// disabled 统一置灰内置资产。
// ---------------------------------------------------------------------------
import type { SkyMatDoc } from "../../../lib/sky-mat";
import NumberField from "../../NumberField.vue";

type AssetOption = { rel: string; name: string };

/** 程序化天空的数值参数键（父组件按键写回文档） */
type SkyParamKey =
  | "rotation"
  | "strength"
  | "worldOpacity"
  | "blur"
  | "sunSize"
  | "sunStrength"
  | "sunElevation"
  | "sunRotation"
  | "altitude"
  | "air"
  | "dust"
  | "ozone";

defineProps<{
  /** 已读取的天空材质文档（父组件仅在读到文档后渲染本组件） */
  doc: SkyMatDoc;
  /** 挂载的天空着色器引用（创建时固定；旧格式为魔法串） */
  shaderRef: string;
  /** 只读（内置天空材质） */
  disabled: boolean;
  /** 立方体天空的 TextureCube 候选（内置 + 项目，按来源分组） */
  cubeOptions: { internal: AssetOption[]; project: AssetOption[] };
}>();

const emit = defineEmits<{
  /** 切换立方体天空绑定的 TextureCube */
  cubeMap: [v: string];
  /** 数值参数编辑（键 + 值） */
  param: [key: SkyParamKey, v: number];
  /** 布尔参数编辑（多重散射 / 日轮） */
  checkbox: [key: "sunDisc" | "ms", v: boolean];
}>();

function onCubeMapChange(e: Event): void {
  emit("cubeMap", (e.target as HTMLSelectElement).value);
}

function onParam(key: SkyParamKey, v: number): void {
  emit("param", key, v);
}

function onCheckbox(key: "sunDisc" | "ms", e: Event): void {
  emit("checkbox", key, (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="field">
    <label>天空类型</label>
    <span class="type-tag">
      {{ doc.kind === "cube" ? "立方体天空盒（创建时固定）" : "程序化天空（创建时固定）" }}
    </span>
  </div>
  <div class="field">
    <label>挂载着色器</label>
    <span class="muted mono asset-rel">{{ shaderRef }}</span>
  </div>

  <!-- 立方体：TextureCube 纹理 + 旋转/强度/世界不透明度/模糊 -->
  <template v-if="doc.kind === 'cube'">
    <div class="field">
      <label>TextureCube</label>
      <select
        :value="doc.cubeMap"
        :disabled="disabled"
        title="立方体天空的贴图来源（.texcube 资产）"
        @change="onCubeMapChange"
      >
        <optgroup label="内置 TextureCube">
          <option v-for="o in cubeOptions.internal" :key="o.rel" :value="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
        <optgroup label="项目 TextureCube">
          <option v-if="cubeOptions.project.length === 0" value="" disabled>
            （项目内暂无 .texcube，可在资产面板「新建 TextureCube」）
          </option>
          <option v-for="o in cubeOptions.project" :key="o.rel" :value="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
      </select>
    </div>
    <div class="field">
      <label>旋转</label>
      <NumberField
        :model-value="doc.rotation"
        :step="1"
        :min="0"
        :max="360"
        :disabled="disabled"
        title="绕世界 Y 轴旋转（度）"
        @commit="(v) => onParam('rotation', v)"
      />
    </div>
    <div class="field">
      <label>强度</label>
      <NumberField
        :model-value="doc.strength"
        :step="0.01"
        :min="0"
        :max="16"
        :disabled="disabled"
        title="背景亮度倍率"
        @commit="(v) => onParam('strength', v)"
      />
    </div>
    <div class="field">
      <label>世界不透明度</label>
      <NumberField
        :model-value="doc.worldOpacity"
        :step="0.01"
        :min="0"
        :max="1"
        :disabled="disabled"
        title="世界不透明度（保留参数）"
        @commit="(v) => onParam('worldOpacity', v)"
      />
    </div>
    <div class="field">
      <label>模糊</label>
      <NumberField
        :model-value="doc.blur"
        :step="0.01"
        :min="0"
        :max="1"
        :disabled="disabled"
        title="背景模糊（0~1）"
        @commit="(v) => onParam('blur', v)"
      />
    </div>
    <div class="hint">
      {{ disabled ? "内置天空材质只读；复制到项目后可编辑。" : "写入 .mat 资产；被天空盒节点绑定时背景与参数即时生效。" }}
    </div>
  </template>

  <!-- 程序化：Blender 天空纹理参数（Nishita 大气散射） -->
  <template v-else>
    <label class="sky-checkbox">
      <input
        type="checkbox"
        :checked="doc.ms"
        :disabled="disabled"
        @change="onCheckbox('ms', $event)"
      />
      <span>多重散射</span>
    </label>
    <label class="sky-checkbox">
      <input
        type="checkbox"
        :checked="doc.sunDisc"
        :disabled="disabled"
        @change="onCheckbox('sunDisc', $event)"
      />
      <span>日轮</span>
    </label>
    <div class="field">
      <label>太阳尺寸</label>
      <NumberField
        :model-value="doc.sunSize"
        :step="0.1"
        :min="0.1"
        :max="30"
        :disabled="disabled"
        title="太阳圆盘全角尺寸（度）"
        @commit="(v) => onParam('sunSize', v)"
      />
    </div>
    <div class="field">
      <label>太阳强度</label>
      <NumberField
        :model-value="doc.sunStrength"
        :step="0.1"
        :min="0"
        :max="20"
        :disabled="disabled"
        title="太阳圆盘亮度倍率"
        @commit="(v) => onParam('sunStrength', v)"
      />
    </div>
    <div class="field">
      <label>太阳高度</label>
      <NumberField
        :model-value="doc.sunElevation"
        :step="0.5"
        :min="-90"
        :max="90"
        :disabled="disabled"
        title="太阳高度角（度，0=地平线）"
        @commit="(v) => onParam('sunElevation', v)"
      />
    </div>
    <div class="field">
      <label>太阳旋转</label>
      <NumberField
        :model-value="doc.sunRotation"
        :step="1"
        :min="0"
        :max="360"
        :disabled="disabled"
        title="太阳方位角（度）"
        @commit="(v) => onParam('sunRotation', v)"
      />
    </div>
    <div class="field">
      <label>海拔</label>
      <NumberField
        :model-value="doc.altitude"
        :step="10"
        :min="0"
        :max="20000"
        :disabled="disabled"
        title="观察点海拔（米）"
        @commit="(v) => onParam('altitude', v)"
      />
    </div>
    <div class="field">
      <label>空气</label>
      <NumberField
        :model-value="doc.air"
        :step="0.01"
        :min="0"
        :max="10"
        :disabled="disabled"
        title="空气密度（瑞利散射倍率）"
        @commit="(v) => onParam('air', v)"
      />
    </div>
    <div class="field">
      <label>气溶胶</label>
      <NumberField
        :model-value="doc.dust"
        :step="0.01"
        :min="0"
        :max="10"
        :disabled="disabled"
        title="气溶胶密度（米氏散射倍率）"
        @commit="(v) => onParam('dust', v)"
      />
    </div>
    <div class="field">
      <label>臭氧</label>
      <NumberField
        :model-value="doc.ozone"
        :step="0.01"
        :min="0"
        :max="10"
        :disabled="disabled"
        title="臭氧密度（吸收倍率）"
        @commit="(v) => onParam('ozone', v)"
      />
    </div>
    <div class="hint">
      {{ disabled ? "内置天空材质只读；复制到项目后可编辑。" : "Nishita 大气散射（Blender 天空纹理风格）；写入 .mat 资产，被天空盒节点绑定时背景即时刷新。" }}
    </div>
  </template>
</template>

<style scoped>
.sky-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 2px 0;
}
.sky-checkbox input {
  margin: 0;
}
.sky-checkbox input:disabled + span {
  color: var(--text-dim, #999);
}
.asset-rel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
</style>
