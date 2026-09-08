<script setup lang="ts">
/**
 * 资产检查器：资产面板选中资产后的预览 + 暴露属性（属性面板资产模式）。
 * - 纹理（png/jpg/webp/bmp/gif/svg）：原图预览 + 尺寸/大小；
 * - hdr / TextureCube：全景背景预览 + 引用信息；
 * - 材质（.mat）：材质球实时预览 + 挂载着色器暴露的全部参数（项目资产可编辑，
 *   300ms 防抖写盘；写入引擎缓存使引用网格即时刷新）；天空材质（引用内置
 *   天空着色器）暴露类型与三段配色，整卡 JSON 写回；
 * - 着色器（.shader）：渲染程序源码展示（PBR/Unlit/卡通，类型创建时固定），
 *   决定引用它的材质走哪个渲染分支；
 * - 模型（glb/gltf/fbx/obj）：模型实例预览 + 动画/内嵌材质/骨骼信息；
 * - 场景/脚本/其它：基础信息与操作提示。
 * 内置资产只读，提供「复制到项目」。
 */
import { computed, reactive, ref, watch } from "vue";
import {
  DEFAULT_MATERIAL_TYPE,
  DEFAULT_SHADER_REL,
  materialFileStem,
  materialTypeRegistry,
  shaderFileStem,
  shaderKindLabel,
  type MaterialEnableKey,
  type MaterialParamGroup,
  type MaterialParamKey,
  type ShaderDoc,
} from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import { assetUrl } from "../../../lib/asset-url";
import { getAssetsStore, type AssetsStore } from "../../stores/assets";
import { getProjectStore } from "../../stores/project";
import { getEditorStore } from "../../stores/editor";
import { logStore } from "../../stores/log";
import { assetService } from "../../services/assetService";
import { saveMaterialParams } from "../../lib/materials";
import { loadShaderDoc, loadShaderKind } from "../../lib/shaders";
import { fmtSize } from "../../lib/format";
import { api } from "../../../lib/api";
import { instantiatePrefabAsset } from "../../lib/prefabs";
import {
  loadTexCubeDoc,
  saveTexCubeDoc,
  TEXCUBE_FACE_KEYS,
  TEXCUBE_FACE_LABELS,
  type TexCubeAssetDoc,
  type TexCubeFaceKey,
} from "../../lib/texcube";
import { loadSkyMatDoc, saveSkyMatDoc, type SkyMatDoc } from "../../lib/sky-mat";
import { isAudioAssetRel } from "../../../framework/audio";
import type { MaterialParams } from "../../../framework/material";
import MaterialParamsEditor from "./MaterialParamsEditor.vue";
import AssetPreview3D from "./AssetPreview3D.vue";
import NumberField from "../NumberField.vue";

const props = defineProps<{ rel: string }>();

const assetsStore: AssetsStore = getAssetsStore();
const projectStore = getProjectStore();
const editorStore = getEditorStore();

const IMAGE_KINDS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "svg"]);
const MODEL_KINDS = new Set(["glb", "gltf", "fbx", "obj"]);

const entry = computed(() => assetsStore.assets.find((a) => a.path === props.rel));
const kind = computed(() => entry.value?.kind ?? props.rel.split(".").pop()?.toLowerCase() ?? "");
const name = computed(() => entry.value?.name ?? props.rel.split("/").pop() ?? props.rel);
const isInternal = computed(() => isInternalAsset(props.rel));
const root = computed(() => projectStore.currentPath);

const previewKind = computed<
  "material" | "model" | "sky" | "hdr" | "texcube" | null
>(() => {
  if (kind.value === "hdr") return "hdr";
  if (kind.value === "texcube") return "texcube";
  if (kind.value === "mat") {
    if (!isSkyMat.value) return "material";
    // 立方体天空材质预览其绑定的 TextureCube；程序化预览三段色带
    return skyDoc.value?.kind === "cube" ? "texcube" : "sky";
  }
  if (MODEL_KINDS.has(kind.value)) return "model";
  return null;
});

/** 预览用的资产 rel：立方体天空材质预览其绑定的 TextureCube */
const previewRel = computed(() =>
  kind.value === "mat" && isSkyMat.value && skyDoc.value
    ? skyDoc.value.cubeMap
    : props.rel,
);

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

