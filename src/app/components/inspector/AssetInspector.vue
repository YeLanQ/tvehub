<script setup lang="ts">
/**
 * 资产检查器：资产面板选中资产后的预览 + 暴露属性（属性面板资产模式）。
 * - 纹理（png/jpg/webp/bmp/gif/svg）：原图预览 + 尺寸/大小；
 * - hdr / TextureCube：全景背景预览 + 引用信息；
 * - 材质（.mat）：材质球实时预览 + 所挂着色器暴露的分支参数与 Properties 参数
 *   （项目资产可编辑，300ms 防抖写盘；写入引擎缓存使引用网格即时刷新）；
 *   天空材质（引用内置天空着色器）暴露类型与三段配色，整卡 JSON 写回；
 * - 着色器（.shader）：渲染分支（Base 声明）+ 钩子清单 + 暴露属性 + 源码
 *   （Monaco 可编辑，保存后重新解析并刷新引用网格）；
 * - 模型（glb/gltf/fbx/obj）：模型实例预览 + 动画/内嵌材质/骨骼信息；
 * - 场景/脚本/其它：基础信息与操作提示。
 * 内置资产只读，提供「复制到项目」。
 * 展示层按资产类型拆到 ./asset/ 子组件（纯展示 + 上抛编辑动作），本组件持有全部
 * 状态、资产文档加载与写盘（防抖落盘 / 引擎缓存刷新），并负责按 kind 组合子组件。
 */
import { computed, reactive, ref, watch } from "vue";
import {
  DEFAULT_MATERIAL_TYPE,
  DEFAULT_SHADER_REL,
  materialFileStem,
  materialTypeRegistry,
  insertBaseDeclaration,
  shaderFileStem,
  shaderParamGroups,
  skyKindOfShaderRef,
  shaderPropDefaults,
  type MaterialParamGroup,
  type ShaderDoc,
} from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import { getAssetsStore, type AssetsStore } from "../../stores/assets";
import { getProjectStore } from "../../stores/project";
import { getEditorStore } from "../../stores/editor";
import { logStore } from "../../stores/log";
import { assetService } from "../../services/assetService";
import { saveMaterialParams } from "../../lib/materials";
import { loadShaderDoc, loadShaderKind, saveShaderSource } from "../../lib/shaders";
import { api } from "../../../lib/api";
import { instantiatePrefabAsset } from "../../lib/prefabs";
import {
  loadTexCubeDoc,
  saveTexCubeDoc,
  type TexCubeAssetDoc,
} from "../../lib/texcube";
import { loadSkyMatDoc, saveSkyMatDoc, type SkyMatDoc } from "../../lib/sky-mat";
import { isAudioAssetRel } from "../../../framework/audio";
import { parseTerrainSettings } from "../../../framework/terrain";
import { dispatchCommand } from "../../commands";
import type { MaterialParams } from "../../../framework/material";
import AssetPreview3D from "./AssetPreview3D.vue";
import ShaderEditorDialog from "./ShaderEditorDialog.vue";
import AssetBasicInfo from "./asset/AssetBasicInfo.vue";
import ImagePreview from "./asset/ImagePreview.vue";
import AudioPreview from "./asset/AudioPreview.vue";
import TexCubeFields from "./asset/TexCubeFields.vue";
import MaterialAssetFields from "./asset/MaterialAssetFields.vue";
import SkyMatFields from "./asset/SkyMatFields.vue";
import ShaderAssetFields from "./asset/ShaderAssetFields.vue";
import ModelAssetInfo from "./asset/ModelAssetInfo.vue";
import PrefabAssetInfo from "./asset/PrefabAssetInfo.vue";
import AnimClipInfo from "./asset/AnimClipInfo.vue";
import TerrainAssetFields from "./asset/TerrainAssetFields.vue";
import PlainAssetHints from "./asset/PlainAssetHints.vue";

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
// 材质（普通）：引擎缓存装载 → 分支参数 + 着色器 Properties 参数编辑 → 防抖写盘
// （cachePut 即时刷新视口）；着色器下拉改写 .mat 的 shader 引用（渲染分支与参数
// 分组随所挂着色器的 Base 与 Properties 切换）。
// ---------------------------------------------------------------------------
const matReady = ref(false);
const local = reactive<Record<string, unknown>>({});
/** 着色器参数镜像（.mat 的 props；键 = 所挂 .shader 的 Properties 属性名） */
const shaderLocal = reactive<Record<string, unknown>>({});
/** 渲染分支 key（所挂着色器的 Base 解析结果） */
const matType = ref<string>(DEFAULT_MATERIAL_TYPE);
/** 引用的着色器资产相对路径（空串 = 旧格式，按 materialType 渲染） */
const matShader = ref<string>("");

