<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { logStore } from "../stores/log";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode, SkyboxNode, DirectionalLightNode, PointLightNode, SpotLightNode } from "../../framework/prototype/derived/Primitives";
import type { MaterialParams, MaterialParamKey, MaterialEnableKey } from "../../framework/material";
import { clampMaterialParam, isMaterialEnableKey, materialFileStem } from "../../framework/material";
import { clampCameraParam, cameraParamDef, parseCameraClearFlags, type CameraParamKey } from "../../framework/camera";
import { nextId } from "../../platform_abstraction/id";
import type { NodeComponentRef } from "../../framework/prototype/Node";
import { isInternalAsset } from "../../lib/internal-assets";
import {
  duplicateMaterialToProject,
  loadMaterialDoc,
  saveMaterialParams,
} from "../lib/materials";
import type { JsonRecord, JsonValue } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/scene/SceneClient";
import type { AnimGraph } from "../../framework/animation";
import { isModelAssetRel } from "../../framework/mesh";
import { dispatchCommand } from "../commands";
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
import AssetInspector from "./inspector/AssetInspector.vue";
import ComponentsSection from "./inspector/ComponentsSection.vue";
import "../../styles/components/inspector-panel.scss";

const store = getEditorStore();
const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
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
watch(
  () => assetsStore.selectedAsset,
  (rel) => {
    if (rel) assetMode.value = true;
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
  type: string;
  params: MaterialParams;
} | null = null;

function persistMaterialNow(d: NonNullable<typeof materialDirty>): void {
  saveMaterialParams(d.root, d.rel, d.name, d.params, d.type).catch((e) =>
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

function scheduleMaterialPersist(rel: string, params: MaterialParams, type?: string): void {
  const root = projectStore.currentPath;
  if (!root) return;
  // 连续编辑中切到另一份材质时，先把上一份落盘，避免被覆盖丢失
  if (materialDirty && materialDirty.rel !== rel) flushMaterialPersist();
  // 类型缺省时取引擎缓存的当前类型（参数编辑不改类型；类型切换显式传入）
  materialDirty = {
    root,
    rel,
    name: materialFileStem(rel),
    type: type ?? engine.materials.typeFor(rel),
    params: { ...params },
  };
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
async function onMaterialChangeType(type: string): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode) || !type) return;
  const root = projectStore.currentPath;
  if (!root) {
    logStore.log("error", "未打开项目，无法切换材质类型", "engine");
    return;
  }
  let rel = n.material;
  if (isInternalAsset(rel)) {
    // 内置材质只读（UI 已禁用，这里兜底）：先复制为项目材质再切换类型
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
  if (materialDirty) flushMaterialPersist(); // 类型变更前先落盘旧的参数修改
  const params: MaterialParams = { ...engine.materials.paramsFor(rel) };
  // 写入新类型并广播：引用该材质的网格按新类型重建 three 材质（类型不符 → 工厂重建）
  engine.materials.cachePut(rel, params, type);
  scheduleMaterialPersist(rel, params, type);
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
  // 复制完成后先把新副本文档（类型 + 参数）入缓存，再切换引用：面板/视口不经过默认灰
  if (root) {
    const dupDoc = await loadMaterialDoc(root, dup);
    if (dupDoc) engine.materials.cachePut(dup, dupDoc.params, dupDoc.type);
  }
  mutateNode(n, (m) => { (m as MeshNode).material = dup; }, "复制材质到项目");
  if (root) engine.refreshMaterialNodes(dup);
  // 资产面板下拉项同步
  void assetsStore.load(root);
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

function onSkyboxUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof SkyboxNode)) return;
  commit((target) => {
    const sky = target as SkyboxNode;
    switch (label) {
      case "Set Top Color":
        sky.topColor = (value as number) & 0xffffff;
        break;
      case "Set Horizon Color":
        sky.horizonColor = (value as number) & 0xffffff;
        break;
      case "Set Ground Color":
        sky.groundColor = (value as number) & 0xffffff;
        break;
      case "Set Sun Disk": {
        const d = value as string;
        if (d === "high" || d === "simple" || d === "none") sky.sunDisk = d;
        break;
      }
      case "Set Sun Color":
        sky.sunColor = (value as number) & 0xffffff;
        break;
      case "Set Sun Size":
        sky.sunSize = Math.max(0.2, Math.min(30, value as number));
        break;
      case "Set Sun Glow":
        sky.sunGlow = Math.max(0, Math.min(1, value as number));
        break;
      case "Set Sun Azimuth": {
        const az = (value as number) % 360;
        sky.sunAzimuth = az < 0 ? az + 360 : az;
        break;
      }
      case "Set Sun Elevation":
        sky.sunElevation = Math.max(0, Math.min(360, value as number));
        break;
    }
  }, label);
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
// 脚本组件（Components 卡片）：增删改走 commit → patchNode（可撤销）
// ---------------------------------------------------------------------------

function onAddScriptComponent(scriptRel: string): void {
  const n = node.value;
  if (!n || !scriptRel) return;
  commit((target) => {
    const comp: NodeComponentRef = {
      id: nextId("comp"),
      type: "script",
      script: scriptRel,
      enabled: true,
      props: {},
    };
    target.components = [...target.components, comp];
  }, "添加脚本组件");
}

function onRemoveScriptComponent(compId: string): void {
  const n = node.value;
  if (!n) return;
  commit((target) => {
    target.components = target.components.filter((c) => c.id !== compId);
  }, "移除脚本组件");
}

function onToggleScriptComponent(compId: string, enabled: boolean): void {
  const n = node.value;
  if (!n) return;
  commit((target) => {
    target.components = target.components.map((c) =>
      c.id === compId ? { ...c, enabled } : c,
    );
  }, enabled ? "启用脚本组件" : "停用脚本组件");
}

function onScriptComponentProp(compId: string, key: string, value: unknown): void {
  const n = node.value;
  if (!n) return;
  commit((target) => {
    target.components = target.components.map((c) => {
      if (c.id !== compId) return c;
      const props = { ...c.props };
      // 属性值由检查器按脚本声明类型收敛（number/string/boolean/color/vec3）
      props[key] = value as JsonValue;
      return { ...c, props };
    });
  }, "设置组件属性");
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
          @changeType="onMaterialChangeType"
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
          @update="onSkyboxUpdate"
        />
      </ComponentCard>

      <ComponentCard title="Components" :open="true">
        <ComponentsSection
          :node="node"
          :rev="revision"
          @addComponent="onAddScriptComponent"
          @removeComponent="onRemoveScriptComponent"
          @toggleComponent="onToggleScriptComponent"
          @setProp="onScriptComponentProp"
        />
      </ComponentCard>
    </div>
  </div>
</template>
