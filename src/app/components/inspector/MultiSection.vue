<script setup lang="ts">
/**
 * 多选批量编辑区（选中 ≥2 个节点时检查器切换到本组件）：
 * - 公共字段批改：标签 / 激活 / 可见 / 变换（混合值以「混合」徽标提示，
 *   编辑即把该字段绝对值应用到全部选中节点）；
 * - 批量添加组件（emit 给 InspectorPanel 弹注册表菜单）；
 * - 全部变更走 engine.patchNodes（整节点快照批量补丁，一次撤销）。
 */
import { computed } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import type { JsonRecord } from "../../../framework/prototype/types";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";

const props = defineProps<{ ids: string[]; rev?: number }>();

const emit = defineEmits<{
  addComponentMenu: [e: MouseEvent];
}>();

const editorStore = getEditorStore();
const engine = editorStore.engine;

/** 选中节点列表（rev 为失效信号） */
const nodes = computed<Node[]>(() => {
  void props.rev;
  return props.ids
    .map((id) => engine.graph.get(id))
    .filter((n): n is Node => !!n);
});

const names = computed(() => nodes.value.map((n) => n.name));

/** 全部节点该字段一致时返回值，否则 null（混合） */
function uniformOf(read: (n: Node) => number, eps = 1e-4): number | null {
  const nodes0 = nodes.value;
  if (!nodes0.length) return null;
  const v0 = read(nodes0[0]);
  for (const n of nodes0) {
    if (Math.abs(read(n) - v0) > eps) return null;
  }
  return v0;
}

/** 批量提交：对每个节点做 before/after 快照 → 一次 patchNodes（一次撤销） */
function applyToAll(mutate: (n: Node) => void, label: string): void {
  const items = nodes.value.map((n) => {
    const before = n.toJSON() as JsonRecord;
    mutate(n);
    const after = n.toJSON() as JsonRecord;
    return { id: n.id, before, after };
  });
  if (items.length) engine.patchNodes(items, label);
}

// —— 变换（混合值显示 0 + 徽标；编辑 = 绝对值应用到全部） ——

const isMixed = (read: (n: Node) => number): boolean => uniformOf(read) === null;

function posUniform(axis: "x" | "y" | "z"): number | null {
  return uniformOf((n) => n.transform.position[axis]);
}
function rotUniform(axis: "x" | "y" | "z"): number | null {
  return uniformOf((n) => n.transform.rotation[axis]);
}
function sclUniform(axis: "x" | "y" | "z"): number | null {
  return uniformOf((n) => n.transform.scale[axis]);
}

function setPos(axis: "x" | "y" | "z", v: number): void {
  applyToAll((n) => {
    n.transform.position[axis] = v;
  }, "批量设置位置");
}
function setRot(axis: "x" | "y" | "z", v: number): void {
  applyToAll((n) => {
    n.transform.rotation[axis] = v;
  }, "批量设置旋转");
}
function setScale(axis: "x" | "y" | "z", v: number): void {
  applyToAll((n) => {
    n.transform.scale[axis] = Math.max(0.001, v);
  }, "批量设置缩放");
}

// —— 标签 / 激活 / 可见 ——

const tagUniform = computed<string | null>(() => {
  void props.rev;
  const nodes0 = nodes.value;
  if (!nodes0.length) return null;
  const t0 = nodes0[0].tag;
  return nodes0.every((n) => n.tag === t0) ? t0 : null;
});
const localTag = computed({
  get: () => tagUniform.value ?? "",
  set: () => {},
});
function commitTag(): void {
  const v = localTag.value.trim();
  applyToAll((n) => {
    n.tag = v;
  }, "批量设置标签");
}

const activeUniform = computed<boolean | null>(() => {
  void props.rev;
  const nodes0 = nodes.value;
  if (!nodes0.length) return null;
  const v0 = nodes0[0].active;
  return nodes0.every((n) => n.active === v0) ? v0 : null;
});
const visibleUniform = computed<boolean | null>(() => {
  void props.rev;
  const nodes0 = nodes.value;
  if (!nodes0.length) return null;
  const v0 = nodes0[0].visible;
  return nodes0.every((n) => n.visible === v0) ? v0 : null;
});</script>

