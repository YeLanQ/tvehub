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

// 组件管理
const compAddOpen = ref(false);

function addComponent(type: string): void {
  if (type === "wireframe" && isMesh(node.value)) {
    commit((m) => ((m as MeshNode).wireframe = true), "添加 Wireframe");
  }
  compAddOpen.value = false;
}

function removeComponent(type: string): void {
  const n = node.value;
  if (!n) return;
  if (type === "wireframe" && isMesh(n)) {
    commit((m) => ((m as MeshNode).wireframe = false), "移除 Wireframe");
  }
}

function hasComponent(type: string): boolean {
  const n = node.value;
  if (!n) return false;
  if (type === "wireframe" && isMesh(n)) return n.wireframe;
  return false;
}
</script>

<template>
  <div class="panel inspector">
    <div v-if="!node" class="empty muted">未选择节点</div>

    <div v-else class="body mono">
      <!-- 节点标识 -->
      <div class="section">
        <div class="section__title">Node</div>
        <div class="field-row">
          <label>Name</label>
          <input v-model="localName" type="text" @change="commitName" />
        </div>
        <div class="field-row">
          <span class="type-tag">{{ node.typeKey }}</span>
          <span class="muted mono">{{ node.id }}</span>
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

      <!-- 变换 -->
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

      <!-- 网格属性 -->
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
      </div>

      <!-- 灯光属性 -->
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

      <!-- 相机属性 -->
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

      <!-- 组件列表 -->
      <div class="section">
        <div class="section__title">Components</div>
        <div class="comp-list">
          <div v-if="isMesh(node)" class="comp-row">
            <span class="comp-label">Mesh Renderer</span>
            <span class="comp-type mono">Mesh</span>
          </div>
          <div v-if="hasComponent('wireframe')" class="comp-row">
            <span class="comp-label">Wireframe</span>
            <span class="comp-type mono">Render</span>
            <button class="comp-remove" title="移除组件" @click="removeComponent('wireframe')">✕</button>
          </div>
          <div v-if="isLight(node)" class="comp-row">
            <span class="comp-label">Light</span>
            <span class="comp-type mono">Light</span>
          </div>
          <div v-if="isCamera(node)" class="comp-row">
            <span class="comp-label">Camera</span>
            <span class="comp-type mono">Camera</span>
          </div>
        </div>
        <button class="add-comp-btn" @click.stop="compAddOpen = !compAddOpen">＋ 添加组件</button>
        <div v-if="compAddOpen" class="add-comp-menu">
          <div v-if="isMesh(node)" class="add-comp-item" @click="addComponent('wireframe')">
            <span>Wireframe</span>
            <span class="mono comp-type">Render</span>
          </div>
          <div v-if="isMesh(node)" class="hint add-comp-empty">仅网格节点可添加组件</div>
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
  padding: 8px 0;
}

.section {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.section__title {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-dim);
  padding: 0 0 6px;
  letter-spacing: 0.5px;
}

.type-tag {
  background: var(--bg-panel-2);
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.muted {
  color: var(--text-dim);
  font-size: 11px;
  margin-left: 6px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.field-row label {
  font-size: 11px;
  color: var(--text-dim);
  width: 56px;
  flex-shrink: 0;
}

.field-row input[type="text"],
.field-row input[type="number"],
.field-row select {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
}

.field-row input[type="text"]:focus,
.field-row input[type="number"]:focus,
.field-row select:focus {
  border-color: var(--accent);
}

.field-row input[type="color"] {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-input);
  cursor: pointer;
}

.field-row input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
}

.inline {
  width: auto;
  margin-left: 12px;
}

.vec3 {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}

.v-label {
  width: 68px;
  color: var(--text-dim);
  font-size: 11px;
  flex-shrink: 0;
}

.vec3 input {
  width: 60px;
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
}

.vec3 input:focus {
  border-color: var(--accent);
}

.comp-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
}

.comp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  background: var(--bg-panel-2);
  border-radius: 3px;
  font-size: 12px;
}

.comp-label {
  flex: 1;
  color: var(--text);
}

.comp-type {
  color: var(--text-dim);
  font-size: 10px;
}

.comp-remove {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
}

.comp-remove:hover {
  color: var(--err);
  border-color: var(--err);
}

.add-comp-btn {
  width: 100%;
  height: 24px;
  margin-top: 6px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-dim);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 3px;
  cursor: pointer;
  text-align: center;
}

.add-comp-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.add-comp-menu {
  margin-top: 4px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.add-comp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  text-align: left;
}

.add-comp-item:hover {
  background: var(--bg-active);
  color: #fff;
}

.add-comp-item .comp-type {
  margin-left: auto;
}

.hint {
  font-size: 11px;
  color: var(--text-dim);
  padding: 4px 0;
}

.empty {
  padding: 10px;
  font-size: 12px;
  text-align: center;
}
</style>