/** 所挂着色器的文档（引擎着色器缓存；未解析为 null） */
const matShaderDoc = computed(() =>
  matShader.value ? editorStore.engine.shaders.docFor(matShader.value) : null,
);
/** 着色器暴露的属性表（面板参数分组用；未解析为空表） */
const matShaderProps = computed(() => matShaderDoc.value?.properties ?? []);
/** 着色器解析错误（null = 无错误） */
const matShaderError = computed(() => matShaderDoc.value?.error ?? null);
/** 着色器参数分组（由 Properties 动态构造） */
const matShaderGroups = computed<MaterialParamGroup[]>(() =>
  shaderParamGroups(matShaderProps.value),
);

/** 参数分组：分支参数分组 + 着色器 Properties 分组 */
const groups = computed<MaterialParamGroup[]>(() => [
  ...materialTypeRegistry.getOrDefault(matType.value).paramGroups,
  ...matShaderGroups.value,
]);

/** 就地替换对象内容（切换材质/着色器时属性集合变化，避免残留旧字段） */
function replaceAll(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

/** 着色器参数镜像 ← 属性默认值 + .mat 已存 props */
function syncShaderProps(): void {
  const stored = (local.props ?? {}) as Record<string, unknown>;
  replaceAll(shaderLocal, { ...shaderPropDefaults(matShaderProps.value), ...stored });
}

// —— 着色器源码编辑器（.shader；弹层 Monaco GLSL）——
const shaderEditorOpen = ref(false);

/**
 * 旧版着色器迁移（一键）：在 Shader 块的开括号后补一行 Base "…" 并保存。
 * 只做最小的文本插入（不动其余内容），随后走与源码编辑器相同的保存/刷新链路。
 */
async function onShaderFixBase(): Promise<void> {
  const rootPath = root.value;
  const doc = shaderDoc.value;
  if (!rootPath || !doc || isInternal.value || !doc.suggestedBase) return;
  const fixed = insertBaseDeclaration(doc.source, doc.suggestedBase);
  if (fixed === null) {
    logStore.log("error", `补 Base 失败（未找到 Shader 块）: ${props.rel}`);
    return;
  }
  try {
    const saved = await saveShaderSource(rootPath, props.rel, fixed);
    onShaderSaved(saved);
    logStore.log("success", `已为旧版着色器补上 Base "${doc.suggestedBase}": ${props.rel}`);
  } catch (e) {
    logStore.log("error", `保存着色器 ${props.rel} 失败: ${e}`);
  }
}

/** 源码保存完成：写引擎缓存（视口刷新 + 面板取新属性）并刷新本卡片文档 */
function onShaderSaved(doc: ShaderDoc): void {
  shaderDoc.value = doc;
  editorStore.engine.shaders.cachePut(props.rel, doc);
  // 属性集合可能变化：重建着色器参数镜像（.mat 已存值保留）
  syncShaderProps();
}

/** 引用的着色器是否不在可选项中（空串 = 旧格式未挂载；有值但缺失 = 文件被删） */
const matShaderMissing = computed(
  () =>
    !!matShader.value &&
    !shaderOptions.value.internal.some((o) => o.rel === matShader.value) &&
    !shaderOptions.value.project.some((o) => o.rel === matShader.value),
);

/** 着色器资产选项（内置 internal/shaders/… + 项目 assets/… 的全部 .shader；
 *  天空程序由天空材质引用，不作为网格材质的渲染分支，排除） */
const shaderOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (a.kind !== "shader" || skyKindOfShaderRef(a.path)) continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: shaderFileStem(a.path) });
    else project.push({ rel: a.path, name: shaderFileStem(a.path) });
  }
  return { internal, project };
});

// —— 着色器资产（.shader）：Base 决定渲染分支、Hook 是效果片段、源码可编辑 ——
const shaderDoc = ref<ShaderDoc | null>(null);
/** 预制体概览（节点数；读取失败为 null） */
/** 动画剪辑概览（时长/循环/通道数；读取失败为 null） */
const animInfo = ref<{ duration: number; loops: boolean; curves: number } | null>(null);
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

// —— 模型信息（metaFor 就绪后填充）——
const modelInfo = ref<{ clips: number; materials: number; hasSkeleton: boolean } | null>(null);