// ---------------------------------------------------------------------------
// 材质（普通）：引擎缓存装载 → 全参数编辑 → 防抖写盘（cachePut 即时刷新视口）；
// 着色器下拉改写 .mat 的 shader 引用（参数分组随引用的着色器种类切换）
// ---------------------------------------------------------------------------
const matReady = ref(false);
const local = reactive<Record<string, unknown>>({});
/** 渲染分支 key（引用的着色器种类；由后端按 .mat 的 shader 引用解析） */
const matType = ref<string>(DEFAULT_MATERIAL_TYPE);
/** 引用的着色器资产相对路径（空串 = 旧格式，按 materialType 渲染） */
const matShader = ref<string>("");
const groups = computed<MaterialParamGroup[]>(
  () => materialTypeRegistry.getOrDefault(matType.value).paramGroups,
);

/** 引用的着色器是否不在可选项中（空串 = 旧格式未挂载；有值但缺失 = 文件被删） */
const matShaderMissing = computed(
  () =>
    !!matShader.value &&
    !shaderOptions.value.internal.some((o) => o.rel === matShader.value) &&
    !shaderOptions.value.project.some((o) => o.rel === matShader.value),
);

/** 着色器资产选项（内置 internal/shaders/… + 项目 assets/… 的全部 .shader） */
const shaderOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (a.kind !== "shader") continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: shaderFileStem(a.path) });
    else project.push({ rel: a.path, name: shaderFileStem(a.path) });
  }
  return { internal, project };
});

// —— 着色器资产（.shader）：种类决定渲染程序与材质参数分组 ——
const shaderDoc = ref<ShaderDoc | null>(null);
/** 预制体概览（节点数；读取失败为 null） */
const prefabInfo = ref<{ nodes: number } | null>(null);
const shaderReady = ref(false);

// —— 天空材质（shader 引用内置天空着色器资产）——
const isSkyMat = ref(false);
const skyDoc = ref<SkyMatDoc | null>(null);
/** 挂载的天空着色器引用（创建时固定；旧格式为魔法串 SkyBox/SkyProcedural） */
const skyShaderRef = computed(() => {
  const s = skyDoc.value?.raw.shader;
  return typeof s === "string" ? s : "";
});

// —— TextureCube：来源与贴图引用编辑（项目资产可写；保存后刷新天空/预览）——
const texcubeDoc = ref<TexCubeAssetDoc | null>(null);
/** 内容版本：写盘后自增，驱动 3D 预览重载 */
const texcubeRev = ref(0);
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

function editTexcube(mutate: (doc: TexCubeAssetDoc) => void): void {
  const doc = texcubeDoc.value;
  const rootPath = root.value;
  if (!doc || isInternal.value || !rootPath) return;
  mutate(doc);
  texcubeDoc.value = { ...doc, faces: { ...doc.faces } };
  void (async () => {
    try {
      await saveTexCubeDoc(rootPath, props.rel, doc);
      texcubeRev.value++;
      // 若该 TextureCube 被天空盒节点绑定，立即重载天空背景
      editorStore.engine.invalidateTexCube(props.rel);
    } catch (e) {
      logStore.log("error", `保存 TextureCube ${props.rel} 失败: ${e}`);
    }
  })();
}

function onTexcubeSourceChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value === "faces" ? "faces" : "equirect";
  editTexcube((doc) => {
    doc.source = v;
  });
}

function onTexcubeMapChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  editTexcube((doc) => {
    doc.map = v;
  });
}

function onTexcubeFaceChange(key: TexCubeFaceKey, e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  editTexcube((doc) => {
    if (v) doc.faces[key] = v;
    else delete doc.faces[key];
  });
}

// —— 模型信息（metaFor 就绪后填充）——
const modelInfo = ref<{ clips: number; materials: number; hasSkeleton: boolean } | null>(null);

// —— 图片尺寸（onload 后填充）——
const imgSize = ref<{ w: number; h: number } | null>(null);

/** 待落盘任务（闭包捕获写入目标；切换资产前先冲刷，避免写串路径） */
let pendingMatSave: (() => void) | null = null;
let matSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSkySave: (() => void) | null = null;
let skySaveTimer: ReturnType<typeof setTimeout> | null = null;
let loadToken = 0;

