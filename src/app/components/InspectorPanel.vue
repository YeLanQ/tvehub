<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode } from "../../framework/prototype/derived/Primitives";
import type { JsonRecord } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/command/commands";
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

function onMeshUpdate(label: string): void {
  const n = node.value;
  if (!n || !(n instanceof MeshNode)) return;
  commit((_n) => {
    // 实际更新在模板中处理
  }, label);
}

function onLightUpdate(label: string): void {
  const n = node.value;
  if (!n || !(n instanceof LightNode)) return;
  commit(() => {}, label);
}

function onCameraUpdate(label: string): void {
  const n = node.value;
  if (!n || !(n instanceof CameraNode)) return;
  commit(() => {}, label);
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

    <div v-else class="body mono">
      <NodeSection
        :node="node"
        @rename="onNodeRename"
        @toggleActive="onNodeToggleActive"
        @toggleVisible="onNodeToggleVisible"
      />

      <TransformSection :node="node" @transform="onTransformChange" />

      <MeshSection v-if="node instanceof MeshNode" :node="node" @update="onMeshUpdate" />

      <LightSection v-if="node instanceof LightNode" :node="node" @update="onLightUpdate" />

      <CameraSection v-if="node instanceof CameraNode" :node="node" @update="onCameraUpdate" />

      <ComponentsSection
        :node="node"
        @addComponent="onAddComponent"
        @removeComponent="onRemoveComponent"
      />
    </div>
  </div>
</template>
