<script setup lang="ts">
import { computed, onMounted } from "vue";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { logStore } from "../stores/log";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode, DirectionalLightNode, PointLightNode, SpotLightNode } from "../../framework/prototype/derived/Primitives";
import type { MaterialParams, MaterialParamKey } from "../../framework/material";
import { materialFileStem } from "../../framework/material";
import { isInternalAsset } from "../../lib/internal-assets";
import { duplicateMaterialToProject, listProjectMaterialRels, saveMaterialParams } from "../lib/materials";
import type { JsonRecord } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/command/commands";
import ComponentCard from "./ComponentCard.vue";
import NodeSection from "./inspector/NodeSection.vue";
import TransformSection from "./inspector/TransformSection.vue";
import MeshSection from "./inspector/MeshSection.vue";
import MaterialSection from "./inspector/MaterialSection.vue";
import LightSection from "./inspector/LightSection.vue";
import CameraSection from "./inspector/CameraSection.vue";
import ComponentsSection from "./inspector/ComponentsSection.vue";
import "../../styles/components/inspector-panel.scss";

const store = getEditorStore();
const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
const { state, engine } = store;

const node = computed<Node | undefined>(() => store.nodeById(state.selectedId ?? undefined));
const revision = computed(() => store.revision());

/** 进入编辑器/切换项目后同步一次资产列表（材质下拉需要 assets/materials 内容） */
onMounted(() => {
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
});

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
  engine.patchNode(n.id, before, after, label);
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
  engine.setTransform(n.id, next);
}

function onNodeRename(name: string): void {
  engine.renameSelected(name);
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
  if (label === "Set Geometry") {
    commit((m) => { (m as MeshNode).geometry = value as MeshNode["geometry"]; }, label);
  }
}

// ---------------------------------------------------------------------------
// 材质资产（Material）卡片事件
// ---------------------------------------------------------------------------

/** 切换到另一份材质资产 */
async function onSetMaterial(rel: string): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode) || !rel) return;
  commit((m) => { (m as MeshNode).material = rel; }, "Set Material");
  const root = projectStore.currentPath;
  if (!root) return;
  // 预取新引用的参数（若尚未缓存），成功后按真实参数刷新外观
  if (!engine.materials.has(rel)) {
    await engine.materials.preload([rel]);
    engine.refreshMaterialNodes(rel);
  }
}

/** 修改当前材质资产的某个参数（写入 .mat 文件 + 更新引擎缓存） */
async function onMaterialEdit(field: MaterialParamKey, value: number | boolean): Promise<void> {
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
    const taken = await listProjectMaterialRels(root);
    const dup = await duplicateMaterialToProject(root, rel, n.name, taken);
    if (!dup) {
      logStore.log("error", "复制内置材质到项目失败", "engine");
      return;
    }
    mutateNode(n, (m) => { (m as MeshNode).material = dup; }, "复制材质到项目");
    rel = dup;
  }
  const current = engine.materials.paramsFor(rel);
  const params: MaterialParams = { ...current };
  switch (field) {
    case "color":
      params.color = (value as number) & 0xffffff;
      break;
    case "emissive":
      params.emissive = (value as number) & 0xffffff;
      break;
    case "metalness":
      params.metalness = Math.max(0, Math.min(1, value as number));
      break;
    case "roughness":
      params.roughness = Math.max(0, Math.min(1, value as number));
      break;
    case "wireframe":
      params.wireframe = value === true;
      break;
  }
  try {
    await saveMaterialParams(root, rel, materialFileStem(rel), params);
    // 写缓存并广播：引用该材质的所有网格外观同步刷新
    engine.materials.cachePut(rel, params);
  } catch (e) {
    logStore.log("error", `保存材质 ${rel} 失败: ${e}`, "engine");
  }
}

/** 复制当前材质为项目资产并绑定到本节点（内置材质转可编辑 / 生成独立副本） */
async function onMaterialCopyToProject(): Promise<void> {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  const root = projectStore.currentPath;
  if (!root) return;
  const taken = await listProjectMaterialRels(root);
  const dup = await duplicateMaterialToProject(root, n.material, n.name, taken);
  if (!dup) {
    logStore.log("error", "复制材质资产失败", "engine");
    return;
  }
  mutateNode(n, (m) => { (m as MeshNode).material = dup; }, "复制材质到项目");
  if (!engine.materials.has(dup)) {
    await engine.materials.preload([dup]);
    engine.refreshMaterialNodes(dup);
  }
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

function onCameraUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode)) return;
  commit((target) => {
    const camera = target as CameraNode;
    switch (label) {
      case "Set Fov":
        camera.fov = value as number;
        break;
      case "Set Near":
        camera.near = Math.max(0.01, value as number);
        break;
      case "Set Far":
        camera.far = Math.max(1, value as number);
        break;
    }
  }, label);
}
</script>

<template>
  <div class="panel inspector">
    <div v-if="!node" class="empty muted">未选择节点</div>

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

      <ComponentCard v-if="node instanceof MeshNode" title="Material" :open="true">
        <MaterialSection
          :node="node"
          :rev="revision"
          @setMaterial="onSetMaterial"
          @editParam="onMaterialEdit"
          @copyToProject="onMaterialCopyToProject"
        />
      </ComponentCard>

      <ComponentCard v-if="node instanceof LightNode" title="Light" :open="true">
        <LightSection :node="node" :rev="revision" @update="onLightUpdate" />
      </ComponentCard>

      <ComponentCard v-if="node instanceof CameraNode" title="Camera" :open="true">
        <CameraSection :node="node" :rev="revision" @update="onCameraUpdate" />
      </ComponentCard>

      <ComponentCard title="Components" :open="true">
        <ComponentsSection :node="node" :rev="revision" />
      </ComponentCard>
    </div>
  </div>
</template>