function runPendingSave(): void {
  if (matSaveTimer) clearTimeout(matSaveTimer);
  if (skySaveTimer) clearTimeout(skySaveTimer);
  matSaveTimer = null;
  skySaveTimer = null;
  const a = pendingMatSave;
  const b = pendingSkySave;
  pendingMatSave = null;
  pendingSkySave = null;
  a?.();
  b?.();
}

async function reload(): Promise<void> {
  runPendingSave();
  const token = ++loadToken;
  const rel = props.rel;
  matReady.value = false;
  isSkyMat.value = false;
  skyDoc.value = null;
  texcubeDoc.value = null;
  modelInfo.value = null;
  imgSize.value = null;
  shaderDoc.value = null;
  shaderReady.value = false;
  prefabInfo.value = null;

  if (kind.value === "mat") {
    matReady.value = false;
    isSkyMat.value = false;
    skyDoc.value = null;
    const doc = await loadSkyMatDoc(root.value, rel);
    if (token !== loadToken) return;
    if (doc) {
      isSkyMat.value = true;
      skyDoc.value = doc;
      return;
    }
    // 普通材质：预取进引擎缓存（paramsFor/typeFor/shaderFor 读取；编辑写缓存即时刷新网格）
    await editorStore.engine.materials.preload([rel]);
    if (token !== loadToken) return;
    Object.assign(local, editorStore.engine.materials.paramsFor(rel));
    matType.value = editorStore.engine.materials.typeFor(rel);
    matShader.value = editorStore.engine.materials.shaderFor(rel);
    matReady.value = true;
    return;
  }
  matReady.value = false;
  isSkyMat.value = false;
  skyDoc.value = null;
  if (kind.value === "shader") {
    const doc = await loadShaderDoc(root.value, rel);
    if (token !== loadToken) return;
    shaderDoc.value = doc;
    shaderReady.value = true;
    return;
  }
  shaderDoc.value = null;
  shaderReady.value = false;
  if (kind.value === "prefab") {
    try {
      if (!root.value) return;
      const text = await api.readText(root.value, rel);
      const doc = JSON.parse(text) as { children?: unknown[] };
      const count = (n: { children?: unknown[] }): number =>
        1 + (Array.isArray(n.children) ? n.children.reduce((s2: number, c) => s2 + count(c as { children?: unknown[] }), 0) : 0);
      prefabInfo.value = { nodes: count(doc) };
    } catch {
      prefabInfo.value = null;
    }
    return;
  }
  if (kind.value === "texcube") {
    const doc = await loadTexCubeDoc(root.value, rel);
    if (token !== loadToken) return;
    texcubeDoc.value = doc;
    return;
  }
  if (MODEL_KINDS.has(kind.value)) {
    const engine = editorStore.engine;
    if (!engine.models.has(rel)) await engine.models.preload([rel]);
    const meta = engine.models.metaFor(rel);
    if (token !== loadToken) return;
    modelInfo.value = meta
      ? { clips: meta.clips.length, materials: meta.materials.length, hasSkeleton: meta.hasSkeleton }
      : null;
  }
}

watch(() => props.rel, () => void reload(), { immediate: true });

// —— 普通材质编辑：写引擎缓存（视口即时刷新）+ 防抖落盘 ——
const matParams = computed(() => local as unknown as MaterialParams);

function onEditParam(key: MaterialParamKey | MaterialEnableKey, value: number | boolean | string): void {
  local[key as string] = value;
  persistMaterial();
}

/** 改挂材质引用的着色器：解析新着色器的渲染分支 → 切参数分组 → 写盘 */
async function onMatShaderChange(e: Event): Promise<void> {
  const v = (e.target as HTMLSelectElement).value || DEFAULT_SHADER_REL;
  matShader.value = v;
  matType.value = await loadShaderKind(root.value, v);
  persistMaterial();
}

function persistMaterial(): void {
  const rootPath = root.value;
  const rel = props.rel;
  if (isInternal.value || !rootPath) return;
  // 即时写引擎缓存（cachePut 触发变更回调，引用该材质的网格同步刷新）
  editorStore.engine.materials.cachePut(rel, local as never, matType.value, matShader.value);
  if (matSaveTimer) clearTimeout(matSaveTimer);
  pendingMatSave = (): void => {
    void saveMaterialParams(
      rootPath,
      rel,
      materialFileStem(rel),
      local as never,
      matShader.value,
    ).catch((e) => logStore.log("error", `保存材质 ${rel} 失败: ${e}`));
  };
  matSaveTimer = setTimeout(() => {
    matSaveTimer = null;
    const task = pendingMatSave;
    pendingMatSave = null;
    task?.();
  }, 300);
}

