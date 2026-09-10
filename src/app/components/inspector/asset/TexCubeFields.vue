<script setup lang="ts">
// ---------------------------------------------------------------------------
// TextureCube 资产字段块（展示型，从 AssetInspector 抽出）：贴图来源（等距柱状
// 全景 / 六面）+ 全景图或六面各自的贴图引用下拉（内置 + 项目图片分组）。
// 只读展示 + 编辑动作上抛：父组件执行 .texcube 写盘与天空/预览刷新；内置资产
// 由父组件传入 disabled 统一置灰（可先「复制到项目」）。
// ---------------------------------------------------------------------------
import {
  TEXCUBE_FACE_KEYS,
  TEXCUBE_FACE_LABELS,
  type TexCubeAssetDoc,
  type TexCubeFaceKey,
} from "../../../lib/texcube";

type AssetOption = { rel: string; name: string };

defineProps<{
  /** 已读取的 .texcube 文档（读取中/失败为 null） */
  doc: TexCubeAssetDoc | null;
  /** 只读（内置资产） */
  disabled: boolean;
  /** 贴图来源候选（内置 internal/… + 项目图片，按来源分组） */
  imageOptions: { internal: AssetOption[]; project: AssetOption[] };
}>();

const emit = defineEmits<{
  /** 切换贴图来源模式（equirect 等距柱状 / faces 六面） */
  source: [v: "equirect" | "faces"];
  /** 切换全景图引用（空串 = 无） */
  map: [v: string];
  /** 切换某一面的贴图引用（空串 = 删除该面） */
  face: [key: TexCubeFaceKey, v: string];
}>();

function onSourceChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value === "faces" ? "faces" : "equirect";
  emit("source", v);
}

function onMapChange(e: Event): void {
  emit("map", (e.target as HTMLSelectElement).value);
}

function onFaceChange(key: TexCubeFaceKey, e: Event): void {
  emit("face", key, (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="field">
    <label>来源</label>
    <select
      :value="doc?.source ?? 'equirect'"
      :disabled="disabled"
      :title="disabled ? '内置 TextureCube 只读；请先复制到项目' : '切换贴图来源模式'"
      @change="onSourceChange"
    >
      <option value="equirect">等距柱状全景图</option>
      <option value="faces">六面贴图（±X ±Y ±Z）</option>
    </select>
  </div>
  <template v-if="doc && doc.source === 'faces'">
    <div
      v-for="k in TEXCUBE_FACE_KEYS"
      :key="k"
      class="field"
    >
      <label>{{ TEXCUBE_FACE_LABELS[k] }}</label>
      <select
        :value="doc.faces[k] ?? ''"
        :disabled="disabled"
        @change="onFaceChange(k, $event)"
      >
        <option value="">（无）</option>
        <optgroup label="内置图片">
          <option v-for="o in imageOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
        <optgroup label="项目图片">
          <option v-if="imageOptions.project.length === 0" value="" disabled>
            （项目中暂无图片资产）
          </option>
          <option v-for="o in imageOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
      </select>
    </div>
  </template>
  <div v-else class="field">
    <label>全景图</label>
    <select
      :value="doc?.map ?? ''"
      :disabled="disabled"
      @change="onMapChange"
    >
      <option value="">（无）</option>
      <optgroup label="内置图片">
        <option v-for="o in imageOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </optgroup>
      <optgroup label="项目图片">
        <option v-if="imageOptions.project.length === 0" value="" disabled>
          （项目中暂无图片资产）
        </option>
        <option v-for="o in imageOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </optgroup>
    </select>
  </div>
  <div class="hint">
    {{ disabled ? "内置 TextureCube 只读；复制到项目后可更换贴图。" : "写入 .texcube 资产；被天空盒节点绑定时背景即时刷新。" }}
  </div>
</template>
