<script setup lang="ts">
/**
 * 天空盒（Skybox）卡片：
 * - 类型固定（创建时由菜单决定），只读展示；
 * - 「材质资产」选择与 Material 卡片完全一致（同一份实现 useMaterialAssetOptions）：
 *   内置材质（internal/materials/…） + 项目材质（assets/… 全部 .mat）。
 *   Skybox 使用的是一种特殊材质（.mat 中 shader/kind 区分程序化/立方体）；
 * - 天空配色（顶/地平线/下方）为节点参数，直接可调；
 * - 立方体天空盒额外展示「TextureCube 资产」选择（内置/项目 .texcube，立方体
 *   背景贴图；加载中/失败回退配色三段色带）；项目 .texcube 可就地编辑来源
 *   （等距柱状全景图 / 六面贴图），写盘后通知引擎重载天空。
 */
import { computed, ref, watch } from "vue";
import { SkyboxNode } from "../../../framework/prototype/derived/Primitives";
import { isInternalAsset } from "../../../lib/internal-assets";
import { useMaterialAssetOptions } from "../../lib/material-options";
import { getAssetsStore } from "../../stores/assets";
import { getProjectStore } from "../../stores/project";
import { logStore } from "../../stores/log";
import {
  loadTexCubeDoc,
  saveTexCubeDoc,
  TEXCUBE_FACE_KEYS,
  TEXCUBE_FACE_LABELS,
  type TexCubeAssetDoc,
  type TexCubeFaceKey,
} from "../../lib/texcube";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: SkyboxNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  setCubeMap: [rel: string];
  copyToProject: [];
  copyCubeToProject: [];
  /** 项目 .texcube 就地编辑并成功写盘后触发（rel），由面板通知引擎重载天空 */
  texCubeEdited: [rel: string];
  update: [label: string, value: unknown];
}>();

const assetsStore = getAssetsStore();
const projectStore = getProjectStore();

/** 材质资产选项（与 Material 卡片共用；内置 + 项目全部 .mat） */
const options = useMaterialAssetOptions(() => assetsStore.assets);

/** 当前类型（固定）。节点是普通类实例（非响应式）：以 rev 为失效信号 */
const kindLabel = computed(() => {
  void props.rev;
  return props.node.skyKind === "procedural" ? "程序化天空盒" : "立方体天空盒（TextureCube）";
});

/** 程序化 / 立方体的色项标签（同字段、不同语义命名） */
const colorLabels = computed<{ top: string; horizon: string; ground: string }>(() => {
  void props.rev;
  return props.node.skyKind === "procedural"
    ? { top: "天空顶部色", horizon: "地平线色", ground: "下方地面色" }
    : { top: "顶面颜色", horizon: "侧面颜色", ground: "底面颜色" };
});

const isInternal = computed(() => {
  // 切换/复制材质资产后徽标需跟随（node.material 原地修改，靠 rev 失效）
  void props.rev;
  return isInternalAsset(props.node.material);
});

// ---------------------------------------------------------------------------
// TextureCube（仅立方体天空盒）：资产选择 + 项目资产就地编辑
// ---------------------------------------------------------------------------

/** TextureCube 资产选项（内置 internal/… + 项目 assets/… 的全部 .texcube） */
const cubeOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (a.kind !== "texcube") continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: a.name });
    else project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

const isCubeMapInternal = computed(() => {
  void props.rev;
  return isInternalAsset(props.node.cubeMap);
});

/** 贴图来源候选（全景图/六面用）：内置 + 项目图片（png/jpg/webp/bmp/hdr） */
const imageOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (!["png", "jpg", "jpeg", "webp", "bmp", "hdr"].includes(a.kind)) continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: a.name });
    else project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

/** 当前绑定 .texcube 的解析内容（仅项目资产可编辑；internal 只读展示参数） */
const cubeDoc = ref<TexCubeAssetDoc | null>(null);

async function reloadCubeDoc(): Promise<void> {
  void props.rev;
  const rel = props.node.cubeMap;
  if (!rel) {
    cubeDoc.value = null;
    return;
  }
  const doc = await loadTexCubeDoc(projectStore.currentPath, rel);
  // 异步返回时引用可能已切换：过期结果丢弃
  if (props.node.cubeMap === rel) cubeDoc.value = doc;
}

watch(
  () => [props.rev, props.node.cubeMap, projectStore.currentPath] as const,
  () => void reloadCubeDoc(),
  { immediate: true },
);