<template>
  <div class="multi-section" :data-rev="rev">
    <div class="hint">
      已选中 {{ nodes.length }} 个节点：{{ names.slice(0, 6).join("、")
      }}{{ names.length > 6 ? ` 等 ${names.length} 个` : "" }}
    </div>

    <div class="field">
      <label title="批量设置标签（GameObject Tag 语义）">标签</label>
      <input
        v-model="localTag"
        type="text"
        :placeholder="tagUniform === null ? '（混合）' : '（无）'"
        :title="tagUniform === null ? '各节点标签不同，输入将统一应用到全部' : '标签'"
        @change="commitTag"
      />
    </div>

    <div class="field">
      <label>激活</label>
      <input
        type="checkbox"
        :checked="activeUniform === true"
        :indeterminate="activeUniform === null"
        title="批量激活/失活（勾选状态不一致时显示混合态）"
        @change="applyToAll((n) => { n.active = ($event.target as HTMLInputElement).checked; }, ($event.target as HTMLInputElement).checked ? '批量激活' : '批量失活')"
      />
      <label style="width: auto">可见</label>
      <input
        type="checkbox"
        :checked="visibleUniform === true"
        :indeterminate="visibleUniform === null"
        title="批量显示/隐藏"
        @change="applyToAll((n) => { n.visible = ($event.target as HTMLInputElement).checked; }, ($event.target as HTMLInputElement).checked ? '批量显示' : '批量隐藏')"
      />
    </div>

    <!-- 变换：三轴批量设置（混合值 = 0 + 混合徽标；编辑即绝对值应用到全部） -->
    <div class="field">
      <label>位置</label>
      <div class="multi-vec">
        <NumberField
          :model-value="posUniform('x') ?? 0"
          :step="0.1"
          title="X（应用到全部选中节点）"
          @commit="(v) => setPos('x', v)"
        />
        <NumberField
          :model-value="posUniform('y') ?? 0"
          :step="0.1"
          title="Y"
          @commit="(v) => setPos('y', v)"
        />
        <NumberField
          :model-value="posUniform('z') ?? 0"
          :step="0.1"
          title="Z"
          @commit="(v) => setPos('z', v)"
        />
      </div>
      <span
        v-if="(['x', 'y', 'z'] as const).some((a) => isMixed((n) => n.transform.position[a]))"
        class="mixed-badge"
        title="各节点该字段值不同"
      >混合</span>
    </div>
    <div class="field">
      <label>旋转</label>
      <div class="multi-vec">
        <NumberField
          :model-value="rotUniform('x') ?? 0"
          :step="1"
          title="X（度）"
          @commit="(v) => setRot('x', v)"
        />
        <NumberField
          :model-value="rotUniform('y') ?? 0"
          :step="1"
          title="Y（度）"
          @commit="(v) => setRot('y', v)"
        />
        <NumberField
          :model-value="rotUniform('z') ?? 0"
          :step="1"
          title="Z（度）"
          @commit="(v) => setRot('z', v)"
        />
      </div>
      <span
        v-if="(['x', 'y', 'z'] as const).some((a) => isMixed((n) => n.transform.rotation[a]))"
        class="mixed-badge"
        title="各节点该字段值不同"
      >混合</span>
    </div>
    <div class="field">
      <label>缩放</label>
      <div class="multi-vec">
        <NumberField
          :model-value="sclUniform('x') ?? 1"
          :step="0.1"
          :min="0.001"
          title="X"
          @commit="(v) => setScale('x', v)"
        />
        <NumberField
          :model-value="sclUniform('y') ?? 1"
          :step="0.1"
          :min="0.001"
          title="Y"
          @commit="(v) => setScale('y', v)"
        />
        <NumberField
          :model-value="sclUniform('z') ?? 1"
          :step="0.1"
          :min="0.001"
          title="Z"
          @commit="(v) => setScale('z', v)"
        />
      </div>
      <span
        v-if="(['x', 'y', 'z'] as const).some((a) => isMixed((n) => n.transform.scale[a]))"
        class="mixed-badge"
        title="各节点该字段值不同"
      >混合</span>
    </div>

    <div class="hint">编辑任一字段会把该值应用到全部选中节点（一次撤销）。</div>
  </div>

  <button class="add-comp-btn" @click="emit('addComponentMenu', $event)">
    ＋ 批量添加组件
  </button>
</template>

<style scoped>
.multi-vec {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.mixed-badge {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--warn, #d7b45a);
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 4px;
  line-height: 1.5;
}
</style>
