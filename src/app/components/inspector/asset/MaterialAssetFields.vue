<script setup lang="ts">
// ---------------------------------------------------------------------------
// 普通材质字段块（展示型，从 AssetInspector 抽出）：着色器下拉（内置/项目分组 +
// 未挂载/缺失占位项）+ 渲染分支标签 + 自定义着色器的组装错误与属性说明 +
// 参数编辑器（MaterialParamsEditor，普通材质走内建参数、自定义着色器走 props 镜像）。
// 只展示与上抛：着色器改写与参数编辑由父组件执行（引擎缓存 + 防抖写盘）。
// ---------------------------------------------------------------------------
import { shaderKindLabel, type MaterialParamGroup } from "../../../../framework/material";
import MaterialParamsEditor from "../MaterialParamsEditor.vue";

type AssetOption = { rel: string; name: string };

defineProps<{
  /** 参数展示镜像（自定义着色器 = props 镜像，其余 = 内建参数对象；由父组件持有） */
  local: Record<string, unknown>;
  /** 当前渲染分支的参数分组（自定义着色器由属性表动态构造） */
  groups: MaterialParamGroup[];
  /** 只读（内置材质） */
  disabled: boolean;
  /** 引用的着色器资产相对路径（空串 = 旧格式，按渲染分支走） */
  shader: string;
  /** 着色器资产候选（内置 + 项目，按来源分组） */
  shaderOptions: { internal: AssetOption[]; project: AssetOption[] };
  /** 引用的着色器不在候选内（文件被删/未挂载） */
  shaderMissing: boolean;
  /** 渲染分支 key（后端按 .mat 的 shader 引用解析） */
  matType: string;
  /** 是否自定义着色器（props 存值、参数来自属性表） */
  custom: boolean;
  /** 当前着色器的组装错误（null = 无错误；仅自定义着色器有值） */
  shaderError: string | null;
  /** 当前着色器暴露的属性项数（自定义着色器的说明文案用） */
  shaderPropCount: number;
}>();

const emit = defineEmits<{
  /** 改挂着色器（空串回退默认 PBR，由父组件解析渲染分支并写盘） */
  shaderChange: [v: string];
  /** 参数编辑（键 + 值，父组件写镜像/缓存并防抖落盘） */
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
  <div v-if="custom && shaderError" class="hint hint-error">
    着色器组装失败，视口显示占位材质：{{ shaderError }}
  </div>
  <div v-else-if="custom" class="hint">
    参数来自挂载着色器的 Properties（{{ shaderPropCount }} 项）；值写入本 .mat 的 props 字段。
  </div>
  <MaterialParamsEditor
    :local="local"
    :groups="groups"
    :disabled="disabled"
    @editParam="(key, value) => emit('editParam', key, value)"
  />
</template>
