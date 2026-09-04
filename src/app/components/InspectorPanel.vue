<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode } from "../../framework/prototype/derived/Primitives";
import type { JsonRecord } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/command/commands";

const store = getEditorStore();
const { state, engine } = store;

const node = computed<Node | undefined>(() => store.nodeById(state.selectedId ?? undefined));

function num(v: number, digits = 3): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function commit(mutate: (n: Node) => void, label: string): void {
  const n = node.value;
  if (!n) return;
  const before = n.toJSON() as JsonRecord;
  mutate(n);
  const after = n.toJSON() as JsonRecord;
  engine.patchNode(n.id, before, after, label);
}

// 局部草稿同步 selectedId 变化
const localName = ref("");
watch(
  () => node.value?.id,
  () => {
    localName.value = node.value?.name ?? "";
  },
  { immediate: true },
);

function commitName(): void {
  if (node.value && localName.value !== node.value.name) {
    engine.renameSelected(localName.value);
  }
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

function hexToNum(hex: string): number {
  const clean = hex.replace("#", "");
  const v = parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  return Number.isNaN(v) ? 0 : v;
}

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function isMesh(n: Node | undefined): n is MeshNode {
  return n instanceof MeshNode;
}

function isLight(n: Node | undefined): n is LightNode {
  return n instanceof LightNode;
}

function isCamera(n: Node | undefined): n is CameraNode {
  return n instanceof CameraNode;
}
</script>

<template>
  <div class="panel inspector">
    <div class="panel__title">检查器 / Inspector</div>

    <div v-if="!node" class="empty muted">未选择节点</div>

    <div v-else class="body mono">
      <div class="section">
        <div class="field-row">
          <label>Name</label>
          <input v-model="localName" type="text" @change="commitName" />
        </div>
        <div class="field-row">
          <span class="type-tag">{{ node.typeKey }}</span>
          <span class="muted">{{ node.id }}</span>
        </div>
        <div class="field-row">
          <label>Active</label>
          <input
            type="checkbox"
            :checked="node.active"
            @change="commit((n) => { n.active = ($event.target as HTMLInputElement).checked; }, 'Toggle Active')"
          />
          <label class="inline">Visible</label>
          <input
            type="checkbox"
            :checked="node.visible"
            @change="commit((n) => { n.visible = ($event.target as HTMLInputElement).checked; }, 'Toggle Visible')"
          />
        </div>
      </div>

      <div class="section">
        <div class="section__title">Transform</div>
        <div v-for="axis in (['position', 'rotation', 'scale'] as const)" :key="axis" class="vec3">
          <span class="v-label">{{ axis }}</span>
          <input
            v-for="p in (['x', 'y', 'z'] as const)"
            :key="p"
            type="number"
            step="0.1"
            :value="num(node.transform[axis][p])"
            @change="setTransformAxis(axis, p, parseFloat(($event.target as HTMLInputElement).value) || 0)"
          />
        </div>
      </div>

      <div v-if="isMesh(node)" class="section">
        <div class="section__title">Mesh</div>
        <div class="field-row">
          <label>Geometry</label>
          <select
            :value="node.geometry"
            @change="commit((n) => ((n as MeshNode).geometry = ($event.target as HTMLSelectElement).value as MeshNode['geometry']), 'Set Geometry')"
          >
            <option value="box">Box</option>
            <option value="sphere">Sphere</option>
            <option value="cylinder">Cylinder</option>
            <option value="plane">Plane</option>
          </select>
        </div>
        <div class="field-row">
          <label>Color</label>
          <input
            type="text"
            :value="numToHex(node.color)"
            @change="commit((n) => ((n as MeshNode).color = hexToNum(($event.target as HTMLInputElement).value)), 'Set Color')"
          />
          <input type="color" :value="numToHex(node.color)" @change="commit((n) => ((n as MeshNode).color = hexToNum(($event.target as HTMLInputElement).value)), 'Set Color')" />
        </div>
        <div class="field-row">
          <label>Metalness</label>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            :value="node.metalness"
            @change="commit((n) => ((n as MeshNode).metalness = parseFloat(($event.target as HTMLInputElement).value) || 0), 'Set Metalness')"
          />
        </div>
        <div class="field-row">
          <label>Roughness</label>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            :value="node.roughness"
            @change="commit((n) => ((n as MeshNode).roughness = parseFloat(($event.target as HTMLInputElement).value) || 0), 'Set Roughness')"
          />
        </div>
        <div class="field-row">
          <label>Wireframe</label>
          <input
            type="checkbox"
            :checked="node.wireframe"
            @change="commit((n) => ((n as MeshNode).wireframe = ($event.target as HTMLInputElement).checked), 'Toggle Wireframe')"
          />
        </div>
      </div>

      <div v-if="isLight(node)" class="section">
        <div class="section__title">Light</div>
        <div class="field-row">
          <label>Kind</label>
          <select
            :value="node.lightKind"
            @change="commit((n) => ((n as LightNode).lightKind = ($event.target as HTMLSelectElement).value as LightNode['lightKind']), 'Set Light Kind')"
          >
            <option value="point">Point</option>
            <option value="directional">Directional</option>
            <option value="ambient">Ambient</option>
          </select>
        </div>
        <div class="field-row">
          <label>Intensity</label>
          <input
            type="number"
            step="0.1"
            min="0"
            :value="node.intensity"
            @change="commit((n) => ((n as LightNode).intensity = parseFloat(($event.target as HTMLInputElement).value) || 0), 'Set Intensity')"
          />
        </div>
        <div class="field-row">
          <label>Color</label>
          <input
            type="text"
            :value="numToHex(node.lightColor)"
            @change="commit((n) => ((n as LightNode).lightColor = hexToNum(($event.target as HTMLInputElement).value)), 'Set Light Color')"
          />
        </div>
        <div class="field-row">
          <label>Shadow</label>
          <input
            type="checkbox"
            :checked="node.castShadow"
            @change="commit((n) => ((n as LightNode).castShadow = ($event.target as HTMLInputElement).checked), 'Toggle Shadow')"
          />
        </div>
      </div>

      <div v-if="isCamera(node)" class="section">
        <div class="section__title">Camera</div>
        <div class="field-row">
          <label>Fov</label>
          <input
            type="number"
            step="1"
            :value="node.fov"
            @change="commit((n) => ((n as CameraNode).fov = parseFloat(($event.target as HTMLInputElement).value) || 50), 'Set Fov')"
          />
        </div>
        <div class="field-row">
          <label>Near</label>
          <input
            type="number"
            step="0.1"
            :value="node.near"
            @change="commit((n) => ((n as CameraNode).near = parseFloat(($event.target as HTMLInputElement).value) || 0.1), 'Set Near')"
          />
        </div>
        <div class="field-row">
          <label>Far</label>
          <input
            type="number"
            :value="node.far"
            @change="commit((n) => ((n as CameraNode).far = parseFloat(($event.target as HTMLInputElement).value) || 2000), 'Set Far')"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  min-width: 260px;
}

.body {
  overflow: auto;
  flex: 1;
}

.section {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.section__title {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--muted);
  padding: 2px 10px 6px;
}

.type-tag {
  background: var(--panel-2);
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.vec3 {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
}

.v-label {
  width: 68px;
  color: var(--muted);
  font-size: 11px;
}

.vec3 input {
  width: 60px;
  flex: 1;
}

.inline {
  width: auto;
  margin-left: 12px;
}

.field-row input {
  max-width: 160px;
}

.empty {
  padding: 10px;
  font-size: 12px;
}
</style>