/** 就地改写绑定的项目 .texcube：写盘成功后通知引擎重载天空 */
async function editCubeDoc(mutate: (doc: TexCubeAssetDoc) => void): Promise<void> {
  const rel = props.node.cubeMap;
  const doc = cubeDoc.value;
  const root = projectStore.currentPath;
  if (!rel || !doc || !root || isInternalAsset(rel)) return;
  mutate(doc);
  cubeDoc.value = { ...doc, faces: { ...doc.faces } };
  try {
    await saveTexCubeDoc(root, rel, doc);
    emit("texCubeEdited", rel);
  } catch (e) {
    logStore.log("error", `保存 TextureCube ${rel} 失败: ${e}`);
  }
}

function onCubeSourceChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value === "faces" ? "faces" : "equirect";
  void editCubeDoc((doc) => {
    doc.source = v;
  });
}

function onCubeMapChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  void editCubeDoc((doc) => {
    doc.map = v;
  });
}

function onCubeFaceChange(key: TexCubeFaceKey, e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  void editCubeDoc((doc) => {
    if (v) doc.faces[key] = v;
    else delete doc.faces[key];
  });
}

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}

function onCubeMapSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.cubeMap) emit("setCubeMap", v);
}

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function hexToNum(hex: string): number {
  const v = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(v) ? 0xffffff : v & 0xffffff;
}

function onColorChange(key: "top" | "horizon" | "ground", hex: string): void {
  const label =
    key === "top" ? "Set Top Color" : key === "horizon" ? "Set Horizon Color" : "Set Ground Color";
  emit("update", label, hexToNum(hex));
}

function onSunDiskChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  emit("update", "Set Sun Disk", v);
}

function onSunColorChange(e: Event): void {
  const hex = (e.target as HTMLInputElement).value;
  emit("update", "Set Sun Color", hexToNum(hex));
}

function onSunNumber(label: string, v: number): void {
  emit("update", label, v);
}
</script>

