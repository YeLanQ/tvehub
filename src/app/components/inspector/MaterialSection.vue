<script setup lang="ts">
/**
 * 材质资产（Material）卡片内容：
 * - 顶部：材质资产选择（内置 internal/… 只读 / 项目 assets/materials/… 可写）
 * - 中部：当前材质资产参数（颜色/自发光/金属度/粗糙度/线框）
 *
 * 显示值维护一份本地响应式镜像（local），由两路监听驱动刷新：
 * - node.material（切换材质引用）
 * - rev（属性/材质库每次变更后的 revision，编辑参数后引擎缓存已更新）
 * 这样无论“切换材质”还是“就地改参数”，面板都立即显示最新值，
 * 不依赖被动重渲染时机。
 *
 * 参数修改写入 .mat 资产文件（共享语义：引用该资产的所有网格同步变化）；
 * 内置材质只读，先「复制到项目材质」转为项目资产后才能编辑。
 */
import { computed, reactive, ref, watch } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import {
  colorToHexString,
  materialFileStem,
  parseColorHex,
  type MaterialParamKey,
  type MaterialParams,
} from "../../../framework/material";
import { isInternalAsset, INTERNAL_MATERIAL_ITEMS } from "../../../lib/internal-assets";
import { getAssetsStore } from "../../stores/assets";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  (e: "setMaterial", rel: string): void;
  (e: "editParam", field: MaterialParamKey, value: number | boolean): void;
  (e: "copyToProject"): void;
}>();

const editorStore = getEditorStore();
const assetsStore = getAssetsStore();

/** 材质资产选项（内置在前，项目材质在后；按相对路径去重） */
const options = computed(() => {
  const seen = new Set<string>();
  const internal = INTERNAL_MATERIAL_ITEMS.filter((i) => {
    if (seen.has(i.rel)) return false;
    seen.add(i.rel);
    return true;
  }).map((i) => ({ rel: i.rel, name: i.name, internal: true }));
  const project = assetsStore.assets
    .filter(
      (a) => a.kind === "mat" && a.path.startsWith("assets/") && !isInternalAsset(a.path),
    )
    .filter((a) => {
      if (seen.has(a.path)) return false;
      seen.add(a.path);
      return true;
    })
    .map((a) => ({ rel: a.path, name: materialFileStem(a.path), internal: false }));
  return { internal, project };
});

// ---------------------------------------------------------------------------
// 本地镜像：唯一展示源。切换材质 / 参数被编辑后由 syncFromEngine 刷新
// ---------------------------------------------------------------------------
const local = reactive({
  rel: "",
  internal: false,
  color: "#9aa4b2",
  emissive: "#000000",
  metalness: 0.1,
  roughness: 0.75,
  wireframe: false,
});

function paramsFromEngine(rel: string): MaterialParams {
  return editorStore.engine.materials.paramsFor(rel);
}

function syncFromEngine(): void {
  const rel = props.node?.material ?? "";
  const p = paramsFromEngine(rel);
  local.rel = rel;
  local.internal = isInternalAsset(rel);
  local.color = colorToHexString(p.color);
  local.emissive = colorToHexString(p.emissive);
  local.metalness = p.metalness;
  local.roughness = p.roughness;
  local.wireframe = p.wireframe;
}

// 材质引用变化 → 立即同步（切换内置/项目材质场景）
watch(
  () => props.node?.material,
  () => syncFromEngine(),
  { immediate: true },
);
// revision 变化（含材质参数编辑后 engine 广播的 material:changed）→ 刷新最新缓存值
watch(
  () => props.rev,
  () => syncFromEngine(),
);

/** 供模板响应式读取的镜像字段 */
const rel = ref("");
const isInternal = ref(false);

watch(
  local,
  () => {
    rel.value = local.rel;
    isInternal.value = local.internal;
  },
  { immediate: true },
);

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}

function onColorInput(field: "color" | "emissive", e: Event): void {
  const hex = (e.target as HTMLInputElement).value;
  const n = parseColorHex(hex);
  // 先就地更新镜像（即时反馈），再交给父层持久化
  if (field === "color") local.color = hex;
  else local.emissive = hex;
  emit("editParam", field, n);
}

function onNumberCommit(field: "metalness" | "roughness", v: number): void {
  if (field === "metalness") local.metalness = v;
  else local.roughness = v;
  emit("editParam", field, v);
}

function onWireframeChange(e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  local.wireframe = v;
  emit("editParam", "wireframe", v);
}
</script>

<template>
  <div class="mat-section" :data-rev="rev">
    <div class="field">
      <label>材质资产</label>
      <select :value="node.material" @change="onSelect">
        <optgroup label="内置材质">
          <option v-for="o in options.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup label="项目材质">
          <option v-if="options.project.length === 0" value="" disabled>（assets/materials 下暂无材质）</option>
          <option v-for="o in options.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
      </select>
    </div>

    <div class="field mat-meta">
      <span class="mat-badge" :class="{ internal: isInternal }">
        {{ isInternal ? "内置 · 只读" : "项目材质" }}
      </span>
      <span class="mat-rel mono">{{ rel }}</span>
      <button
        class="mat-btn"
        :title="isInternal ? '复制为项目材质资产并绑定到本节点（可编辑）' : '从当前材质新建一份独立副本并绑定到本节点'"
        @click="emit('copyToProject')"
      >
        {{ isInternal ? "复制到项目材质" : "另存副本" }}
      </button>
    </div>

    <div v-if="isInternal" class="hint">内置材质只读；如需调整参数，请先「复制到项目材质」。</div>
    <div v-else class="hint">参数会写入 .mat 资产文件，引用该材质的所有网格同步更新。</div>

    <div class="field" :title="isInternal ? '材质只读' : undefined">
      <label>颜色</label>
      <input
        type="color"
        :value="local.color"
        :disabled="isInternal"
        @input="onColorInput('color', $event)"
      />
    </div>
    <div class="field">
      <label>自发光</label>
      <input
        type="color"
        :value="local.emissive"
        :disabled="isInternal"
        @input="onColorInput('emissive', $event)"
      />
    </div>
    <div class="field">
      <label>金属度</label>
      <NumberField
        :model-value="local.metalness"
        :step="0.05"
        :min="0"
        :max="1"
        :disabled="isInternal"
        title="金属度"
        @commit="(v) => onNumberCommit('metalness', v)"
      />
    </div>
    <div class="field">
      <label>粗糙度</label>
      <NumberField
        :model-value="local.roughness"
        :step="0.05"
        :min="0"
        :max="1"
        :disabled="isInternal"
        title="粗糙度"
        @commit="(v) => onNumberCommit('roughness', v)"
      />
    </div>
    <div class="field">
      <label>线框</label>
      <input
        type="checkbox"
        :checked="local.wireframe"
        :disabled="isInternal"
        @change="onWireframeChange"
      />
    </div>
  </div>
</template>

<style scoped>
.mat-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.mat-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.mat-badge.internal {
  border-color: var(--text-dim, #888);
  color: var(--text-dim, #888);
}
.mat-rel {
  flex: 1 1 auto;
  min-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim, #999);
}
.mat-btn {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.mat-btn:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
</style>
