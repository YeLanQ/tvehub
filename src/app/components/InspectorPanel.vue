<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode, SkyboxNode, AudioNode, DirectionalLightNode, PointLightNode, SpotLightNode } from "../../framework/prototype/derived/Primitives";
import type { MaterialParams, MaterialParamKey, MaterialEnableKey } from "../../framework/material";
import { clampMaterialParam, isMaterialEnableKey, materialFileStem } from "../../framework/material";
import { clampCameraParam, cameraParamDef, parseCameraClearFlags, type CameraParamKey } from "../../framework/camera";
import {
  isAudioSourceComponent,
  isColliderComponent,
  isLightComponent,
  isRigidBodyComponent,
  isScriptComponent,
  type AudioSourceComponentRef,
  type ColliderComponentRef,
  type LightComponentRef,
  type NodeComponentRef,
} from "../../framework/prototype/Node";
import {
  canAddComponent,
  componentMetaOf,
  createComponentRef,
  createScriptComponentRef,
  resetComponentSettings,
  LIGHT_KIND_OPTIONS,
} from "../lib/component-registry";
import type { ColliderSettings, RigidBodySettings } from "../../framework/physics";
import { isInternalAsset } from "../../lib/internal-assets";
import {
  duplicateMaterialToProject,
  loadMaterialDoc,
  saveMaterialParams,
} from "../lib/materials";
import { loadShaderKind } from "../lib/shaders";
import type { JsonRecord, JsonValue } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/scene/SceneClient";
import type { AnimGraph } from "../../framework/animation";
import { isModelAssetRel } from "../../framework/mesh";
import { dispatchCommand } from "../commands";
import { prompt } from "../lib/prompt";
import { openContextMenu, menuSeparator, type CtxMenuItem } from "../../lib/editor/context-menu";
import ComponentCard from "./ComponentCard.vue";
import NodeSection from "./inspector/NodeSection.vue";
import TransformSection from "./inspector/TransformSection.vue";
import MeshSection from "./inspector/MeshSection.vue";
import MaterialSection from "./inspector/MaterialSection.vue";
import ModelMaterialSection from "./inspector/ModelMaterialSection.vue";
import AnimationSection from "./inspector/AnimationSection.vue";
import LightSection from "./inspector/LightSection.vue";
import CameraSection from "./inspector/CameraSection.vue";
import SkyboxSection from "./inspector/SkyboxSection.vue";
import AudioSection from "./inspector/AudioSection.vue";
import AssetInspector from "./inspector/AssetInspector.vue";
import ScriptFields from "./inspector/ScriptFields.vue";
import RigidBodyFields from "./inspector/RigidBodyFields.vue";
import ColliderFields from "./inspector/ColliderFields.vue";
import LightComponentFields from "./inspector/LightComponentFields.vue";
import PhysicsSimSection from "./inspector/PhysicsSimSection.vue";
import MultiSection from "./inspector/MultiSection.vue";
import "../../styles/components/inspector-panel.scss";

const store = getEditorStore();
const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
const scriptsStore = getScriptsStore();
const { state, engine } = store;

const node = computed<Node | undefined>(() => store.nodeById(state.selectedId ?? undefined));
const revision = computed(() => store.revision());

// ---------------------------------------------------------------------------
// 资产检查器模式（最后点击优先）：点击资产面板条目 → 显示资产预览与属性；
// 点击节点（层级/视口）→ 回到节点检查器。selectedAsset 清空时保持现状，
// 直到下一次节点选中。
// ---------------------------------------------------------------------------
const assetMode = ref(false);
const assetRel = computed(() => assetsStore.selectedAsset);
// 监听选择序号而非值：同一资产重复点击（先点了场景节点再点回它）也要切回资产模式
watch(
  () => assetsStore.selectedAssetSeq,
  () => {
    if (assetsStore.selectedAsset) assetMode.value = true;
  },
);
watch(
  () => state.selectedId,
  (id) => {
    if (id) assetMode.value = false;
  },
);

/**
 * 模型网格的解析信息（剪辑/骨骼/内嵌材质）。
 * 以 revision 为失效信号：切换来源、模型异步加载完成（model:changed）、
 * 属性补丁都会 bump，属性卡片据此按模型内容显隐。
 */
const modelMeta = computed(() => {
  void revision.value;
  const n = node.value;
  return n instanceof MeshNode && n.source === "model" && n.model
    ? engine.models.metaFor(n.model)
    : null;
});
/** 模型是否携带动画剪辑（决定 Animation 卡片与动画组件行） */
const modelHasClips = computed(() => (modelMeta.value?.clips.length ?? 0) > 0);
/** 模型是否携带内嵌材质（决定 Material 卡片显示内嵌清单） */
const modelHasMaterials = computed(() => (modelMeta.value?.materials.length ?? 0) > 0);

/** 进入编辑器/切换项目后同步一次资产列表（材质下拉需要 assets/materials 内容） */
onMounted(() => {
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
});

// ---------------------------------------------------------------------------
// 材质参数落盘：编辑时先即时写入引擎缓存（面板/视口立即同步），文件写盘做
// 300ms 防抖合并，避免拖拽/连续输入时每条都跨 IPC 写盘造成的延迟与乱序覆盖。
// ---------------------------------------------------------------------------
let materialDirtyTimer: ReturnType<typeof setTimeout> | null = null;
let materialDirty: {
  root: string;
  rel: string;
  name: string;
  /** 挂载的着色器资产引用（写入 .mat 的 shader 字段） */
  shader: string;
  params: MaterialParams;
} | null = null;

