<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import { CameraNode, LightNode, MeshNode } from "../../framework/prototype/derived/Primitives";
import type { JsonRecord } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/command/commands";
import "../../styles/components/inspector-panel.scss";

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

