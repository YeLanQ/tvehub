<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode } from "../../framework/prototype/derived/Primitives";
import type { JsonRecord } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/command/commands";
import ComponentCard from "./ComponentCard.vue";
import NodeSection from "./inspector/NodeSection.vue";
import TransformSection from "./inspector/TransformSection.vue";
import MeshSection from "./inspector/MeshSection.vue";
import LightSection from "./inspector/LightSection.vue";
import CameraSection from "./inspector/CameraSection.vue";
import ComponentsSection from "./inspector/ComponentsSection.vue";
import "../../styles/components/inspector-panel.scss";

const store = getEditorStore();
const { state, engine } = store;

const node = computed<Node | undefined>(() => store.nodeById(state.selectedId ?? undefined));
const revision = computed(() => store.revision());

function commit(mutate: (n: Node) => void, label: string): void {
  const n = node.value;
  if (!n) return;
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
  commit((node) => {
    const mesh = node as MeshNode;
    switch (label) {
      case "Set Geometry":
        mesh.geometry = value as MeshNode["geometry"];
        break;
      case "Set Color":
        mesh.color = value as number;
        break;
      case "Set Metalness":
        mesh.metalness = value as number;
        break;
      case "Set Roughness":
        mesh.roughness = value as number;
        break;
    }
  }, label);
}

function onLightUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof LightNode)) return;
  commit((node) => {
    const light = node as LightNode;
    switch (label) {
      case "Set Light Kind":
        light.lightKind = value as LightNode["lightKind"];
        break;
      case "Set Light Color":
        light.lightColor = value as number;
        break;
      case "Set Intensity":
        light.intensity = value as number;
        break;
      case "Toggle Shadow":
        light.castShadow = value as boolean;
        break;
    }
  }, label);
}

function onCameraUpdate(label: string, value: unknown): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode)) return;
  commit((node) => {
    const camera = node as CameraNode;
    switch (label) {
      case "Set Fov":
        camera.fov = value as number;
        break;
      case "Set Near":
        camera.near = value as number;
        break;
      case "Set Far":
        camera.far = value as number;
        break;
    }
  }, label);
}

function onAddComponent(type: string): void {
  if (type === "wireframe" && node.value instanceof MeshNode) {
    commit((m) => { (m as MeshNode).wireframe = true; }, "添加 Wireframe");
  }
}

function onRemoveComponent(type: string): void {
  if (type === "wireframe" && node.value) {
    commit((m) => { (m as MeshNode).wireframe = false; }, "移除 Wireframe");
  }
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

      <ComponentCard v-if="node instanceof LightNode" title="Light" :open="true">
        <LightSection :node="node" :rev="revision" @update="onLightUpdate" />
      </ComponentCard>

      <ComponentCard v-if="node instanceof CameraNode" title="Camera" :open="true">
        <CameraSection :node="node" :rev="revision" @update="onCameraUpdate" />
      </ComponentCard>

      <ComponentCard title="Components" :open="true">
        <ComponentsSection
          :node="node"
          :rev="revision"
          @addComponent="onAddComponent"
          @removeComponent="onRemoveComponent"
        />
      </ComponentCard>
    </div>
  </div>
</template>