<template>
  <div :data-rev="rev">
    <div class="field">
      <label>类型</label>
      <span class="type-tag">{{ kindLabel }}</span>
      <span class="muted">创建后固定</span>
    </div>

    <div class="field">
      <label>材质资产</label>
      <select :value="node.material" @change="onSelect">
        <optgroup label="内置材质">
          <option v-for="o in options.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup label="项目材质">
          <option v-if="options.project.length === 0" value="" disabled>
            （assets/materials 下暂无材质）
          </option>
          <option v-for="o in options.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
      </select>
    </div>

    <div class="sky-mat-meta">
      <span class="sky-mat-badge" :class="{ internal: isInternal }">
        {{ isInternal ? "内置 · 只读" : "项目材质" }}
      </span>
      <span class="sky-mat-rel mono">{{ node.material }}</span>
      <button
        v-if="isInternal"
        class="sky-mat-btn"
        title="复制为项目材质资产并绑定到本节点"
        @click="emit('copyToProject')"
      >
        复制到项目材质
      </button>
    </div>

    <!-- 立方体天空盒：TextureCube 背景贴图 -->
    <template v-if="node.skyKind === 'cube'">
      <div class="field">
        <label>TextureCube</label>
        <select :value="node.cubeMap" @change="onCubeMapSelect">
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
      <div class="sky-mat-meta">
        <span class="sky-mat-badge" :class="{ internal: isCubeMapInternal }">
          {{ isCubeMapInternal ? "内置 · 只读" : "项目 TextureCube" }}
        </span>
        <span class="sky-mat-rel mono">{{ node.cubeMap || "（未绑定）" }}</span>
        <button
          v-if="isCubeMapInternal"
          class="sky-mat-btn"
          title="复制为项目 TextureCube 资产并绑定到本节点"
          @click="emit('copyCubeToProject')"
        >
          复制到项目
        </button>
      </div>

      <!-- 项目 TextureCube：来源就地编辑（internal 只读） -->
      <template v-if="cubeDoc && !isCubeMapInternal">
        <div class="field">
          <label>贴图来源</label>
          <select :value="cubeDoc.source" @change="onCubeSourceChange">
            <option value="equirect">等距柱状全景图</option>
            <option value="faces">六面贴图（±X ±Y ±Z）</option>
          </select>
        </div>
        <div v-if="cubeDoc.source === 'equirect'" class="field">
          <label>全景图</label>
          <select :value="cubeDoc.map" @change="onCubeMapChange">
            <option value="">（无）</option>
            <optgroup label="内置图片">
              <option v-for="o in imageOptions.internal" :key="o.rel" :value="o.rel">
                {{ o.name }}
              </option>
            </optgroup>
            <optgroup label="项目图片">
              <option v-for="o in imageOptions.project" :key="o.rel" :value="o.rel">
                {{ o.name }}
              </option>
            </optgroup>
          </select>
        </div>
        <template v-else>
          <div v-for="key in TEXCUBE_FACE_KEYS" :key="key" class="field">
            <label>{{ TEXCUBE_FACE_LABELS[key] }}</label>
            <select :value="cubeDoc.faces[key] ?? ''" @change="onCubeFaceChange(key, $event)">
              <option value="">（无）</option>
              <optgroup label="内置图片">
                <option v-for="o in imageOptions.internal" :key="o.rel" :value="o.rel">
                  {{ o.name }}
                </option>
              </optgroup>
              <optgroup label="项目图片">
                <option v-for="o in imageOptions.project" :key="o.rel" :value="o.rel">
                  {{ o.name }}
                </option>
              </optgroup>
            </select>
          </div>
        </template>
      </template>
    </template>

    <div class="field">
      <label>{{ colorLabels.top }}</label>
      <input
        type="color"
        :value="numToHex(node.topColor)"
        @input="(e) => onColorChange('top', (e.target as HTMLInputElement).value)"
        @change="onColorChange('top', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="field">
      <label>{{ colorLabels.horizon }}</label>
      <input
        type="color"
        :value="numToHex(node.horizonColor)"
        @input="(e) => onColorChange('horizon', (e.target as HTMLInputElement).value)"
        @change="onColorChange('horizon', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="field">
      <label>{{ colorLabels.ground }}</label>
      <input
        type="color"
        :value="numToHex(node.groundColor)"
        @input="(e) => onColorChange('ground', (e.target as HTMLInputElement).value)"
        @change="onColorChange('ground', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div v-if="node.skyKind === 'cube'" class="muted sky-cube-note">
      立方体贴图未绑定或加载中时，以上配色作为三段色带兜底显示
    </div>

    <!-- 程序化天空专属：太阳参数 -->
    <template v-if="node.skyKind === 'procedural'">
      <div class="sky-sun-head">太阳</div>
      <div class="field">
        <label>太阳盘</label>
        <select :value="node.sunDisk" @change="onSunDiskChange">
          <option value="high">高精度（光晕）</option>
          <option value="simple">简化（纯亮盘）</option>
          <option value="none">无</option>
        </select>
      </div>
      <div class="field">
        <label>太阳颜色</label>
        <input
          type="color"
          :value="numToHex(node.sunColor)"
          @input="onSunColorChange"
          @change="onSunColorChange"
        />
      </div>
      <div class="field">
        <label>太阳大小</label>
        <NumberField
          :model-value="node.sunSize"
          :step="0.5"
          :min="0.2"
          :max="30"
          title="太阳盘半径（度）"
          @commit="(v) => onSunNumber('Set Sun Size', v)"
        />
      </div>
      <div class="field">
        <label>光晕强度</label>
        <NumberField
          :model-value="node.sunGlow"
          :step="0.05"
          :min="0"
          :max="1"
          title="光晕强度（0~1；颜色与太阳颜色一致）"
          @commit="(v) => onSunNumber('Set Sun Glow', v)"
        />
      </div>
      <div class="field">
        <label>方位角</label>
        <NumberField
          :model-value="node.sunAzimuth"
          :step="5"
          :min="0"
          :max="360"
          title="太阳方位角（度，0 = +X）"
          @commit="(v) => onSunNumber('Set Sun Azimuth', v)"
        />
      </div>
      <div class="field">
        <label>仰角</label>
        <NumberField
          :model-value="node.sunElevation"
          :step="1"
          :min="0"
          :max="360"
          title="太阳仰角（度：0=地平线，90=天顶，180=对侧地平线，270=正下方，360=回到地平线）"
          @commit="(v) => onSunNumber('Set Sun Elevation', v)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.sky-mat-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sky-mat-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #888);
  color: var(--text-dim, #888);
}
.sky-mat-badge:not(.internal) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.sky-mat-rel {
  flex: 1 1 auto;
  min-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim, #999);
}
.sky-mat-btn {
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
.sky-mat-btn:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.sky-cube-note {
  font-size: 11px;
  padding: 2px 0 4px;
}
.sky-sun-head {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
  padding: 6px 0 2px;
  margin-top: 4px;
}
</style>