function persistMaterialNow(d: NonNullable<typeof materialDirty>): void {
  saveMaterialParams(d.root, d.rel, d.name, d.params, d.shader).catch((e) =>
    logStore.log("error", `保存材质 ${d.rel} 失败: ${e}`, "engine"),
  );
}

function flushMaterialPersist(): void {
  if (materialDirtyTimer) clearTimeout(materialDirtyTimer);
  materialDirtyTimer = null;
  const d = materialDirty;
  materialDirty = null;
  if (d) persistMaterialNow(d);
}

function scheduleMaterialPersist(
  rel: string,
  params: MaterialParams,
  kind?: string,
  shader?: string,
): void {
  const root = projectStore.currentPath;
  if (!root) return;
  // 连续编辑中切到另一份材质时，先把上一份落盘，避免被覆盖丢失
  if (materialDirty && materialDirty.rel !== rel) flushMaterialPersist();
  // 着色器引用缺省时取引擎缓存的当前值（参数编辑不改挂载；切换着色器显式传入）
  materialDirty = {
    root,
    rel,
    name: materialFileStem(rel),
    shader: shader ?? engine.materials.shaderFor(rel),
    params: { ...params },
  };
  if (kind) {
    // 渲染分支即时写缓存（引用该材质的网格按新分支重建 three 材质）
    engine.materials.cachePut(rel, params, kind, materialDirty.shader);
  }
  if (materialDirtyTimer) clearTimeout(materialDirtyTimer);
  materialDirtyTimer = setTimeout(() => {
    materialDirtyTimer = null;
    const d = materialDirty;
    materialDirty = null;
    if (d) persistMaterialNow(d);
  }, 300);
}

onBeforeUnmount(flushMaterialPersist);

function commit(mutate: (n: Node) => void, label: string): void {
  const n = node.value;
  if (!n) return;
  mutateNode(n, mutate, label);
}

/** 直接对指定节点执行 patch（节点可能非当前选中；捕获前后快照进历史） */
function mutateNode(n: Node, mutate: (nn: Node) => void, label: string): void {
  const before = n.toJSON() as JsonRecord;
  mutate(n);
  const after = n.toJSON() as JsonRecord;
  void dispatchCommand("node.patch", { id: n.id, before, after, label });
}

function setTransformAxis(axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number): void {
  const n = node.value;
  if (!n) return;
  const cur = engine.getTransform(n.id);
  if (!cur) return;
  const next: TransformSnapshot = {
    position: { ...cur.position },
    rotation: { ...cur.rotation },
    scale: { ...cur.scale },
  };
  next[axis][part] = value;
  void dispatchCommand("node.setTransform", { id: n.id, snapshot: next });
}

function onNodeRename(name: string): void {
  void dispatchCommand("node.rename", { name });
}

function onNodeToggleActive(value: boolean): void {
  commit((n) => { n.active = value; }, "Toggle Active");
}

function onNodeToggleVisible(value: boolean): void {
  commit((n) => { n.visible = value; }, "Toggle Visible");
}

function onTransformChange(axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number): void {
  setTransformAxis(axis, part, value);
}

function onMeshUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  switch (label) {
    case "Set Geometry":
      commit((m) => {
        (m as MeshNode).source = "primitive";
        (m as MeshNode).geometry = value as MeshNode["geometry"];
      }, label);
      break;
    case "Set Mesh Source": {
      const source = value === "model" ? "model" : "primitive";
      commit((m) => {
        const mesh = m as MeshNode;
        mesh.source = source;
        if (source === "model") mesh.material = ""; // 模型材质内嵌，不走资产引用
      }, label);
      break;
    }
    case "Set Model": {
      const rel = value as string;
      if (!isModelAssetRel(rel)) return;
      const apply = (): void => {
        commit((m) => {
          (m as MeshNode).source = "model";
          (m as MeshNode).model = rel;
          (m as MeshNode).material = "";
        }, label);
      };
      // 先预取模型再提交：节点入图即渲染实例（未就绪则先占位后自动刷新）
      if (!engine.models.has(rel)) {
        void engine.models.preload([rel]);
      }
      apply();
      engine.refreshModelNodes(rel);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// 动画卡片（Animation）事件：节点数据提交（可撤销）；运行时控制由卡片直连引擎
// ---------------------------------------------------------------------------

function onAnimUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  commit((m) => {
    const anim = (m as MeshNode).anim;
    switch (label) {
      case "Set Anim Autoplay":
        anim.autoplay = value === true;
        break;
      case "Set Anim Clip":
        anim.clip = typeof value === "string" ? value : "";
        break;
      case "Set Anim Speed":
        anim.speed = typeof value === "number" ? Math.max(0, value) : 1;
        break;
      case "Set Anim Loop":
        if (value === "loop" || value === "once" || value === "pingpong") anim.loop = value;
        break;
    }
  }, label);
}

/** 动画图数据变更（编辑器每次操作提交整图；null = 删除图回到单剪辑） */
function onAnimGraphUpdate(graph: AnimGraph | null): void {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  commit((m) => {
    (m as MeshNode).animGraph = graph;
    if (graph) (m as MeshNode).anim.autoplay = true; // 图模式下自动播放入口状态
  }, "编辑动画图");
}

// ---------------------------------------------------------------------------
// 材质资产（Material）卡片事件
// ---------------------------------------------------------------------------

/** 切换到另一份材质资产：先取到新材质参数再提交引用（避免先默认灰再跳变） */
async function onSetMaterial(rel: string): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode) || !rel || rel === n.material) return;
  const root = projectStore.currentPath;
  if (materialDirty) flushMaterialPersist(); // 切换前把正在编辑的材质落盘
  if (root && !engine.materials.has(rel)) {
    await engine.materials.preload([rel]);
  }
  commit((m) => { (m as MeshNode).material = rel; }, "Set Material");
  if (root) engine.refreshMaterialNodes(rel);
}