// —— 着色器资产：类型在创建时固定（不可切换），卡片只展示类型与源码 ——

// —— 天空材质编辑：整卡 JSON 写回（防抖）；写盘后通知引擎重载天空 ——
function updateSky(mutate: (doc: SkyMatDoc) => void): void {
  const doc = skyDoc.value;
  const rootPath = root.value;
  if (!doc || isInternal.value || !rootPath) return;
  mutate(doc);
  if (skySaveTimer) clearTimeout(skySaveTimer);
  pendingSkySave = (): void => {
    void saveSkyMatDoc(rootPath, props.rel, doc)
      .then(() => editorStore.engine.invalidateSkyMaterial(props.rel))
      .catch((e) => logStore.log("error", `保存天空材质 ${props.rel} 失败: ${e}`));
  };
  skySaveTimer = setTimeout(() => {
    skySaveTimer = null;
    const task = pendingSkySave;
    pendingSkySave = null;
    task?.();
  }, 300);
}

function onSkyCubeMapChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  updateSky((d) => {
    d.cubeMap = v;
  });
}

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

function onSkyParam(key: SkyParamKey, v: number): void {
  updateSky((d) => {
    d[key] = v;
  });
}

function onSkyCheckbox(key: "sunDisc" | "ms", e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  updateSky((d) => {
    d[key] = v;
  });
}

// —— 内置资产：复制到项目（按扩展名路由目录；成功后选中新资产）——
const copying = ref(false);
async function onCopyToProject(): Promise<void> {
  const r = root.value;
  if (!r || copying.value || entry.value?.kind === "dir") return;
  copying.value = true;
  try {
    const dup = await assetService.copyInternalToProject(r, name.value, props.rel, assetsStore.assets);
    if (dup) {
      await assetsStore.load(r);
      assetsStore.select(dup);
      logStore.log("success", `已复制到项目: ${dup}`);
    }
  } finally {
    copying.value = false;
  }
}

function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  imgSize.value = { w: img.naturalWidth, h: img.naturalHeight };
}
</script>

