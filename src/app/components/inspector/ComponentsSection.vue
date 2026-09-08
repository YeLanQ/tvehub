<script setup lang="ts">
// Components 卡片：脚本组件区（可增删改，数据存 Node.components）+ 原生组件区
// （随节点类型自动派生的只读展示）。脚本属性控件按脚本 static props 声明渲染
// （scripts store 解析缓存，不执行用户代码）；组件的运行期实例化由播放器完成。
import { computed, ref, watch } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import {
  isScriptComponent,
  type ScriptComponentRef,
} from "../../../framework/prototype/Node";
import { MeshNode, LightNode, CameraNode, SkyboxNode } from "../../../framework/prototype/derived/Primitives";
import { getEditorStore } from "../../stores/editor";
import { getScriptsStore } from "../../stores/scripts";
import { getProjectStore } from "../../stores/project";

import type { ScriptPropDef } from "../../lib/script-compile";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: Node; rev?: number }>();

const emit = defineEmits<{

  removeComponent: [compId: string];
  toggleComponent: [compId: string, enabled: boolean];
  setProp: [compId: string, key: string, value: unknown];
}>();

const scriptsStore = getScriptsStore();
const projectStore = getProjectStore();

/** 本节点脚本组件列表（物理组件在 Physics 卡片编辑；rev 为失效信号） */
const components = computed<ScriptComponentRef[]>(() => {
  void props.rev;
  return props.node.components.filter(isScriptComponent);
});

/** 物理组件概览（原生组件区只读展示） */
const physicsCount = computed(() => {
  void props.rev;
  const rb = props.node.components.filter((c) => c.type === "rigidBody").length;
  const col = props.node.components.filter((c) => c.type === "collider").length;
  return { rb, col };
});

/** 项目脚本清单（缺失判定 + 添加菜单） */
const scriptList = computed<string[]>(() => {
  void projectStore.currentPath;
  return scriptsStore.listScripts();
});

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.ts$/, "");
}

function scriptExists(rel: string): boolean {
  return scriptList.value.includes(rel);
}