/** 修改当前材质资产的某个 PBR 参数/贴图：即时更新缓存（面板/视口立刻同步），文件写盘防抖 */
async function onMaterialEdit(
  field: MaterialParamKey | MaterialEnableKey,
  value: number | boolean | string,
): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  const root = projectStore.currentPath;
  if (!root) {
    logStore.log("error", "未打开项目，无法保存材质修改", "engine");
    return;
  }
  let rel = n.material;
  if (isInternalAsset(rel)) {
    // 内置材质只读（UI 已禁用，这里兜底）：先复制为项目材质再修改
    const dup = await duplicateMaterialToProject(root, rel, n.name);
    if (!dup) {
      logStore.log("error", "复制内置材质到项目失败", "engine");
      return;
    }
    mutateNode(n, (m) => {
      (m as MeshNode).material = dup;
    }, "复制材质到项目");
    rel = dup;
  }
  const params: MaterialParams = { ...engine.materials.paramsFor(rel) };
  if (field === "wireframe") {
    params.wireframe = value === true;
  } else if (isMaterialEnableKey(field)) {
    (params as unknown as Record<string, unknown>)[field] = value === true;
  } else if (typeof value === "string") {
    // 贴图通道：存项目资产相对路径（空串 = 无贴图）
    (params as unknown as Record<string, unknown>)[field] = value;
  } else {
    // 数值/颜色统一收敛（颜色按 hex 截断）
    (params as unknown as Record<string, unknown>)[field] = clampMaterialParam(
      field,
      value as number,
    );
  }
  // 先同步进缓存并广播（引用该材质的所有网格外观同步刷新），文件落盘走防抖
  engine.materials.cachePut(rel, params);
  scheduleMaterialPersist(rel, params);
}

/** 切换当前材质资产的类型（physical/unlit…）：改写 .mat 并按新类型重建视口材质 */
/** 切换当前材质挂载的着色器：改写 .mat 的 shader 引用并按新渲染分支重建视口材质 */
async function onMaterialChangeShader(shaderRel: string): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode) || !shaderRel) return;
  const root = projectStore.currentPath;
  if (!root) {
    logStore.log("error", "未打开项目，无法切换着色器", "engine");
    return;
  }
  let rel = n.material;
  if (isInternalAsset(rel)) {
    // 内置材质只读（UI 已禁用，这里兜底）：先复制为项目材质再切换着色器
    const dup = await duplicateMaterialToProject(root, rel, n.name);
    if (!dup) {
      logStore.log("error", "复制内置材质到项目失败", "engine");
      return;
    }
    mutateNode(n, (m) => {
      (m as MeshNode).material = dup;
    }, "复制材质到项目");
    rel = dup;
  }
  if (materialDirty) flushMaterialPersist(); // 切换前先落盘旧的参数修改
  // 解析新着色器的渲染分支（.shader 读取失败回退 PBR），缓存 + 落盘都在
  // scheduleMaterialPersist 内完成（引用该材质的网格按新分支重建 three 材质）
  const kind = await loadShaderKind(root, shaderRel);
  const params: MaterialParams = { ...engine.materials.paramsFor(rel) };
  scheduleMaterialPersist(rel, params, kind, shaderRel);
}

/** 复制当前材质为项目资产并绑定到本节点（内置材质转可编辑 / 生成独立副本） */
async function onMaterialCopyToProject(): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  const root = projectStore.currentPath;
  if (!root) return;
  if (materialDirty) flushMaterialPersist(); // 复制前先把未落盘的修改写入源文件
  const dup = await duplicateMaterialToProject(root, n.material, n.name);
  if (!dup) {
    logStore.log("error", "复制材质资产失败", "engine");
    return;
  }
  // 复制完成后先把新副本文档（类型 + 参数 + 着色器引用）入缓存，再切换引用：面板/视口不经过默认灰
  if (root) {
    const dupDoc = await loadMaterialDoc(root, dup);
    if (dupDoc) engine.materials.cachePut(dup, dupDoc.params, dupDoc.type, dupDoc.shader);
  }
  mutateNode(n, (m) => { (m as MeshNode).material = dup; }, "复制材质到项目");
  if (root) engine.refreshMaterialNodes(dup);
  // 资产面板下拉项同步
  void assetsStore.load(root);
}

// ---------------------------------------------------------------------------
// 音频卡片（Audio）事件：节点数据提交（可撤销）；运行时控制由卡片直连引擎
// ---------------------------------------------------------------------------

function onAudioUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof AudioNode)) return;
  commit((m) => {
    const audio = (m as AudioNode).audio;
    switch (label) {
      case "Set Audio Source":
        audio.source = typeof value === "string" ? value : "";
        break;
      case "Set Audio Autoplay":
        audio.autoplay = value === true;
        break;
      case "Set Audio Loop":
        audio.loop = value === true;
        break;
      case "Set Audio Volume":
        audio.volume = typeof value === "number" ? Math.max(0, Math.min(1, value)) : 1;
        break;
      case "Set Audio Speed":
        audio.speed = typeof value === "number" ? Math.max(0.1, Math.min(4, value)) : 1;
        break;
      case "Set Audio Spatial":
        audio.spatial = value === "3d" ? "3d" : "2d";
        break;
      case "Set Audio RefDistance":
        audio.refDistance = typeof value === "number" ? Math.max(0.01, value) : 1;
        break;
      case "Set Audio MaxDistance":
        audio.maxDistance = typeof value === "number" ? Math.max(0.01, value) : 30;
        break;
      case "Set Audio Rolloff":
        audio.rolloff = typeof value === "number" ? Math.max(0, value) : 1;
        break;
    }
  }, label);
}

function onLightUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof LightNode)) return;
  commit((target) => {
    const light = target as LightNode;
    switch (label) {
      case "Set Color":
        light.lightColor = value as number;
        break;
      case "Set Intensity":
        light.intensity = value as number;
        break;
      case "Set Distance":
        if (light instanceof PointLightNode || light instanceof SpotLightNode) {
          light.distance = value as number;
        }
        break;
      case "Set Decay":
        if (light instanceof PointLightNode || light instanceof SpotLightNode) {
          light.decay = value as number;
        }
        break;
      case "Set Angle":
        if (light instanceof SpotLightNode) light.angle = value as number;
        break;
      case "Set Penumbra":
        if (light instanceof SpotLightNode) light.penumbra = value as number;
        break;
      case "Toggle Shadow":
        if (light instanceof DirectionalLightNode || light instanceof SpotLightNode) {
          light.castShadow = value as boolean;
        }
        break;
    }
  }, label);
}

function onCameraEdit(field: CameraParamKey, value: number): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode)) return;
  const v = clampCameraParam(field, value);
  commit((target) => {
    (target as CameraNode)[field] = v;
  }, `Set ${cameraParamDef(field).label}`);
}

/** 切换相机类型（透视/正交）：视锥辅助线与预览渲染按新类型重建 */
function onCameraChangeType(type: string): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode) || !type) return;
  if (type !== "perspective" && type !== "orthographic") return;
  commit((target) => {
    (target as CameraNode).cameraType = type;
  }, "Set Camera Type");
}

/** 切换清除标志（天空盒/纯色/仅深度/仅颜色）：预览渲染的清屏方式随之变化 */
function onCameraClearFlags(flags: string): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode)) return;
  const v = parseCameraClearFlags(flags);
  if (v === n.clearFlags) return;
  commit((target) => {
    (target as CameraNode).clearFlags = v;
  }, "Set Clear Flags");
}

/** 修改纯色清屏色（清除标志=纯色时的背景色） */
function onCameraClearColor(color: number): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode)) return;
  const v = color & 0xffffff;
  if (v === n.clearColor) return;
  commit((target) => {
    (target as CameraNode).clearColor = v;
  }, "Set Clear Color");
}

/** 切换天空盒材质引用（内置或项目资产；类型不变，仅切换引用的 .mat） */
function onSetSkyMaterial(rel: string): void {
  const n = node.value;
  if (!n || !(n instanceof SkyboxNode) || !rel || rel === n.material) return;
  commit((m) => {
    (m as SkyboxNode).material = rel;
  }, "Set Sky Material");
}

/** 把当前天空材质（内置只读）复制为项目资产并绑定到本节点 */
async function onSkyMaterialCopyToProject(): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof SkyboxNode)) return;
  const root = projectStore.currentPath;
  if (!root) return;
  const dup = await duplicateMaterialToProject(root, n.material, n.name);
  if (!dup) {
    logStore.log("error", "复制天空盒材质资产失败", "engine");
    return;
  }
  commit((m) => {
    (m as SkyboxNode).material = dup;
  }, "复制天空材质到项目");
  void assetsStore.load(root);
}

// ---------------------------------------------------------------------------
// 组件模式（Unity 组件卡语义）：
// - 节点上每个已挂组件（脚本/刚体/碰撞体/灯光/音源）渲染为独立卡片，按挂载
//   顺序排列；卡片头 = 启用勾选 + ⋮ 菜单（上移/下移/重置/移除）；
// - 「添加组件」菜单由组件注册表驱动（分类 + 多实例约束）；
// - 全部增删改走 commit → mutateNode（整节点快照进撤销历史）。
// ---------------------------------------------------------------------------

const scriptList = computed<string[]>(() => {
  void projectStore.currentPath;
  return scriptsStore.listScripts();
});

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.ts$/, "");
}

/** 新建脚本：切换到脚本视图，输入名称后在 src/ 下创建并挂载到当前节点 */
async function onCreateScript(): Promise<void> {
  store.setViewMode("script");
  const name = await prompt({
    title: "新建脚本",
    label: "脚本名（创建在 src/ 目录）",
    placeholder: "MyScript",
  });
  if (!name?.trim()) return;
  const rel = await scriptsStore.createScript(name.trim());
  if (rel) onAddScriptComponent(rel);
}