<template>
  <div class="asset-inspector" :data-rel="rel">
    <!-- 基本信息 -->
    <div class="field">
      <label>名称</label>
      <span class="type-tag">{{ name }}</span>
    </div>
    <div class="field">
      <label>路径</label>
      <span class="muted mono asset-rel">{{ rel }}</span>
    </div>
    <div class="field">
      <label>类型</label>
      <span class="type-tag">{{ kind }}</span>
      <span v-if="entry" class="muted">{{ fmtSize(entry.size) }}</span>
      <span class="asset-badge" :class="{ internal: isInternal }">
        {{ isInternal ? "内置 · 只读" : "项目资产" }}
      </span>
      <button
        v-if="isInternal"
        class="asset-btn"
        :disabled="copying"
        title="复制为项目资产（可编辑）"
        @click="onCopyToProject"
      >
        复制到项目
      </button>
    </div>

    <!-- 纹理：原图预览 -->
    <template v-if="IMAGE_KINDS.has(kind)">
      <div class="asset-img-wrap">
        <img :src="assetUrl(rel)" :alt="name" @load="onImgLoad" />
      </div>
      <div v-if="imgSize" class="field">
        <label>尺寸</label>
        <span class="muted">{{ imgSize.w }} × {{ imgSize.h }}</span>
      </div>
    </template>

    <!-- 音频：原生播放器预览（mp3/wav/ogg/m4a/aac/flac） -->
    <template v-if="isAudioAssetRel(rel)">
      <div class="asset-audio-wrap">
        <audio controls preload="metadata" :src="assetUrl(rel)" />
      </div>
      <div class="hint">音频资产：添加「Audio Source」音源节点后在此绑定播放；2D 全局 / 3D 位置衰减。</div>
    </template>

    <!-- hdr / TextureCube / 材质 / 模型：3D 预览 -->
    <AssetPreview3D
      v-if="previewKind"
      :key="previewRel + ':' + previewKind + ':' + texcubeRev"
      :kind="previewKind"
      :rel="previewRel"
      :params="previewKind === 'material' && matReady ? matParams : null"
      :mat-type="previewKind === 'material' ? matType : undefined"
      :nishita="previewKind === 'sky' && skyDoc ? skyDoc : null"
      :bg-rotation="previewKind === 'texcube' && isSkyMat && skyDoc ? skyDoc.rotation : undefined"
      :bg-intensity="(previewKind === 'texcube' || previewKind === 'sky') && isSkyMat && skyDoc ? skyDoc.strength : undefined"
      :bg-blurriness="previewKind === 'texcube' && isSkyMat && skyDoc ? skyDoc.blur : undefined"
    />

    <!-- hdr 信息 -->
    <template v-if="kind === 'hdr'">
      <div class="hint">RGBE 高动态范围等距柱状全景；用作天空盒 TextureCube 的全景图源。</div>
    </template>

    <!-- TextureCube：来源 + 贴图引用（项目资产可编辑；内置只读，可复制到项目） -->
    <template v-if="kind === 'texcube'">
      <div class="field">
        <label>来源</label>
        <select
          :value="texcubeDoc?.source ?? 'equirect'"
          :disabled="isInternal"
          :title="isInternal ? '内置 TextureCube 只读；请先复制到项目' : '切换贴图来源模式'"
          @change="onTexcubeSourceChange"
        >
          <option value="equirect">等距柱状全景图</option>
          <option value="faces">六面贴图（±X ±Y ±Z）</option>
        </select>
      </div>
      <template v-if="texcubeDoc && texcubeDoc.source === 'faces'">
        <div
          v-for="k in TEXCUBE_FACE_KEYS"
          :key="k"
          class="field"
        >
          <label>{{ TEXCUBE_FACE_LABELS[k] }}</label>
          <select
            :value="texcubeDoc.faces[k] ?? ''"
            :disabled="isInternal"
            @change="onTexcubeFaceChange(k, $event)"
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
          :value="texcubeDoc?.map ?? ''"
          :disabled="isInternal"
          @change="onTexcubeMapChange"
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
        {{ isInternal ? "内置 TextureCube 只读；复制到项目后可更换贴图。" : "写入 .texcube 资产；被天空盒节点绑定时背景即时刷新。" }}
      </div>
    </template>

    <!-- 材质：类型 + 全部参数（天空类型创建时固定，不可切换） -->
    <template v-if="kind === 'mat'">
      <template v-if="isSkyMat && skyDoc">
        <div class="field">
          <label>天空类型</label>
          <span class="type-tag">
            {{ skyDoc.kind === "cube" ? "立方体天空盒（创建时固定）" : "程序化天空（创建时固定）" }}
          </span>
        </div>
        <div class="field">
          <label>挂载着色器</label>
          <span class="muted mono asset-rel">{{ skyShaderRef }}</span>
        </div>

        <!-- 立方体：TextureCube 纹理 + 旋转/强度/世界不透明度/模糊 -->
        <template v-if="skyDoc.kind === 'cube'">
          <div class="field">
            <label>TextureCube</label>
            <select
              :value="skyDoc.cubeMap"
              :disabled="isInternal"
              title="立方体天空的贴图来源（.texcube 资产）"
              @change="onSkyCubeMapChange"
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
              :model-value="skyDoc.rotation"
              :step="1"
              :min="0"
              :max="360"
              :disabled="isInternal"
              title="绕世界 Y 轴旋转（度）"
              @commit="(v) => onSkyParam('rotation', v)"
            />
          </div>
          <div class="field">
            <label>强度</label>
            <NumberField
              :model-value="skyDoc.strength"
              :step="0.01"
              :min="0"
              :max="16"
              :disabled="isInternal"
              title="背景亮度倍率"
              @commit="(v) => onSkyParam('strength', v)"
            />
          </div>
          <div class="field">
            <label>世界不透明度</label>
            <NumberField
              :model-value="skyDoc.worldOpacity"
              :step="0.01"
              :min="0"
              :max="1"
              :disabled="isInternal"
              title="世界不透明度（保留参数）"
              @commit="(v) => onSkyParam('worldOpacity', v)"
            />
          </div>
          <div class="field">
            <label>模糊</label>
            <NumberField
              :model-value="skyDoc.blur"
              :step="0.01"
              :min="0"
              :max="1"
              :disabled="isInternal"
              title="背景模糊（0~1）"
              @commit="(v) => onSkyParam('blur', v)"
            />
          </div>
          <div class="hint">
            {{ isInternal ? "内置天空材质只读；复制到项目后可编辑。" : "写入 .mat 资产；被天空盒节点绑定时背景与参数即时生效。" }}
          </div>
        </template>

        <!-- 程序化：Blender 天空纹理参数（Nishita 大气散射） -->
        <template v-else>
          <label class="sky-checkbox">
            <input
              type="checkbox"
              :checked="skyDoc.ms"
              :disabled="isInternal"
              @change="onSkyCheckbox('ms', $event)"
            />
            <span>多重散射</span>
          </label>
          <label class="sky-checkbox">
            <input
              type="checkbox"
              :checked="skyDoc.sunDisc"
              :disabled="isInternal"
              @change="onSkyCheckbox('sunDisc', $event)"
            />
            <span>日轮</span>
          </label>
          <div class="field">
            <label>太阳尺寸</label>
            <NumberField
              :model-value="skyDoc.sunSize"
              :step="0.1"
              :min="0.1"
              :max="30"
              :disabled="isInternal"
              title="太阳圆盘全角尺寸（度）"
              @commit="(v) => onSkyParam('sunSize', v)"
            />
          </div>
          <div class="field">
            <label>太阳强度</label>
            <NumberField
              :model-value="skyDoc.sunStrength"
              :step="0.1"
              :min="0"
              :max="20"
              :disabled="isInternal"
              title="太阳圆盘亮度倍率"
              @commit="(v) => onSkyParam('sunStrength', v)"
            />
          </div>
          <div class="field">
            <label>太阳高度</label>
            <NumberField
              :model-value="skyDoc.sunElevation"
              :step="0.5"
              :min="-90"
              :max="90"
              :disabled="isInternal"
              title="太阳高度角（度，0=地平线）"
              @commit="(v) => onSkyParam('sunElevation', v)"
            />
          </div>
          <div class="field">
            <label>太阳旋转</label>
            <NumberField
              :model-value="skyDoc.sunRotation"
              :step="1"
              :min="0"
              :max="360"
              :disabled="isInternal"
              title="太阳方位角（度）"
              @commit="(v) => onSkyParam('sunRotation', v)"
            />
          </div>
          <div class="field">
            <label>海拔</label>
            <NumberField
              :model-value="skyDoc.altitude"
              :step="10"
              :min="0"
              :max="20000"
              :disabled="isInternal"
              title="观察点海拔（米）"
              @commit="(v) => onSkyParam('altitude', v)"
            />
          </div>
          <div class="field">
            <label>空气</label>
            <NumberField
              :model-value="skyDoc.air"
              :step="0.01"
              :min="0"
              :max="10"
              :disabled="isInternal"
              title="空气密度（瑞利散射倍率）"
              @commit="(v) => onSkyParam('air', v)"
            />
          </div>
          <div class="field">
            <label>气溶胶</label>
            <NumberField
              :model-value="skyDoc.dust"
              :step="0.01"
              :min="0"
              :max="10"
              :disabled="isInternal"
              title="气溶胶密度（米氏散射倍率）"
              @commit="(v) => onSkyParam('dust', v)"
            />
          </div>
          <div class="field">
            <label>臭氧</label>
            <NumberField
              :model-value="skyDoc.ozone"
              :step="0.01"
              :min="0"
              :max="10"
              :disabled="isInternal"
              title="臭氧密度（吸收倍率）"
              @commit="(v) => onSkyParam('ozone', v)"
            />
          </div>
          <div class="hint">
            {{ isInternal ? "内置天空材质只读；复制到项目后可编辑。" : "Nishita 大气散射（Blender 天空纹理风格）；写入 .mat 资产，被天空盒节点绑定时背景即时刷新。" }}
          </div>
        </template>
      </template>
      <template v-else-if="matReady">
        <div class="field">
          <label>着色器</label>
          <select :value="matShader" :disabled="isInternal" @change="onMatShaderChange">
            <option v-if="!matShader" value="" disabled>（未挂载，默认 PBR）</option>
            <option v-if="matShaderMissing" :value="matShader" disabled>
              {{ matShader }}（缺失）
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
        <MaterialParamsEditor
          :local="local"
          :groups="groups"
          :disabled="isInternal"
          @editParam="onEditParam"
        />
      </template>
      <div v-else class="hint">材质读取中…</div>
    </template>

    <!-- 着色器资产：渲染程序（类型创建时固定）+ 源码内容（Unity ShaderLab 风格源文件） -->
    <template v-if="kind === 'shader'">
      <template v-if="shaderReady && shaderDoc">
        <div class="field">
          <label>着色器类型</label>
          <span class="type-tag">{{ shaderKindLabel(shaderDoc.kind) }}（创建时固定）</span>
        </div>
        <pre class="shader-source mono">{{ shaderDoc.source }}</pre>
        <div class="hint">
          {{ isInternal
            ? "内置着色器只读；可「复制到项目」生成项目内副本，或由材质挂载引用。"
            : "类型在创建时固定，不可切换；材质在「着色器」下拉中挂载此程序，按该渲染分支渲染。" }}
        </div>
      </template>
      <div v-else class="hint">着色器读取中…</div>
    </template>

    <!-- 模型信息 -->
    <template v-if="MODEL_KINDS.has(kind)">
      <template v-if="modelInfo">
        <div class="field">
          <label>动画剪辑</label>
          <span class="muted">{{ modelInfo.clips }} 个</span>
        </div>
        <div class="field">
          <label>内嵌材质</label>
          <span class="muted">{{ modelInfo.materials }} 个</span>
        </div>
        <div class="field">
          <label>骨骼</label>
          <span class="muted">{{ modelInfo.hasSkeleton ? "有" : "无" }}</span>
        </div>
      </template>
      <div v-else class="hint">模型信息读取中…</div>
    </template>

    <!-- 场景 / 脚本 / 其它 -->
    <template v-if="kind === 'scene'">
      <div class="hint">双击资产打开场景（层级/视口随之切换）。</div>
    </template>
    <template v-else-if="kind === 'ts'">
      <div class="hint">双击资产或右键「打开脚本」进入脚本工作台编辑。</div>
    </template>
    <!-- 预制体：概览 + 实例化到场景（嵌套子树一次入图，一次撤销） -->
    <template v-else-if="kind === 'prefab'">
      <div class="field">
        <label>节点数</label>
        <span>{{ prefabInfo ? prefabInfo.nodes : "读取中…" }}</span>
      </div>
      <button
        class="prefab-instantiate"
        :disabled="!prefabInfo || !root"
        title="实例化到当前场景（挂到选中节点/根下）"
        @click="instantiatePrefabAsset(props.rel)"
      >实例化到场景</button>
      <div class="hint">右键资产也可「实例化到场景」；层级面板选中实例可「更新预制体」回写资产。</div>
    </template>
  </div>
</template>

<style scoped>
.asset-inspector {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.shader-source {
  margin: 2px 0 4px;
  padding: 8px 10px;
  max-height: 280px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text, #ddd);
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  user-select: text;
  cursor: text;
}
.prefab-instantiate {
  width: 100%;
  height: 26px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text, #ddd);
  background: transparent;
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  cursor: pointer;
}
.prefab-instantiate:hover:not(:disabled) {
  color: var(--accent, #4a9eff);
  border-color: var(--accent, #4a9eff);
}
.prefab-instantiate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
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
.asset-badge {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.asset-badge.internal {
  border-color: var(--text-dim, #888);
  color: var(--text-dim, #888);
}
.asset-btn {
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
.asset-btn:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.asset-img-wrap {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  overflow: hidden;
  background:
    repeating-conic-gradient(#242428 0% 25%, #2e2e33 0% 50%) 0 0 / 16px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  margin-bottom: 2px;
}
.asset-img-wrap img {
  max-width: 100%;
  max-height: 220px;
  object-fit: contain;
  display: block;
}
.asset-audio-wrap {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  align-items: center;
  margin-bottom: 2px;
}
.asset-audio-wrap audio {
  width: 100%;
  height: 36px;
}
</style>
