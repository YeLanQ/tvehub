<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CameraNode, LightNode, MeshNode, SkyboxNode, AudioNode, ParticleSystemNode } from "../../framework/prototype/derived/Primitives";
import {
  isAnimationClipComponent,
  isAudioSourceComponent,
  isColliderComponent,
  isLightComponent,
  isRigidBodyComponent,
  isScriptComponent,
} from "../../framework/prototype/Node";
import { useInspectorNode } from "../composables/inspector/useInspectorNode";
import { useInspectorMaterial } from "../composables/inspector/useInspectorMaterial";
import { useInspectorComponents } from "../composables/inspector/useInspectorComponents";
import { useInspectorPhysics } from "../composables/inspector/useInspectorPhysics";
import { useInspectorLightAudio } from "../composables/inspector/useInspectorLightAudio";
import { useInspectorCameraSky } from "../composables/inspector/useInspectorCameraSky";
import { useInspectorParticles } from "../composables/inspector/useInspectorParticles";
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
import ParticleSection from "./inspector/ParticleSection.vue";
import AssetInspector from "./inspector/AssetInspector.vue";
import ScriptFields from "./inspector/ScriptFields.vue";
import RigidBodyFields from "./inspector/RigidBodyFields.vue";
import ColliderFields from "./inspector/ColliderFields.vue";
import LightComponentFields from "./inspector/LightComponentFields.vue";
import AnimationClipFields from "./inspector/AnimationClipFields.vue";
import PhysicsSimSection from "./inspector/PhysicsSimSection.vue";
import MultiSection from "./inspector/MultiSection.vue";
import "../../styles/components/inspector-panel.scss";

// ---------------------------------------------------------------------------
// 属性面板（检查器）根组件：只保留面板壳层状态（资产模式/模型派生信息）、生命
// 周期与模板组合；节点上下文与各域编辑逻辑在 ../composables/inspector/ 下按域
// 拆分（useInspectorNode 为根，域之间单向依赖）。
// ---------------------------------------------------------------------------

// —— 节点上下文（node/revision 与节点级字段）——
const inspector = useInspectorNode();
const { node, revision, store, projectStore, assetsStore } = inspector;
const { state, engine } = store;
const {
  onNodeRename,
  onNodeToggleVisible,
  onNodeSetTag,
  onNodeSetLayer,
  onTransformChange,
  onMeshUpdate,
  onAnimUpdate,
  onAnimGraphUpdate,
} = inspector;

// —— 各域组合式函数（只依赖上面的 inspector 上下文）——
const {
  materialOpen,
  flushMaterialPersist,
  onSetMaterial,
  onMaterialEdit,
  onMaterialPropEdit,
  onMaterialChangeShader,
  onMaterialCopyToProject,
} = useInspectorMaterial(inspector);
const {
  mountedComponents,
  closedComps,
  multiIds,
  compCardTitle,
  compCardType,
  showSimStrip,
  onToggleCompCard,
  onToggleComponent,
  onComponentMenu,
  onAddComponentMenu,
  onScriptComponentProp,
  onScriptExecutionOrder,
  onAnimClipComponentUpdate,
  onMultiAddComponentMenu,
} = useInspectorComponents(inspector);
const { onRigidBodyUpdate, onColliderUpdate } = useInspectorPhysics(inspector);
const { onLightComponentUpdate, onAudioComponentUpdate, onLightUpdate, onAudioUpdate } =
  useInspectorLightAudio(inspector);
const {
  onCameraEdit,
  onCameraChangeType,
  onCameraClearFlags,
  onCameraClearColor,
  onCameraCullingMask,
  onSetSkyMaterial,
  onSkyMaterialCopyToProject,
} = useInspectorCameraSky(inspector);
const { onParticleUpdate } = useInspectorParticles(inspector);

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

// 面板卸载：把未落盘的材质修改（防抖窗口内的最后一次编辑）写入源文件
onBeforeUnmount(flushMaterialPersist);
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
        <NodeSection
          :node="node"
          :rev="revision"
          @rename="onNodeRename"
          @setTag="onNodeSetTag"
          @setLayer="onNodeSetLayer"
          @toggleVisible="onNodeToggleVisible"
        />
      </ComponentCard>

      <ComponentCard title="Transform" :open="true">
        <TransformSection :node="node" :rev="revision" @transform="onTransformChange" />
      </ComponentCard>

      <ComponentCard v-if="node instanceof MeshNode" title="Mesh" :open="true">
        <MeshSection :node="node" :rev="revision" @update="onMeshUpdate" />
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
          @editCullingMask="onCameraCullingMask"
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

      <ComponentCard v-if="node instanceof ParticleSystemNode" title="Particle System" :open="true">
        <ParticleSection :node="node" :rev="revision" @update="onParticleUpdate" />
      </ComponentCard>

      <!-- —— 已挂组件卡（按挂载序 = 卡片序；组件卡语义：启用勾选 + ⋮ 菜单） —— -->
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
            <AnimationClipFields
              v-else-if="isAnimationClipComponent(c)"
              :comp="c"
              :node-id="node?.id"
              @update="(label, value) => onAnimClipComponentUpdate(c.id, label, value)"
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

      <!-- 材质区：与组件层分离，置于面板底部（组件增删不影响此区）；卡片可折叠 -->
      <template v-if="node instanceof MeshNode && node.source === 'primitive'">
        <div class="inspector-divider">材质</div>
        <ComponentCard
          title="Material"
          :open="materialOpen"
          @toggle="materialOpen = !materialOpen"
        >
          <MaterialSection
            :node="node"
            :rev="revision"
            @setMaterial="onSetMaterial"
            @editParam="onMaterialEdit"
            @editProp="onMaterialPropEdit"
            @changeShader="onMaterialChangeShader"
            @copyToProject="onMaterialCopyToProject"
          />
        </ComponentCard>
      </template>
      <template v-else-if="node instanceof MeshNode && modelHasMaterials">
        <div class="inspector-divider">材质</div>
        <ComponentCard
          title="Material"
          :open="materialOpen"
          @toggle="materialOpen = !materialOpen"
        >
          <ModelMaterialSection :node="node" :rev="revision" />
        </ComponentCard>
      </template>
    </div>
  </div>
</template>