/** 集中式「添加组件」菜单：注册表驱动（分类分组 + 多实例约束 + 脚本清单） */
function onAddComponentMenu(e: MouseEvent): void {
  const n = node.value;
  if (!n) return;

  const scriptItems: CtxMenuItem[] = scriptList.value.map((rel) => ({
    label: baseName(rel),
    onClick: () => onAddScriptComponent(rel),
  }));
  if (!scriptItems.length) {
    scriptItems.push({ label: "（src/ 内暂无脚本）", disabled: true });
  }
  scriptItems.push(menuSeparator(), { label: "新建脚本…", onClick: () => void onCreateScript() });

  const physicsChildren: CtxMenuItem[] = (["rigidBody", "collider"] as const).map((type) => {
    const meta = componentMetaOf(type);
    return {
      label: meta.label,
      disabled: !canAddComponent(n, type),
      onClick: () => onAddBuiltinComponent(type),
    };
  });
  // 灯光组件单实例：已挂载时各灯光类型菜单项禁用；子项直接落到对应类型
  const lightingChildren: CtxMenuItem[] = LIGHT_KIND_OPTIONS.map((k) => ({
    label: k.label,
    disabled: !canAddComponent(n, "light"),
    onClick: () => onAddBuiltinComponent("light", k.value),
  }));
  const audioChildren: CtxMenuItem[] = [
    { label: componentMetaOf("audioSource").label, onClick: () => onAddBuiltinComponent("audioSource") },
  ];

  const items: CtxMenuItem[] = [
    { label: "物理", children: physicsChildren },
    { label: "光照", children: lightingChildren },
    { label: "音频", children: audioChildren },
    menuSeparator(),
    { label: "脚本", children: scriptItems },
  ];
  openContextMenu(e, items);
}

/** 添加内置组件（注册表工厂建默认引用；可撤销） */
function onAddBuiltinComponent(type: "rigidBody" | "collider" | "light" | "audioSource", lightKind?: "point" | "directional" | "ambient" | "spot"): void {
  const n = node.value;
  if (!n || !canAddComponent(n, type)) return;
  const comp = createComponentRef(type, { lightKind });
  commit((target) => {
    target.components = [...target.components, comp];
  }, `添加${componentMetaOf(type).label.split(" ")[0]}组件`);
}

function onAddScriptComponent(scriptRel: string): void {
  const n = node.value;
  if (!n || !scriptRel) return;
  const comp = createScriptComponentRef(scriptRel);
  commit((target) => {
    target.components = [...target.components, comp];
  }, "添加脚本组件");
}

// —— 组件卡通用操作（启用/移除/排序/重置） ——

/** 卡片折叠状态（记录已折叠的组件 id；缺省展开） */
const closedComps = ref(new Set<string>());

function onToggleCompCard(compId: string): void {
  const next = new Set(closedComps.value);
  if (next.has(compId)) next.delete(compId);
  else next.add(compId);
  closedComps.value = next;
}

function onToggleComponent(compId: string, enabled: boolean): void {
  commit((target) => {
    target.components = target.components.map((c) =>
      c.id === compId ? { ...c, enabled } : c,
    );
  }, enabled ? "启用组件" : "停用组件");
}

function onRemoveComponent(compId: string): void {
  commit((target) => {
    target.components = target.components.filter((c) => c.id !== compId);
  }, "移除组件");
}

/** 上移/下移组件（挂载顺序 = 卡片顺序 = 脚本同序执行顺序） */
function onMoveComponent(compId: string, dir: -1 | 1): void {
  commit((target) => {
    const list = [...target.components];
    const i = list.findIndex((c) => c.id === compId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    target.components = list;
  }, dir < 0 ? "上移组件" : "下移组件");
}

/** 重置组件设置为该类型默认值（保留 id/启用状态；脚本保留路径与执行顺序） */
function onResetComponent(compId: string): void {
  commit((target) => {
    const comp = target.components.find((c) => c.id === compId);
    if (comp) resetComponentSettings(comp);
  }, "重置组件");
}

/** 组件卡 ⋮ 菜单（Unity 组件上下文菜单语义：Move Up/Down/Reset/Remove） */
function onComponentMenu(e: MouseEvent, comp: NodeComponentRef): void {
  const n = node.value;
  if (!n) return;
  const idx = n.components.findIndex((c) => c.id === comp.id);
  const items: CtxMenuItem[] = [
    { label: "上移", disabled: idx <= 0, onClick: () => onMoveComponent(comp.id, -1) },
    {
      label: "下移",
      disabled: idx < 0 || idx >= n.components.length - 1,
      onClick: () => onMoveComponent(comp.id, 1),
    },
    { label: "重置", onClick: () => onResetComponent(comp.id) },
  ];
  if (isScriptComponent(comp)) {
    items.unshift({
      label: "编辑脚本",
      onClick: () => {
        store.setViewMode("script");
        void scriptsStore.openScript(comp.script);
      },
    });
  }
  items.push(menuSeparator(), { label: "移除组件", danger: true, onClick: () => onRemoveComponent(comp.id) });
  openContextMenu(e, items);
}

// —— 各类型组件的字段编辑（可撤销） ——

function onScriptComponentProp(compId: string, key: string, value: unknown): void {
  commit((target) => {
    target.components = target.components.map((c) => {
      if (c.id !== compId || !isScriptComponent(c)) return c;
      const props = { ...c.props };
      // 属性值由检查器按脚本声明类型收敛（number/string/boolean/color/vec3）
      props[key] = value as JsonValue;
      return { ...c, props };
    });
  }, "设置组件属性");
}

function onScriptExecutionOrder(compId: string, value: number): void {
  commit((target) => {
    target.components = target.components.map((c) =>
      c.id === compId && isScriptComponent(c) ? { ...c, executionOrder: value } : c,
    );
  }, "设置执行顺序");
}

function onRigidBodyUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n) return;
  commit((target) => {
    const comp = target.components.find(isRigidBodyComponent);
    if (!comp) return;
    const rb: RigidBodySettings = comp.rigidBody;
    switch (label) {
      case "Set RigidBody Mode":
        if (value === "static" || value === "kinematic" || value === "dynamic") rb.mode = value;
        break;
      case "Set RigidBody Mass":
        rb.mass = Math.max(0.001, typeof value === "number" ? value : 1);
        break;
      case "Set RigidBody LinearDamping":
        rb.linearDamping = Math.max(0, typeof value === "number" ? value : 0);
        break;
      case "Set RigidBody AngularDamping":
        rb.angularDamping = Math.max(0, typeof value === "number" ? value : 0);
        break;
      case "Set RigidBody GravityScale":
        rb.gravityScale = Math.max(0, typeof value === "number" ? value : 1);
        break;
      case "Set RigidBody CCD":
        rb.ccd = value === true;
        break;
    }
  }, label);
}