/** 节点引用（entity）可选场景节点：按 def.filter 白名单过滤（空 = 全部） */
function nodeRefOptions(def: ScriptPropDef): { id: string; name: string }[] {
  const engine = getEditorStore().engine;
  const allow = def.filter && def.filter.length ? def.filter : null;
  return engine.graph
    .all()
    .filter((n) => (allow ? allow.includes(n.typeKey) : true))
    .map((n) => ({ id: n.id, name: n.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 属性 schema 缓存：script → ScriptPropDef[] | null（null = 已解析但无声明）。
 * 键缺失 = 未加载；用 inFlight 集合跟踪正在异步解析的脚本，避免重复请求。
 */
const schemas = ref<Record<string, ScriptPropDef[] | null>>({});
const schemasRev = ref(0);
const inFlight = new Set<string>();

/** 异步解析单个脚本的 props 声明（结果回填缓存并触发渲染） */
function loadSchema(rel: string): void {
  if (inFlight.has(rel)) return;
  inFlight.add(rel);
  void scriptsStore.propsSchemaFor(rel).then((defs) => {
    inFlight.delete(rel);
    if (schemas.value[rel] === defs) return;
    schemas.value = { ...schemas.value, [rel]: defs };
    schemasRev.value += 1;
  });
}

/** 为组件脚本补齐待加载的 schema 键，并触发未解析脚本的异步拉取 */
function refreshSchemas(list: ScriptComponentRef[]): void {
  let changed = false;
  for (const c of list) {
    if (Object.prototype.hasOwnProperty.call(schemas.value, c.script)) continue;
    schemas.value = { ...schemas.value, [c.script]: null };
    changed = true;
  }
  if (changed) schemasRev.value += 1;
  for (const c of list) loadSchema(c.script);
}

watch(components, (list) => refreshSchemas(list), { immediate: true });

// 脚本保存（schemaRev 递增）后，属性声明可能变化 → 清空并重新解析所有组件脚本
watch(
  () => scriptsStore.schemaRev,
  () => {
    let changed = false;
    for (const c of components.value) {
      if (!Object.prototype.hasOwnProperty.call(schemas.value, c.script)) continue;
      schemas.value = { ...schemas.value, [c.script]: null };
      changed = true;
    }
    if (!changed) return;
    // 强制重拉（inFlight 里的旧请求可能已出队，这里重新入队一次）
    inFlight.clear();
    refreshSchemas(components.value);
  },
);

function schemaOf(rel: string): ScriptPropDef[] | null {
  void schemasRev.value;
  return schemas.value[rel] ?? null;
}

/** 属性显示值：节点配置值优先，缺省取声明 default */
function propValue(c: ScriptComponentRef, key: string, def: ScriptPropDef): unknown {
  const stored = c.props[key];
  if (stored !== undefined) return stored;
  return def.default;
}

function onPropEdit(c: ScriptComponentRef, def: ScriptPropDef, raw: unknown): void {
  let value: unknown = raw;
  if (def.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    let v = Number.isFinite(n) ? n : (def.default as number);
    if (typeof def.min === "number") v = Math.max(def.min, v);
    if (typeof def.max === "number") v = Math.min(def.max, v);
    value = v;
  } else if (def.type === "boolean") {
    value = raw === true;
  } else if (def.type === "color" || def.type === "string") {
    value = typeof raw === "string" ? raw : String(raw ?? "");
  }
  emit("setProp", c.id, def.key, value);
}

/** vec3 单轴提交：合并当前值改一轴 */
function onVec3Axis(c: ScriptComponentRef, def: ScriptPropDef, axis: "x" | "y" | "z", raw: number): void {
  const cur = propValue(c, def.key, def) as { x: number; y: number; z: number };
  const next = {
    x: typeof cur?.x === "number" ? cur.x : 0,
    y: typeof cur?.y === "number" ? cur.y : 0,
    z: typeof cur?.z === "number" ? cur.z : 0,
    [axis]: Number.isFinite(raw) ? raw : 0,
  };
  emit("setProp", c.id, def.key, next);
}

function vecAxis(v: unknown, axis: "x" | "y" | "z"): number {
  const o = v as { x?: number; y?: number; z?: number } | undefined;
  const n = o?.[axis];
  return typeof n === "number" ? n : 0;
}


/** 模型解析信息（蒙皮/剪辑；随 model:changed 的 rev 刷新） */
const modelMeta = computed(() => {
  void props.rev;
  const engine = getEditorStore().engine;
  const n = props.node;
  return n instanceof MeshNode && n.source === "model" && n.model
    ? engine.models.metaFor(n.model)
    : null;
});
</script>

<template>
  <!-- —— 脚本组件（可增删改；运行期由播放器实例化） —— -->
  <div class="comp-scripts" :data-rev="rev">
    <div v-if="components.length === 0" class="hint add-comp-empty">
      未挂载脚本组件
    </div>
    <div v-for="c in components" :key="c.id" class="script-comp" :class="{ off: !c.enabled }">      <div class="script-comp-head">
        <label class="comp-toggle" title="启用/停用" @click.stop>
          <input
            type="checkbox"
            :checked="c.enabled"
            @change="emit('toggleComponent', c.id, ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <span class="script-comp-name mono" :title="c.script">{{ baseName(c.script) }}</span>
        <span v-if="!scriptExists(c.script)" class="script-missing">脚本缺失</span>
        <button class="comp-remove" title="移除组件" @click="emit('removeComponent', c.id)">×</button>
      </div>

      <!-- 属性控件：按脚本 static props 声明渲染 -->
      <template v-if="c.enabled">
        <div
          v-for="def in schemaOf(c.script) ?? []"
          :key="def.key"
          class="field script-prop"
        >
          <label :title="def.key">{{ def.label ?? def.key }}</label>

          <NumberField
            v-if="def.type === 'number'"
            :model-value="propValue(c, def.key, def) as number"
            :step="def.step ?? 0.1"
            :title="def.key"
            @commit="(v) => onPropEdit(c, def, v)"
          />

          <input
            v-else-if="def.type === 'string'"
            class="prop-string mono"
            type="text"
            :value="String(propValue(c, def.key, def) ?? '')"
            @change="emit('setProp', c.id, def.key, ($event.target as HTMLInputElement).value)"
          />

          <input
            v-else-if="def.type === 'boolean'"
            type="checkbox"
            :checked="propValue(c, def.key, def) === true"
            @change="emit('setProp', c.id, def.key, ($event.target as HTMLInputElement).checked)"
          />

          <input
            v-else-if="def.type === 'color'"
            type="color"
            :value="String(propValue(c, def.key, def) ?? '#ffffff')"
            @change="emit('setProp', c.id, def.key, ($event.target as HTMLInputElement).value)"
          />

          <!-- 场景节点引用：从场景中按类型选择目标节点（value = 节点 id） -->
          <select
            v-else-if="def.type === 'entity'"
            class="prop-string mono"
            :value="String(propValue(c, def.key, def) ?? '')"
            :title="def.filter?.length ? `可选节点类型：${def.filter.join('/')}` : '任意场景节点'"
            @change="emit('setProp', c.id, def.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">（未选择）</option>
            <option v-for="n in nodeRefOptions(def)" :key="n.id" :value="n.id">{{ n.name }}</option>
          </select>

          <div v-else-if="def.type === 'vec3'" class="prop-vec3">
            <NumberField
              :model-value="vecAxis(propValue(c, def.key, def), 'x')"
              :step="def.step ?? 0.1"
              title="X"
              @commit="(v) => onVec3Axis(c, def, 'x', v)"
            />
            <NumberField
              :model-value="vecAxis(propValue(c, def.key, def), 'y')"
              :step="def.step ?? 0.1"
              title="Y"
              @commit="(v) => onVec3Axis(c, def, 'y', v)"
            />
            <NumberField
              :model-value="vecAxis(propValue(c, def.key, def), 'z')"
              :step="def.step ?? 0.1"
              title="Z"
              @commit="(v) => onVec3Axis(c, def, 'z', v)"
            />
          </div>
        </div>
        <div v-if="schemaOf(c.script) !== null && (schemaOf(c.script) ?? []).length === 0" class="hint">
          该脚本未声明属性（static props）
        </div>
        <div v-if="schemaOf(c.script) === null && scriptExists(c.script)" class="hint">
          未解析到属性声明
        </div>
      </template>
    </div>

  </div>

  <!-- —— 原生组件（随节点类型自动创建，只读展示） —— -->
  <div class="comp-list">
    <div v-if="node instanceof MeshNode" class="comp-row">
      <span class="comp-label">{{
        node.source === "model" ? "Model Renderer" : "Mesh Renderer"
      }}</span>
      <span class="comp-type mono">{{
        node.source === "model" ? "Model" : "Mesh"
      }}</span>
    </div>
    <div v-if="node instanceof MeshNode && node.source === 'primitive'" class="comp-row">
      <span class="comp-label">Material</span>
      <span class="comp-type mono">Mat</span>
    </div>
    <div v-else-if="modelMeta && modelMeta.materials.length > 0" class="comp-row">
      <span class="comp-label">Material</span>
      <span class="comp-type mono">内嵌 × {{ modelMeta.materials.length }}</span>
    </div>
    <div v-if="modelMeta?.hasSkeleton" class="comp-row">
      <span class="comp-label">Skinned Mesh</span>
      <span class="comp-type mono">骨骼</span>
    </div>
    <div v-if="modelMeta && modelMeta.clips.length > 0" class="comp-row">
      <span class="comp-label">Animation</span>
      <span class="comp-type mono">{{
        node instanceof MeshNode && node.animGraph ? `图 · ${node.animGraph.states.length} 态` : `${modelMeta.clips.length} 剪辑`
      }}</span>
    </div>
    <div v-if="node instanceof LightNode" class="comp-row">
      <span class="comp-label">Light</span>
      <span class="comp-type mono">Light</span>
    </div>
    <div v-if="node instanceof CameraNode" class="comp-row">
      <span class="comp-label">Camera</span>
      <span class="comp-type mono">{{ node.cameraType === "orthographic" ? "Ortho" : "Persp" }}</span>
    </div>
    <div v-if="node instanceof SkyboxNode" class="comp-row">
      <span class="comp-label">Skybox</span>
      <span class="comp-type mono">Sky</span>
    </div>
    <div v-if="physicsCount.rb > 0" class="comp-row">
      <span class="comp-label">Rigid Body</span>
      <span class="comp-type mono">刚体</span>
    </div>
    <div v-if="physicsCount.col > 0" class="comp-row">
      <span class="comp-label">Collider</span>
      <span class="comp-type mono">× {{ physicsCount.col }}</span>
    </div>
  </div>
</template>
