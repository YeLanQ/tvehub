<script setup lang="ts">
/**
 * 自定义节点面板：管理用户可扩展的节点类型定义。
 * 添加 / 编辑（标签/描述/颜色/端口/字段/表达式） / 删除。
 * 定义随图会话自动持久化（sidecar .tve 旁路），运行时按表达式求值。
 */
import { ref } from "vue";
import { getGraphWindowStore } from "../graphStore";
import type { GCustomNodeDef, GCustomPort, GCustomField } from "../../framework/graph";

const store = getGraphWindowStore();

const expanded = ref<string | null>(null);
const DATA_TYPES = ["number", "boolean", "string", "vec3", "any", "entities", "entity"];
const FIELD_KINDS = ["number", "boolean", "string"] as const;
const COLORS = ["#4ec9b0", "#dcdcaa", "#c586c0", "#569cd6", "#ce9178", "#88c0d0"];

function toggle(id: string): void {
  expanded.value = expanded.value === id ? null : id;
}

function commit(id: string): void {
  store.updateCustomNodeDef(id, {});
}

function addPort(def: GCustomNodeDef, dir: "inputs" | "outputs"): void {
  const list = def[dir];
  const idx = list.length + 1;
  const port: GCustomPort = { id: `p${idx}`, label: `端口${idx}`, dataType: "number" };
  list.push(port);
  commit(def.id);
}

function removePort(def: GCustomNodeDef, dir: "inputs" | "outputs", idx: number): void {
  def[dir].splice(idx, 1);
  commit(def.id);
}

function addField(def: GCustomNodeDef): void {
  const idx = def.fields.length + 1;
  const field: GCustomField = { key: `f${idx}`, label: `字段${idx}`, kind: "number", fallback: 0 };
  def.fields.push(field);
  commit(def.id);
}

function removeField(def: GCustomNodeDef, idx: number): void {
  def.fields.splice(idx, 1);
  commit(def.id);
}

function setExpr(def: GCustomNodeDef, outputId: string, expr: string): void {
  def.expressions[outputId] = expr;
  commit(def.id);
}
</script>

<template>
  <div class="gvar-panel gcustom-panel">
    <div class="gvar-head">
      <span class="gvar-title">自定义节点</span>
      <button class="gvar-add" title="添加自定义节点" @click="store.addCustomNodeDef()">+</button>
    </div>
    <div v-if="!store.graphCustomNodes.length" class="gvar-empty">
      暂无自定义节点。点击 + 创建用户定义的节点类型（端口 + 表达式求值）。
    </div>
    <div v-for="d in store.graphCustomNodes" :key="d.id" class="gcustom-def">
      <div class="gcustom-def-head" @click="toggle(d.id)">
        <span class="gcustom-def-name">{{ d.label }}</span>
        <span class="gcustom-def-type mono">{{ d.type }}</span>
        <button class="gvar-del" title="删除定义" @click.stop="store.deleteCustomNodeDef(d.id)">×</button>
      </div>
      <template v-if="expanded === d.id">
        <div class="gcustom-edit">
          <label class="gfield">
            <span class="gfield-label">名称</span>
            <input :value="d.label" @change="store.updateCustomNodeDef(d.id, { label: ($event.target as HTMLInputElement).value })" />
          </label>
          <label class="gfield">
            <span class="gfield-label">类型键</span>
            <input :value="d.type" @change="store.updateCustomNodeDef(d.id, { type: ($event.target as HTMLInputElement).value || d.type })" />
          </label>
          <label class="gfield">
            <span class="gfield-label">描述</span>
            <input :value="d.desc" @change="store.updateCustomNodeDef(d.id, { desc: ($event.target as HTMLInputElement).value })" />
          </label>
          <div class="gfield">
            <span class="gfield-label">颜色</span>
            <span class="gcolor-row">
              <button
                v-for="c in COLORS"
                :key="c"
                class="gcolor-dot"
                :class="{ active: d.color === c }"
                :style="{ background: c }"
                @click="store.updateCustomNodeDef(d.id, { color: c })"
              ></button>
            </span>
          </div>

          <!-- 输入端口 -->
          <div class="gcustom-section">输入端口</div>
          <div v-for="(p, i) in d.inputs" :key="i" class="gcustom-port-row">
            <input class="gcustom-port-id" :value="p.id" @change="d.inputs[i].id = ($event.target as HTMLInputElement).value; commit(d.id)" placeholder="id" />
            <input class="gcustom-port-label" :value="p.label" @change="d.inputs[i].label = ($event.target as HTMLInputElement).value; commit(d.id)" placeholder="标签" />
            <select :value="p.dataType" @change="d.inputs[i].dataType = ($event.target as HTMLSelectElement).value; commit(d.id)">
              <option v-for="t in DATA_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <button class="gvar-del" @click="removePort(d, 'inputs', i)">×</button>
          </div>
          <button class="gcustom-add-btn" @click="addPort(d, 'inputs')">+ 输入端口</button>

          <!-- 输出端口 -->
          <div class="gcustom-section">输出端口</div>
          <div v-for="(p, i) in d.outputs" :key="i" class="gcustom-port-row">
            <input class="gcustom-port-id" :value="p.id" @change="d.outputs[i].id = ($event.target as HTMLInputElement).value; commit(d.id)" placeholder="id" />
            <input class="gcustom-port-label" :value="p.label" @change="d.outputs[i].label = ($event.target as HTMLInputElement).value; commit(d.id)" placeholder="标签" />
            <select :value="p.dataType" @change="d.outputs[i].dataType = ($event.target as HTMLSelectElement).value; commit(d.id)">
              <option v-for="t in DATA_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <button class="gvar-del" @click="removePort(d, 'outputs', i)">×</button>
          </div>
          <button class="gcustom-add-btn" @click="addPort(d, 'outputs')">+ 输出端口</button>

          <!-- 字段 -->
          <div class="gcustom-section">字段（检查器编辑的字面量参数）</div>
          <div v-for="(f, i) in d.fields" :key="i" class="gcustom-port-row">
            <input class="gcustom-port-id" :value="f.key" @change="d.fields[i].key = ($event.target as HTMLInputElement).value; commit(d.id)" placeholder="key" />
            <input class="gcustom-port-label" :value="f.label" @change="d.fields[i].label = ($event.target as HTMLInputElement).value; commit(d.id)" placeholder="标签" />
            <select :value="f.kind" @change="d.fields[i].kind = ($event.target as HTMLSelectElement).value as 'number' | 'boolean' | 'string'; commit(d.id)">
              <option v-for="k in FIELD_KINDS" :key="k" :value="k">{{ k }}</option>
            </select>
            <button class="gvar-del" @click="removeField(d, i)">×</button>
          </div>
          <button class="gcustom-add-btn" @click="addField(d)">+ 字段</button>

          <!-- 表达式 -->
          <div class="gcustom-section">表达式（每个输出端口的求值逻辑）</div>
          <div v-for="p in d.outputs" :key="p.id" class="gcustom-expr-row">
            <label class="gfield col">
              <span class="gfield-label mono">{{ p.id }} →</span>
              <input
                :value="d.expressions[p.id] ?? ''"
                :placeholder="`表达式（可引用输入端口 id、字段 key、Math）`"
                @change="setExpr(d, p.id, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
          <div class="ginsp-hint">表达式示例：a + b、Math.sin(a)、a * f1（f1 为字段 key）。运行时按拉模型求值。</div>
        </div>
      </template>
    </div>
  </div>
</template>