// —— 地形资产（.terrain：设置概览；读取失败为 null）——
const terrainSettings = ref<Record<string, number> | null>(null);

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
  animInfo.value = null;
  terrainSettings.value = null;

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
    // 所挂着色器一并预取（面板按 Base 切分支分组、按 Properties 渲染着色器参数）
    await editorStore.engine.materials.preload([rel]);
    const shaderRel = editorStore.engine.materials.shaderFor(rel);
    if (shaderRel) await editorStore.engine.shaders.preload([shaderRel]);
    if (token !== loadToken) return;
    replaceAll(local, editorStore.engine.materials.paramsFor(rel) as unknown as Record<string, unknown>);
    matType.value = editorStore.engine.materials.typeFor(rel);
    matShader.value = shaderRel;
    syncShaderProps();
    matReady.value = true;
    return;
  }
  matReady.value = false;
  isSkyMat.value = false;
  skyDoc.value = null;
  if (kind.value === "shader") {
    // 着色器：Base/钩子/属性表 + 源码（项目资产可编辑）
    const doc = await loadShaderDoc(root.value, rel);
    if (token !== loadToken) return;
    shaderDoc.value = doc;
    shaderReady.value = true;
    if (doc) editorStore.engine.shaders.cachePut(rel, doc);
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
  if (kind.value === "anim") {
    try {
      if (!root.value) return;
      const text = await api.readText(root.value, rel);
      const d = JSON.parse(text) as { duration?: number; loops?: boolean; curves?: unknown[] };
      animInfo.value = {
        duration: typeof d.duration === "number" ? d.duration : 0,
        loops: d.loops !== false,
        curves: Array.isArray(d.curves) ? d.curves.length : 0,
      };
    } catch {
      animInfo.value = null;
    }
    return;
  }
  if (kind.value === "texcube") {
    const doc = await loadTexCubeDoc(root.value, rel);
    if (token !== loadToken) return;
    texcubeDoc.value = doc;
    return;
  }
  if (kind.value === "terrain") {
    try {
      if (!root.value) return;
      const text = await api.readText(root.value, rel);
      const doc = JSON.parse(text) as { settings?: unknown };
      terrainSettings.value = parseTerrainSettings(doc.settings) as unknown as Record<string, number>;
    } catch {
      terrainSettings.value = null;
    }
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

/**
 * 预览用参数：分支参数 + 着色器 Properties 镜像（与参数面板同源）。
 * 预览与面板必须读同一份镜像，否则换挂载的着色器（或改着色器参数）后
 * 材质球与面板会不同步。
 */
const previewParams = computed<MaterialParams>(() => ({
  ...matParams.value,
  props: { ...(matParams.value.props ?? {}), ...shaderLocal } as MaterialParams["props"],
}));

function onEditParam(key: string, value: number | boolean | string | number[]): void {
  // 着色器 Properties 参数 → 写 .mat 的 props（面板镜像同步就地更新）
  if (matShaderProps.value.some((p) => p.key === key)) {
    if (typeof value === "boolean") return;
    shaderLocal[key] = Array.isArray(value) ? [...value] : value;
    local.props = { ...shaderLocal };
    persistMaterial();
    return;
  }
  local[key] = value;
  persistMaterial();
}

/** 改挂材质引用的着色器：预取新文档 → 切渲染分支与参数分组 → 写盘 */
async function onMatShaderChange(value: string): Promise<void> {
  const v = value || DEFAULT_SHADER_REL;
  matShader.value = v;
  matType.value = await loadShaderKind(root.value, v);
  if (!editorStore.engine.shaders.has(v)) {
    await editorStore.engine.shaders.preload([v]);
  }
  syncShaderProps();
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

function onImgLoad(w: number, h: number): void {
  imgSize.value = { w, h };
}

/** 地形资产「添加到场景」：按资产设置创建地形节点（node.add terrain 路径） */
function onAddTerrainToScene(): void {
  if (isInternal.value) return;
  void dispatchCommand("node.add", { kind: "terrain", path: props.rel });
}
</script>

<template>
  <div class="asset-inspector" :data-rel="rel">
    <!-- 基本信息 -->
    <AssetBasicInfo
      :rel="rel"
      :name="name"
      :kind="kind"
      :size="entry?.size"
      :is-internal="isInternal"
      :copying="copying"
      @copyToProject="onCopyToProject"
    />

    <!-- 纹理：原图预览 -->
    <ImagePreview
      v-if="IMAGE_KINDS.has(kind)"
      :rel="rel"
      :name="name"
      :size="imgSize"
      @loaded="onImgLoad"
    />

    <!-- 音频：原生播放器预览（mp3/wav/ogg/m4a/aac/flac） -->
    <AudioPreview v-if="isAudioAssetRel(rel)" :rel="rel" />

    <!-- hdr / TextureCube / 材质 / 模型：3D 预览 -->
    <AssetPreview3D
      v-if="previewKind"
      :key="previewRel + ':' + previewKind + ':' + texcubeRev"
      :kind="previewKind"
      :rel="previewRel"
      :params="previewKind === 'material' && matReady ? previewParams : null"
      :mat-type="previewKind === 'material' ? matType : undefined"
      :shader-rel="previewKind === 'material' ? matShader : undefined"
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
    <TexCubeFields
      v-if="kind === 'texcube'"
      :doc="texcubeDoc"
      :disabled="isInternal"
      :image-options="imageOptions"
      @source="(v) => editTexcube((doc) => { doc.source = v; })"
      @map="(v) => editTexcube((doc) => { doc.map = v; })"
      @face="(key, v) => editTexcube((doc) => { if (v) doc.faces[key] = v; else delete doc.faces[key]; })"
    />

    <!-- 材质：类型 + 全部参数（天空类型创建时固定，不可切换） -->
    <template v-if="kind === 'mat'">
      <SkyMatFields
        v-if="isSkyMat && skyDoc"
        :doc="skyDoc"
        :shader-ref="skyShaderRef"
        :disabled="isInternal"
        :cube-options="cubeOptions"
        @cubeMap="(v) => updateSky((doc) => { doc.cubeMap = v; })"
        @param="(key, v) => updateSky((doc) => { doc[key] = v; })"
        @checkbox="(key, v) => updateSky((doc) => { doc[key] = v; })"
      />
      <MaterialAssetFields
        v-else-if="matReady"
        :local="matShaderProps.length > 0 ? { ...local, ...shaderLocal } : local"
        :groups="groups"
        :disabled="isInternal"
        :shader="matShader"
        :shader-options="shaderOptions"
        :shader-missing="matShaderMissing"
        :mat-type="matType"
        :shader-error="matShaderError"
        @shaderChange="onMatShaderChange"
        @editParam="onEditParam"
      />
      <div v-else class="hint">材质读取中…</div>
    </template>

    <!-- 着色器资产：Base/钩子/属性 + 源码（项目资产可编辑源码） -->
    <template v-if="kind === 'shader'">
      <ShaderAssetFields
        v-if="shaderReady && shaderDoc"
        :doc="shaderDoc"
        :is-internal="isInternal"
        @editSource="shaderEditorOpen = true"
        @fixBase="onShaderFixBase"
      />
      <div v-else class="hint">着色器读取中…</div>
    </template>

    <!-- 模型信息 -->
    <template v-if="MODEL_KINDS.has(kind)">
      <ModelAssetInfo v-if="modelInfo" :info="modelInfo" />
      <div v-else class="hint">模型信息读取中…</div>
    </template>

    <!-- 场景 / 脚本 / 其它 -->
    <PlainAssetHints v-if="kind === 'scene'" kind="scene" />
    <PlainAssetHints v-else-if="kind === 'ts'" kind="ts" />
    <!-- 预制体：概览 + 实例化到场景（嵌套子树一次入图，一次撤销） -->
    <PrefabAssetInfo
      v-else-if="kind === 'prefab'"
      :info="prefabInfo"
      :root="root"
      @instantiate="instantiatePrefabAsset(props.rel)"
    />
    <!-- 动画剪辑：概览 -->
    <AnimClipInfo v-else-if="kind === 'anim'" :info="animInfo" />

    <!-- 地形：设置概览 + 添加到场景 -->
    <TerrainAssetFields
      v-else-if="kind === 'terrain'"
      :settings="terrainSettings"
      :readonly="isInternal"
      @addToScene="onAddTerrainToScene"
    />

    <!-- 着色器源码编辑器（.shader；弹层 Monaco GLSL） -->
    <ShaderEditorDialog
      v-if="shaderEditorOpen && shaderDoc"
      :rel="props.rel"
      :source="shaderDoc.source"
      @close="shaderEditorOpen = false"
      @saved="onShaderSaved"
    />
  </div>
</template>

<style scoped>
.asset-inspector {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
