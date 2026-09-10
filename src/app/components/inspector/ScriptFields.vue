<script setup lang="ts">
// 脚本组件字段区（组件卡片主体）：脚本属性按脚本 static props / @property 声明
// 渲染编辑（scripts store 解析缓存，不执行用户代码）+ 执行顺序（播放器按其升序
// 稳定排序驱动 onUpdate）。组件的启用开关与增删在卡片头（InspectorPanel）。
import { computed, ref, watch } from "vue";
import type { ScriptComponentRef } from "../../../framework/prototype/Node";
import { getEditorStore } from "../../stores/editor";
import { getScriptsStore } from "../../stores/scripts";
import { getProjectStore } from "../../stores/project";
import type { ScriptPropDef } from "../../lib/script-compile";
import NumberField from "../NumberField.vue";

const props = defineProps<{ comp: ScriptComponentRef; rev?: number }>();

const emit = defineEmits<{
  setProp: [key: string, value: unknown];
  setExecutionOrder: [value: number];
}>();

const scriptsStore = getScriptsStore();
const projectStore = getProjectStore();

/** 项目脚本清单（缺失判定） */
const scriptList = computed<string[]>(() => {
  void projectStore.currentPath;
  return scriptsStore.listScripts();
});

function scriptExists(rel: string): boolean {
  return scriptList.value.includes(rel);
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

watch(
  () => props.comp.script,
  (rel) => {
    if (!Object.prototype.hasOwnProperty.call(schemas.value, rel)) {
      schemas.value = { ...schemas.value, [rel]: null };
      schemasRev.value += 1;
    }
    loadSchema(rel);
  },
  { immediate: true },
);

// 脚本保存（schemaRev 递增）后，属性声明可能变化 → 清空并重新解析
watch(
  () => scriptsStore.schemaRev,
  () => {
    const rel = props.comp.script;
    if (!Object.prototype.hasOwnProperty.call(schemas.value, rel)) return;
    schemas.value = { ...schemas.value, [rel]: null };
    schemasRev.value += 1;
    inFlight.delete(rel);
    loadSchema(rel);
  },
);

function schemaOf(rel: string): ScriptPropDef[] | null {
  void schemasRev.value;
  return schemas.value[rel] ?? null;
}

/** 属性显示值：节点配置值优先，缺省取声明 default */
function propValue(key: string, def: ScriptPropDef): unknown {
  const stored = props.comp.props[key];
  if (stored !== undefined) return stored;
  return def.default;
}

function onPropEdit(def: ScriptPropDef, raw: unknown): void {
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
  emit("setProp", def.key, value);
}

/** vec3 单轴提交：合并当前值改一轴 */
function onVec3Axis(def: ScriptPropDef, axis: "x" | "y" | "z", raw: number): void {
  const cur = propValue(def.key, def) as { x: number; y: number; z: number };
  const next = {
    x: typeof cur?.x === "number" ? cur.x : 0,
    y: typeof cur?.y === "number" ? cur.y : 0,
    z: typeof cur?.z === "number" ? cur.z : 0,
    [axis]: Number.isFinite(raw) ? raw : 0,
  };
  emit("setProp", def.key, next);
}

function vecAxis(v: unknown, axis: "x" | "y" | "z"): number {
  const o = v as { x?: number; y?: number; z?: number } | undefined;
  const n = o?.[axis];
  return typeof n === "number" ? n : 0;
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

function onExecutionOrder(v: number): void {
  emit("setExecutionOrder", Number.isFinite(v) ? Math.round(v) : 0);
}
</script>

<template>
  <div class="script-fields" :data-rev="rev">
    <div v-if="!scriptExists(comp.script)" class="hint">
      <span class="script-missing">脚本缺失</span>
      <span class="mono comp-script-path">{{ comp.script }}</span>
    </div>
    <div v-else class="hint mono comp-script-path">{{ comp.script }}</div>

    <!-- 执行顺序：小者先跑（同序按挂载顺序） -->
    <div class="field">
      <label title="执行顺序（小者先跑，同序按挂载顺序）">执行顺序</label>
      <NumberField
        :model-value="comp.executionOrder"
        :step="1"
        :title="`执行顺序（当前 ${comp.executionOrder}）`"
        @commit="(v) => onExecutionOrder(v)"
      />
    </div>

    <!-- 属性控件：按脚本 static props 声明渲染 -->
    <div v-for="def in schemaOf(comp.script) ?? []" :key="def.key" class="field script-prop">
      <label :title="def.key">{{ def.label ?? def.key }}</label>

      <NumberField
        v-if="def.type === 'number'"
        :model-value="propValue(def.key, def) as number"
        :step="def.step ?? 0.1"
        :title="def.key"
        @commit="(v) => onPropEdit(def, v)"
      />

      <input
        v-else-if="def.type === 'string'"
        class="prop-string mono"
        type="text"
        :value="String(propValue(def.key, def) ?? '')"
        @change="emit('setProp', def.key, ($event.target as HTMLInputElement).value)"
      />

      <input
        v-else-if="def.type === 'boolean'"
        type="checkbox"
        :checked="propValue(def.key, def) === true"
        @change="emit('setProp', def.key, ($event.target as HTMLInputElement).checked)"
      />

      <input
        v-else-if="def.type === 'color'"
        type="color"
        :value="String(propValue(def.key, def) ?? '#ffffff')"
        @change="emit('setProp', def.key, ($event.target as HTMLInputElement).value)"
      />

      <!-- 场景节点引用：从场景中按类型选择目标节点（value = 节点 id） -->
      <select
        v-else-if="def.type === 'entity'"
        class="prop-string mono"
        :value="String(propValue(def.key, def) ?? '')"
        :title="def.filter?.length ? `可选节点类型：${def.filter.join('/')}` : '任意场景节点'"
        @change="emit('setProp', def.key, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">（未选择）</option>
        <option v-for="n in nodeRefOptions(def)" :key="n.id" :value="n.id">{{ n.name }}</option>
      </select>

      <div v-else-if="def.type === 'vec3'" class="prop-vec3">
        <NumberField
          :model-value="vecAxis(propValue(def.key, def), 'x')"
          :step="def.step ?? 0.1"
          title="X"
          @commit="(v) => onVec3Axis(def, 'x', v)"
        />
        <NumberField
          :model-value="vecAxis(propValue(def.key, def), 'y')"
          :step="def.step ?? 0.1"
          title="Y"
          @commit="(v) => onVec3Axis(def, 'y', v)"
        />
        <NumberField
          :model-value="vecAxis(propValue(def.key, def), 'z')"
          :step="def.step ?? 0.1"
          title="Z"
          @commit="(v) => onVec3Axis(def, 'z', v)"
        />
      </div>
    </div>
    <div
      v-if="schemaOf(comp.script) !== null && (schemaOf(comp.script) ?? []).length === 0"
      class="hint"
    >
      该脚本未声明属性（static props / @property）
    </div>
    <div v-if="schemaOf(comp.script) === null && scriptExists(comp.script)" class="hint">
      未解析到属性声明
    </div>
  </div>
</template>

<style scoped>
.comp-script-path {
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