function onColliderUpdate(compId: string, label: string, value: unknown): void {
  const n = node.value;
  if (!n) return;
  commit((target) => {
    const comp = target.components.find(
      (c): c is ColliderComponentRef => c.id === compId && isColliderComponent(c),
    );
    if (!comp) return;
    const col: ColliderSettings = comp.collider;
    const axis = (a: "x" | "y" | "z"): void => {
      col.size[a] = Math.max(0.1, typeof value === "number" ? value : 1);
    };
    const offsetAxis = (a: "x" | "y" | "z"): void => {
      col.offset[a] = typeof value === "number" ? value : 0;
    };
    switch (label) {
      case "Set Collider Shape":
        if (
          value === "box" || value === "sphere" || value === "capsule" ||
          value === "cylinder" || value === "convex"
        ) {
          col.shape = value;
        }
        break;
      case "Set Collider AutoSize":
        col.autoSize = value === true;
        break;
      case "Set Collider Size X": axis("x"); break;
      case "Set Collider Size Y": axis("y"); break;
      case "Set Collider Size Z": axis("z"); break;
      case "Set Collider Offset X": offsetAxis("x"); break;
      case "Set Collider Offset Y": offsetAxis("y"); break;
      case "Set Collider Offset Z": offsetAxis("z"); break;
      case "Set Collider Friction":
        col.friction = Math.max(0, Math.min(4, typeof value === "number" ? value : 0.6));
        break;
      case "Set Collider Restitution":
        col.restitution = Math.max(0, Math.min(1, typeof value === "number" ? value : 0.1));
        break;
      case "Set Collider Sensor":
        col.isSensor = value === true;
        break;
    }
  }, label);
}

/** 灯光组件编辑（类型切换 + 参数；光照语义与灯光节点一致） */
function onLightComponentUpdate(compId: string, label: string, value: unknown): void {
  commit((target) => {
    const comp = target.components.find(
      (c): c is LightComponentRef => c.id === compId && isLightComponent(c),
    );
    if (!comp) return;
    const s = comp.light;
    switch (label) {
      case "Set Light Kind":
        if (value === "point" || value === "directional" || value === "ambient" || value === "spot") {
          s.kind = value;
        }
        break;
      case "Set Color":
        s.lightColor = (value as number) & 0xffffff;
        break;
      case "Set Intensity":
        s.intensity = Math.max(0, typeof value === "number" ? value : 1);
        break;
      case "Toggle Shadow":
        s.castShadow = value === true;
        break;
      case "Set Distance":
        s.distance = Math.max(0, typeof value === "number" ? value : 0);
        break;
      case "Set Decay":
        s.decay = Math.max(0, Math.min(10, typeof value === "number" ? value : 2));
        break;
      case "Set Angle":
        s.angle = Math.max(0.1, Math.min(89.9, typeof value === "number" ? value : 45));
        break;
      case "Set Penumbra":
        s.penumbra = Math.max(0, Math.min(1, typeof value === "number" ? value : 0.2));
        break;
    }
  }, label);
}

/** 音源组件编辑（复用音源设置的标签语义） */
function onAudioComponentUpdate(compId: string, label: string, value: unknown): void {
  commit((target) => {
    const comp = target.components.find(
      (c): c is AudioSourceComponentRef => c.id === compId && isAudioSourceComponent(c),
    );
    if (!comp) return;
    const a = comp.audio;
    switch (label) {
      case "Set Audio Source":
        a.source = typeof value === "string" ? value : "";
        break;
      case "Set Audio Autoplay":
        a.autoplay = value === true;
        break;
      case "Set Audio Loop":
        a.loop = value === true;
        break;
      case "Set Audio Volume":
        a.volume = typeof value === "number" ? Math.max(0, Math.min(1, value)) : 1;
        break;
      case "Set Audio Speed":
        a.speed = typeof value === "number" ? Math.max(0.1, Math.min(4, value)) : 1;
        break;
      case "Set Audio Spatial":
        a.spatial = value === "3d" ? "3d" : "2d";
        break;
      case "Set Audio RefDistance":
        a.refDistance = typeof value === "number" ? Math.max(0.01, value) : 1;
        break;
      case "Set Audio MaxDistance":
        a.maxDistance = typeof value === "number" ? Math.max(0.01, value) : 30;
        break;
      case "Set Audio Rolloff":
        a.rolloff = typeof value === "number" ? Math.max(0, value) : 1;
        break;
    }
  }, label);
}

// ---------------------------------------------------------------------------
// 组件卡展示派生（标题/分类标签；rev 为失效信号）
// ---------------------------------------------------------------------------

/** 已挂组件列表（按挂载序 = 卡片序） */
const mountedComponents = computed<NodeComponentRef[]>(() => {
  void revision.value;
  const n = node.value;
  return n ? n.components : [];
});

const LIGHT_COMP_TITLES: Record<string, string> = {
  point: "Point Light",
  directional: "Directional Light",
  ambient: "Ambient Light",
  spot: "Spot Light",
};

