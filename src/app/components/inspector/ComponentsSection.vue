<script setup lang="ts">
// Components 卡片：脚本组件区（可增删改，数据存 Node.components）+ 原生组件区
// （随节点类型自动派生的只读展示）。脚本属性控件按脚本 static props 声明渲染
// （scripts store 解析缓存，不执行用户代码）；组件的运行期实例化由播放器完成。
import { computed, ref, watch } from "vue";
import type { Node, NodeComponentRef } from "../../../framework/prototype/Node";
import { MeshNode, LightNode, CameraNode, SkyboxNode } from "../../../framework/prototype/derived/Primitives";
import { getEditorStore } from "../../stores/editor";
import { getScriptsStore } from "../../stores/scripts";
import { getProjectStore } from "../../stores/project";
import { prompt } from "../../lib/prompt";
import { openContextMenu, menuSeparator, type CtxMenuItem } from "../../../lib/editor/context-menu";
import type { ScriptPropDef } from "../../lib/script-compile";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: Node; rev?: number }>();

const emit = defineEmits<{
  addComponent: [scriptRel: string];
  removeComponent: [compId: string];
  toggleComponent: [compId: string, enabled: boolean];
  setProp: [compId: string, key: string, value: unknown];
}>();

const scriptsStore = getScriptsStore();
const projectStore = getProjectStore();

/** 本节点组件列表（rev 为失效信号） */
const components = computed<NodeComponentRef[]>(() => {
  void props.rev;
  return props.node.components;
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

// 属性声明缓存：script → props 声明（未解析 = null；异步加载后经 schemasRev 失效）
const schemas = ref<Record<string, ScriptPropDef[] | null>>({});
const schemasRev = ref(0);

watch(
  components,
  (list) => {
    let changed = false;
    for (const c of list) {
      if (Object.prototype.hasOwnProperty.call(schemas.value, c.script)) continue;
      changed = true;
      schemas.value[c.script] = null;
      void scriptsStore.propsSchemaFor(c.script).then((defs) => {
        schemas.value = { ...schemas.value, [c.script]: defs };
        schemasRev.value += 1;
      });
    }
    if (changed) schemas.value = { ...schemas.value };
  },
  { immediate: true },
);

function schemaOf(rel: string): ScriptPropDef[] | null {
  void schemasRev.value;
  return schemas.value[rel] ?? null;
}

/** 属性显示值：节点配置值优先，缺省取声明 default */
function propValue(c: NodeComponentRef, key: string, def: ScriptPropDef): unknown {
  const stored = c.props[key];
  if (stored !== undefined) return stored;
  return def.default;
}

function onPropEdit(c: NodeComponentRef, def: ScriptPropDef, raw: unknown): void {
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
function onVec3Axis(c: NodeComponentRef, def: ScriptPropDef, axis: "x" | "y" | "z", raw: number): void {
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

/** 添加脚本组件：菜单列出项目脚本（可跳转新建） */
function onAddMenu(e: MouseEvent): void {
  const items: CtxMenuItem[] = scriptList.value.map((rel) => ({
    label: baseName(rel),
    onClick: () => emit("addComponent", rel),
  }));
  if (!items.length) {
    items.push({ label: "（src/ 内暂无脚本）", disabled: true });
  }
  items.push(
    menuSeparator(),
    {
      label: "新建脚本…",
      onClick: async () => {
        const editorStore = getEditorStore();
        editorStore.setViewMode("script");
        const name = await prompt({
          title: "新建脚本",
          label: "脚本名（创建在 src/ 目录）",
          placeholder: "MyScript",
        });
        if (!name?.trim()) return;
        const rel = await scriptsStore.createScript(name.trim());
        if (rel) emit("addComponent", rel);
      },
    },
  );
  openContextMenu(e, items);
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

    <button class="add-script-comp" title="从项目脚本中选择挂载" @click="onAddMenu">
      ＋ 添加脚本组件
    </button>
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
  </div>
</template>
