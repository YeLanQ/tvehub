<script setup lang="ts">
// ---------------------------------------------------------------------------
// 普通材质字段块（展示型，从 AssetInspector 抽出）：着色器下拉（内置/项目分组 +
// 未挂载/缺失占位项）+ 渲染分支标签 + 着色器解析错误 + 参数编辑器
// （MaterialParamsEditor：分支参数与着色器 Properties 参数同卡呈现）。
// 只展示与上抛：着色器改写与参数编辑由父组件执行（引擎缓存 + 防抖写盘）。
// ---------------------------------------------------------------------------
import { shaderKindLabel, type MaterialParamGroup } from "../../../../framework/material";
import MaterialParamsEditor from "../MaterialParamsEditor.vue";

type AssetOption = { rel: string; name: string };

defineProps<{
  /** 分支参数展示镜像 + 着色器参数镜像（父组件合并持有） */
  local: Record<string, unknown>;
  /** 参数分组：分支参数分组 + 着色器 Properties 分组 */
  groups: MaterialParamGroup[];
  /** 只读（内置材质） */
  disabled: boolean;
  /** 引用的着色器资产相对路径（空串 = 旧格式，按渲染分支走） */
  shader: string;
  /** 着色器资产候选（内置 + 项目，按来源分组） */
  shaderOptions: { internal: AssetOption[]; project: AssetOption[] };
  /** 引用的着色器不在候选内（文件被删/未挂载） */
  shaderMissing: boolean;
  /** 渲染分支 key（由所挂着色器的 Base 解析） */
  matType: string;
  /** 着色器解析错误（null = 无错误；非 null 时仍按分支渲染，只是不叠效果） */
  shaderError: string | null;
}>();

const emit = defineEmits<{
  /** 改挂着色器（空串回退默认 PBR，由父组件解析渲染分支并写盘） */
  shaderChange: [v: string];
  /** 参数编辑（键 + 值，父组件按“分支字段 / 着色器属性”分流写盘） */
  editParam: [key: string, value: number | boolean | string | number[]];
}>();

function onShaderChange(e: Event): void {
  emit("shaderChange", (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="field">
    <label>着色器</label>
    <select :value="shader" :disabled="disabled" @change="onShaderChange">
      <option v-if="!shader" value="" disabled>（未挂载，默认 PBR）</option>
      <option v-if="shaderMissing" :value="shader" disabled>
        {{ shader }}（缺失）
      </option>
      <optgroup label="内置着色器">
        <option v-for="o in shaderOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </optgroup>
      <optgroup label="项目着色器">
        <option v-if="shaderOptions.project.length === 0" value="" disabled>
          （项目内暂无 .shader，可在资产面板「新建着色器」）
        </option>
        <option v-for="o in shaderOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </optgroup>
    </select>
  </div>
  <div class="field">
    <label>渲染分支</label>
    <span class="type-tag">{{ shaderKindLabel(matType) }}</span>
  </div>
  <div v-if="shaderError" class="hint hint-error">
    着色器解析失败（仍按当前分支渲染，只是不叠加效果）：{{ shaderError }}
  </div>
  <MaterialParamsEditor
    :local="local"
    :groups="groups"
    :disabled="disabled"
    @editParam="(key, value) => emit('editParam', key, value)"
  />
</template>