function compCardTitle(c: NodeComponentRef): string {
  switch (c.type) {
    case "script":
      return baseName(c.script);
    case "light":
      return LIGHT_COMP_TITLES[c.light.kind] ?? "Light";
    case "rigidBody":
      return "Rigid Body";
    case "collider":
      return "Collider";
    case "audioSource":
      return "Audio Source";
  }
}

function compCardType(c: NodeComponentRef): string {
  // 分类中文名（meta.label 形如 "刚体 Rigid Body"，取首段中文）
  return componentMetaOf(c.type).label.split(" ")[0] ?? c.type;
}

// —— 多选批量编辑（选中 ≥2 个节点时检查器切换为批量卡） ——

const multiIds = computed<string[]>(() => {
  void revision.value;
  return store.state.selectionIds;
});

/**
 * 多选批量添加组件菜单：注册表驱动；单实例组件已挂载的节点自动跳过
 * （一次菜单操作 = 一条批量补丁历史）。
 */
function onMultiAddComponentMenu(e: MouseEvent): void {
  const targets = multiIds.value
    .map((id) => engine.graph.get(id))
    .filter((n): n is Node => !!n);
  if (!targets.length) return;

  const addBuiltin = (
    type: "rigidBody" | "collider" | "light" | "audioSource",
    lightKind?: "point" | "directional" | "ambient" | "spot",
  ): void => {
    const items = targets
      .filter((n) => canAddComponent(n, type))
      .map((n) => {
        const before = n.toJSON() as JsonRecord;
        n.components = [...n.components, createComponentRef(type, { lightKind })];
        const after = n.toJSON() as JsonRecord;
        return { id: n.id, before, after };
      });
    if (items.length) {
      engine.patchNodes(items, "批量添加" + componentMetaOf(type).label.split(" ")[0] + "组件");
    }
  };
  const addScript = (scriptRel: string): void => {
    const items = targets.map((n) => {
      const before = n.toJSON() as JsonRecord;
      n.components = [...n.components, createScriptComponentRef(scriptRel)];
      const after = n.toJSON() as JsonRecord;
      return { id: n.id, before, after };
    });
    if (items.length) engine.patchNodes(items, "批量添加脚本组件");
  };

  const scriptItems: CtxMenuItem[] = scriptList.value.map((rel) => ({
    label: baseName(rel),
    onClick: () => addScript(rel),
  }));
  if (!scriptItems.length) {
    scriptItems.push({ label: "（src/ 内暂无脚本）", disabled: true });
  }
  scriptItems.push(menuSeparator(), { label: "新建脚本…", onClick: () => void onCreateScript() });

  const items: CtxMenuItem[] = [
    {
      label: "物理",
      children: (["rigidBody", "collider"] as const).map((type) => ({
        label: componentMetaOf(type).label,
        onClick: () => addBuiltin(type),
      })),
    },
    {
      label: "光照",
      children: LIGHT_KIND_OPTIONS.map((k) => ({
        label: k.label,
        onClick: () => addBuiltin("light", k.value),
      })),
    },
    {
      label: "音频",
      children: [
        { label: componentMetaOf("audioSource").label, onClick: () => addBuiltin("audioSource") },
      ],
    },
    menuSeparator(),
    { label: "脚本", children: scriptItems },
  ];
  openContextMenu(e, items);
}

/**
 * 模拟控制并入物理组件卡：刚体卡始终带模拟控制；无刚体时由首个碰撞体卡承担
 * （隐式静态碰撞体也参与模拟）。其余组件卡不显示。
 */
function showSimStrip(c: NodeComponentRef): boolean {
  const n = node.value;
  if (!n) return false;
  if (isRigidBodyComponent(c)) return true;
  if (isColliderComponent(c)) {
    const firstCollider = n.components.find(isColliderComponent);
    return !n.components.some(isRigidBodyComponent) && firstCollider?.id === c.id;
  }
  return false;
}

/** 设置节点标签（GameObject Tag 语义） */
function onNodeSetTag(tag: string): void {
  commit((n) => {
    n.tag = tag;
  }, "设置标签");
}
</script>

<template>
  <div class="panel inspector">
    <!-- 资产模式：资产面板选中资产 → 预览 + 暴露属性（最后点击优先于节点检查器） -->
    <div v-if="assetMode && assetRel" class="inspector-body mono">
      <ComponentCard title="Asset" :open="true" :type="assetRel.split('.').pop()">
        <AssetInspector :rel="assetRel" />
      </ComponentCard>
    </div>

    <!-- 多选：批量编辑卡（变换/标签/启停/批量加组件，一次撤销） -->
    <div v-else-if="multiIds.length > 1" class="inspector-body mono">
      <ComponentCard title="Multiple Selection" :open="true" :type="multiIds.length + ' 节点'">
        <MultiSection :ids="multiIds" :rev="revision" @addComponentMenu="onMultiAddComponentMenu" />
      </ComponentCard>
    </div>

    <div v-else-if="!node" class="empty muted">未选择节点</div>

    <div v-else class="inspector-body mono">
      <ComponentCard title="Node" :open="true" :type="node.typeKey">
        <template #head>
          <label class="active-toggle" title="是否激活（失活后视口隐藏）" @click.stop>
            <input
              type="checkbox"
              :checked="node.active"
              @change="onNodeToggleActive(($event.target as HTMLInputElement).checked)"
            />
            <span>激活</span>
          </label>
        </template>
        <NodeSection
          :node="node"
          :rev="revision"
          @rename="onNodeRename"
          @setTag="onNodeSetTag"
          @toggleActive="onNodeToggleActive"
          @toggleVisible="onNodeToggleVisible"
        />
      </ComponentCard>

      <ComponentCard title="Transform" :open="true">
        <TransformSection :node="node" :rev="revision" @transform="onTransformChange" />
      </ComponentCard>

      <ComponentCard v-if="node instanceof MeshNode" title="Mesh" :open="true">
        <MeshSection :node="node" :rev="revision" @update="onMeshUpdate" />
      </ComponentCard>

      <!-- 材质卡片：基元 = .mat 资产编辑；模型 = 内嵌材质清单（按模型内容显隐） -->
      <ComponentCard
        v-if="node instanceof MeshNode && node.source === 'primitive'"
        title="Material"
        :open="true"
      >
        <MaterialSection
          :node="node"
          :rev="revision"
          @setMaterial="onSetMaterial"
          @editParam="onMaterialEdit"
          @changeShader="onMaterialChangeShader"
          @copyToProject="onMaterialCopyToProject"
        />
      </ComponentCard>
      <ComponentCard
        v-else-if="node instanceof MeshNode && modelHasMaterials"
        title="Material"
        :open="true"
      >
        <ModelMaterialSection :node="node" :rev="revision" />
      </ComponentCard>

      <!-- 动画卡片：模型携带动画剪辑时显示（静态模型不出卡片） -->
      <ComponentCard
        v-if="node instanceof MeshNode && node.source === 'model' && modelHasClips"
        title="Animation"
        :open="true"
      >
        <AnimationSection
          :node="node"
          :rev="revision"
          @updateAnim="onAnimUpdate"
          @updateGraph="onAnimGraphUpdate"
        />
      </ComponentCard>

      <ComponentCard v-if="node instanceof LightNode" title="Light" :open="true">
        <LightSection :node="node" :rev="revision" @update="onLightUpdate" />
      </ComponentCard>

      <ComponentCard v-if="node instanceof CameraNode" title="Camera" :open="true">
        <CameraSection
          :node="node"
          :rev="revision"
          @editParam="onCameraEdit"
          @changeType="onCameraChangeType"
          @editClearFlags="onCameraClearFlags"
          @editClearColor="onCameraClearColor"
        />
      </ComponentCard>

      <ComponentCard v-if="node instanceof SkyboxNode" title="Skybox" :open="true">
        <SkyboxSection
          :node="node"
          :rev="revision"
          @setMaterial="onSetSkyMaterial"
          @copyToProject="onSkyMaterialCopyToProject"
        />
      </ComponentCard>

      <ComponentCard v-if="node instanceof AudioNode" title="Audio" :open="true">
        <AudioSection :settings="node.audio" :runtime-id="node.id" :rev="revision" @update="onAudioUpdate" />
      </ComponentCard>

      <!-- —— 已挂组件卡（按挂载序 = 卡片序；Unity 组件卡语义：启用勾选 + ⋮ 菜单） —— -->
      <template v-for="c in mountedComponents" :key="c.id">
        <ComponentCard
          :title="compCardTitle(c)"
          :type="compCardType(c)"
          :open="!closedComps.has(c.id)"
          :dim="!c.enabled"
          @toggle="onToggleCompCard(c.id)"
        >
          <template #head>
            <label class="comp-card-toggle" title="启用/停用组件" @click.stop>
              <input
                type="checkbox"
                :checked="c.enabled"
                @change="onToggleComponent(c.id, ($event.target as HTMLInputElement).checked)"
              />
            </label>
            <button class="comp-card-menu" title="组件操作" @click.stop="onComponentMenu($event, c)">⋮</button>
          </template>

          <template v-if="c.enabled">
            <ScriptFields
              v-if="isScriptComponent(c)"
              :comp="c"
              :rev="revision"
              @setProp="(key, value) => onScriptComponentProp(c.id, key, value)"
              @setExecutionOrder="(v) => onScriptExecutionOrder(c.id, v)"
            />
            <template v-else-if="isRigidBodyComponent(c)">
              <RigidBodyFields
                :comp="c"
                @update="(label, value) => onRigidBodyUpdate(label, value)"
              />
              <!-- 模拟控制并入刚体卡（运行时控制，不落盘） -->
              <PhysicsSimSection :node="node" :rev="revision" />
            </template>
            <template v-else-if="isColliderComponent(c)">
              <ColliderFields
                :comp="c"
                @update="(label, value) => onColliderUpdate(c.id, label, value)"
              />
              <!-- 无刚体的碰撞体（隐式静态）：首个碰撞体卡承担模拟控制入口 -->
              <PhysicsSimSection v-if="showSimStrip(c)" :node="node" :rev="revision" />
            </template>
            <LightComponentFields
              v-else-if="isLightComponent(c)"
              :comp="c"
              @update="(label, value) => onLightComponentUpdate(c.id, label, value)"
            />
            <AudioSection
              v-else-if="isAudioSourceComponent(c)"
              :settings="c.audio"
              :runtime-id="c.id"
              :rev="revision"
              @update="(label, value) => onAudioComponentUpdate(c.id, label, value)"
            />
          </template>
          <div v-else class="hint">组件已停用</div>
        </ComponentCard>
      </template>

      <!-- 集中式添加组件入口：注册表驱动（物理/光照/音频/脚本），弹出子菜单 -->
      <button class="add-comp-btn" @click="onAddComponentMenu">＋ 添加组件</button>
    </div>
  </div>
</template>
