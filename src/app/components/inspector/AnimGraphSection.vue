<script setup lang="ts">
/**
 * 动画图编辑器（AnimationSystem 状态机的数据面）：
 * - 状态：名称 + 绑定剪辑 + 速度/循环（名称唯一，改名级联改过渡引用）；
 * - 过渡：from → to + 淡化时长 + 归一化退出时间 + 参数条件（数值/布尔比较）；
 * - 参数：数值/布尔，默认值随图持久化，改值同时写运行时（即时触发过渡）；
 * - 运行时：显示当前状态，可手动切换（forceState，交叉淡化）。
 * 每次编辑都提交完整图数据（走属性补丁 → 可撤销/重做/存盘）。
 */
import { computed } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import {
  cloneAnimGraph,
  nextTransitionId,
  nextStateName,
  type AnimGraph,
  type AnimLoopMode,
} from "../../../framework/animation";
import { getEditorStore } from "../../stores/editor";
import { prompt } from "../../lib/prompt";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: MeshNode; rev?: number; clips: string[] }>();

const emit = defineEmits<{ updateGraph: [graph: AnimGraph | null] }>();

const engine = getEditorStore().engine;

const graph = computed<AnimGraph>(() => {
  void props.rev;
  return props.node.animGraph as AnimGraph;
});

/** 克隆 → 修改 → 提交（每次编辑一条撤销记录） */
function mutate(fn: (g: AnimGraph) => void, label: string): void {
  const g = cloneAnimGraph(graph.value);
  fn(g);
  // 引用了不存在状态的过渡 / 空参数名等在 AnimationSystem 解析时收敛，这里不重复校验
  void label;
  emit("updateGraph", g);
}

const runtime = computed(() => {
  void props.rev;
  return engine.animation.stateFor(props.node.id);
});

// —— 状态 ——

async function addState(): Promise<void> {
  const name = await prompt({
    title: "添加状态",
    label: "状态名（图内唯一）",
    initial: nextStateName(graph.value),
    confirmText: "添加",
  });
  if (!name) return;
  mutate((g) => {
    if (g.states.some((s) => s.name === name)) return;
    g.states.push({ name, clip: props.clips[0] ?? "", speed: 1, loop: "loop" });
  }, "添加动画状态");
}

async function renameState(oldName: string): Promise<void> {
  const name = await prompt({
    title: "重命名状态",
    label: oldName,
    initial: oldName,
    confirmText: "重命名",
  });
  if (!name || name === oldName) return;
  mutate((g) => {
    if (g.states.some((s) => s.name === name)) return;
    for (const s of g.states) if (s.name === oldName) s.name = name;
    for (const t of g.transitions) {
      if (t.from === oldName) t.from = name;
      if (t.to === oldName) t.to = name;
    }
    if (g.entry === oldName) g.entry = name;
  }, "重命名动画状态");
}

function removeState(name: string): void {
  mutate((g) => {
    g.states = g.states.filter((s) => s.name !== name);
    g.transitions = g.transitions.filter((t) => t.from !== name && t.to !== name);
    if (g.entry === name) g.entry = g.states[0]?.name ?? "";
  }, "删除动画状态");
}

function setStateClip(name: string, clip: string): void {
  mutate((g) => {
    const s = g.states.find((x) => x.name === name);
    if (s) s.clip = clip;
  }, "设置状态剪辑");
}

function setStateSpeed(name: string, speed: number): void {
  mutate((g) => {
    const s = g.states.find((x) => x.name === name);
    if (s) s.speed = Math.max(0, speed);
  }, "设置状态速度");
}

function setStateLoop(name: string, loop: string): void {
  if (loop !== "loop" && loop !== "once" && loop !== "pingpong") return;
  mutate((g) => {
    const s = g.states.find((x) => x.name === name);
    if (s) s.loop = loop as AnimLoopMode;
  }, "设置状态循环");
}

function setEntry(name: string): void {
  mutate((g) => {
    g.entry = name;
  }, "设置入口状态");
}

// —— 过渡 ——

function addTransition(): void {
  const states = graph.value.states;
  if (states.length < 1) return;
  const from = states[0].name;
  const to = states[states.length - 1].name;
  if (from === to && states.length > 1) return; // 默认取首→尾，避免自环
  mutate((g) => {
    g.transitions.push({
      id: nextTransitionId(g),
      from,
      to,
      duration: 0.25,
      exitTime: 0.8,
      conditions: [],
    });
  }, "添加动画过渡");
}

function removeTransition(id: string): void {
  mutate((g) => {
    g.transitions = g.transitions.filter((t) => t.id !== id);
  }, "删除动画过渡");
}

function setTransitionField(
  id: string,
  field: "from" | "to" | "duration" | "exitTime",
  value: unknown,
): void {
  mutate((g) => {
    const t = g.transitions.find((x) => x.id === id);
    if (!t) return;
    if (field === "duration") t.duration = Math.max(0, value as number);
    else if (field === "exitTime") t.exitTime = Math.max(0, Math.min(1, value as number));
    else t[field] = value as string;
  }, "修改动画过渡");
}

function addCondition(id: string): void {
  const keys = Object.keys(graph.value.params);
  if (!keys.length) return; // 无参数时先建参数
  mutate((g) => {
    const t = g.transitions.find((x) => x.id === id);
    if (t) t.conditions.push({ param: keys[0], op: "==", value: 1 });
  }, "添加过渡条件");
}

function setCondition(
  id: string,
  index: number,
  field: "param" | "op" | "value",
  value: unknown,
): void {
  mutate((g) => {
    const t = g.transitions.find((x) => x.id === id);
    const c = t?.conditions[index];
    if (!c) return;
    if (field === "value") c.value = value as number;
    else if (field === "op") c.op = value as typeof c.op;
    else c.param = value as string;
  }, "修改过渡条件");
}

function removeCondition(id: string, index: number): void {
  mutate((g) => {
    const t = g.transitions.find((x) => x.id === id);
    if (t) t.conditions.splice(index, 1);
  }, "删除过渡条件");
}

// —— 参数 ——

async function addParam(): Promise<void> {
  const name = await prompt({
    title: "添加参数",
    label: "参数名（数值或布尔，供过渡条件引用）",
    initial: "speed",
    confirmText: "添加",
  });
  if (!name) return;
  mutate((g) => {
    if (!(name in g.params)) g.params[name] = 0;
  }, "添加动画参数");
}

function removeParam(name: string): void {
  mutate((g) => {
    delete g.params[name];
    for (const t of g.transitions) {
      t.conditions = t.conditions.filter((c) => c.param !== name);
    }
  }, "删除动画参数");
}

/** 改参数：默认值落图数据（存盘），同时写运行时（即时生效触发过渡） */
function setParamValue(name: string, value: number | boolean): void {
  mutate((g) => {
    g.params[name] = value;
  }, "设置动画参数");
  engine.animation.setParam(props.node.id, name, value);
}

function paramType(name: string): "number" | "boolean" {
  return typeof graph.value.params[name] === "boolean" ? "boolean" : "number";
}

function toggleParamType(name: string): void {
  mutate((g) => {
    g.params[name] = paramType(name) === "boolean" ? 0 : false;
  }, "切换动画参数类型");
}

const stateNames = computed(() => graph.value.states.map((s) => s.name));
const paramNames = computed(() => Object.keys(graph.value.params));
</script>

<template>
  <div class="agraph">
    <!-- 入口 -->
    <div class="field">
      <label>入口状态</label>
      <select :value="graph.entry" @change="setEntry(($event.target as HTMLSelectElement).value)">
        <option v-for="n in stateNames" :key="n" :value="n">{{ n }}</option>
      </select>
    </div>
    <div v-if="runtime?.graphState" class="agraph-cur mono">
      当前: {{ runtime.graphState }}{{ runtime.playing ? "" : "（暂停）" }}
      <span class="agraph-force">
        <button
          v-for="n in stateNames"
          :key="n"
          :class="{ on: n === runtime.graphState }"
          :title="`切换到 ${n}`"
          @click="engine.animation.forceState(node.id, n)"
        >{{ n }}</button>
      </span>
    </div>

    <!-- 状态 -->
    <div class="agraph-group">
      <span class="agraph-title">状态（{{ graph.states.length }}）</span>
      <button title="添加状态" @click="addState">＋</button>
    </div>
    <div v-for="s in graph.states" :key="s.name" class="agraph-row">
      <button class="agraph-name" title="重命名" @click="renameState(s.name)">{{ s.name }}</button>
      <select
        class="agraph-clip"
        :value="s.clip"
        title="绑定剪辑"
        @change="setStateClip(s.name, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">（保持姿势）</option>
        <option v-for="c in clips" :key="c" :value="c">{{ c }}</option>
      </select>
      <select
        class="agraph-loop"
        :value="s.loop"
        title="循环模式"
        @change="setStateLoop(s.name, ($event.target as HTMLSelectElement).value)"
      >
        <option value="loop">循环</option>
        <option value="once">一次</option>
        <option value="pingpong">往复</option>
      </select>
      <NumberField
        class="agraph-speed"
        :model-value="s.speed"
        :step="0.05"
        :min="0"
        :max="10"
        title="速度"
        @commit="(v) => setStateSpeed(s.name, v)"
      />
      <button class="agraph-del" title="删除状态" @click="removeState(s.name)">✕</button>
    </div>

    <!-- 过渡 -->
    <div class="agraph-group">
      <span class="agraph-title">过渡（{{ graph.transitions.length }}）</span>
      <button title="添加过渡（默认首状态 → 末状态）" :disabled="graph.states.length < 2" @click="addTransition">＋</button>
    </div>
    <div v-for="t in graph.transitions" :key="t.id" class="agraph-tblock">
      <div class="agraph-row">
        <select
          class="agraph-from"
          :value="t.from"
          @change="setTransitionField(t.id, 'from', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="n in stateNames" :key="n" :value="n">{{ n }}</option>
        </select>
        <span class="agraph-arrow">→</span>
        <select
          class="agraph-from"
          :value="t.to"
          @change="setTransitionField(t.id, 'to', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="n in stateNames" :key="n" :value="n">{{ n }}</option>
        </select>
        <NumberField
          class="agraph-num"
          :model-value="t.duration"
          :step="0.05"
          :min="0"
          :max="5"
          title="淡化时长（秒）"
          @commit="(v) => setTransitionField(t.id, 'duration', v)"
        />
        <NumberField
          class="agraph-num"
          :model-value="t.exitTime"
          :step="0.05"
          :min="0"
          :max="1"
          title="退出时间（0-1 归一化；0 = 条件满足即过渡）"
          @commit="(v) => setTransitionField(t.id, 'exitTime', v)"
        />
        <button class="agraph-del" title="删除过渡" @click="removeTransition(t.id)">✕</button>
      </div>
      <div v-for="(c, i) in t.conditions" :key="i" class="agraph-row cond">
        <select
          class="agraph-from"
          :value="c.param"
          @change="setCondition(t.id, i, 'param', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="p in paramNames" :key="p" :value="p">{{ p }}</option>
        </select>
        <select
          class="agraph-op"
          :value="c.op"
          @change="setCondition(t.id, i, 'op', ($event.target as HTMLSelectElement).value)"
        >
          <option value=">">&gt;</option>
          <option value="<">&lt;</option>
          <option value=">=">&ge;</option>
          <option value="<=">&le;</option>
          <option value="==">==</option>
          <option value="!=">!=</option>
        </select>
        <NumberField
          class="agraph-num"
          :model-value="c.value"
          :step="0.1"
          :min="-999"
          :max="999"
          title="比较值（布尔参数按 0/1 比较）"
          @commit="(v) => setCondition(t.id, i, 'value', v)"
        />
        <button class="agraph-del" title="删除条件" @click="removeCondition(t.id, i)">✕</button>
      </div>
      <button
        class="agraph-addcond"
        :disabled="paramNames.length === 0"
        :title="paramNames.length === 0 ? '先在下方添加参数' : '添加条件'"
        @click="addCondition(t.id)"
      >＋ 条件</button>
    </div>

    <!-- 参数 -->
    <div class="agraph-group">
      <span class="agraph-title">参数（{{ paramNames.length }}）</span>
      <button title="添加参数" @click="addParam">＋</button>
    </div>
    <div v-for="name in paramNames" :key="name" class="agraph-row">
      <span class="agraph-pname mono" :title="name">{{ name }}</span>
      <button class="agraph-type" :title="paramType(name) === 'boolean' ? '布尔' : '数值'" @click="toggleParamType(name)">
        {{ paramType(name) === "boolean" ? "布林" : "数值" }}
      </button>
      <input
        v-if="paramType(name) === 'boolean'"
        type="checkbox"
        :checked="graph.params[name] === true"
        @change="setParamValue(name, ($event.target as HTMLInputElement).checked)"
      />
      <NumberField
        v-else
        class="agraph-num"
        :model-value="Number(graph.params[name])"
        :step="0.1"
        :min="-999"
        :max="999"
        @commit="(v) => setParamValue(name, v)"
      />
      <button class="agraph-del" title="删除参数" @click="removeParam(name)">✕</button>
    </div>
    <div class="hint">过渡在“退出时间到达 + 条件全部满足”时触发交叉淡化；参数改值即时生效。</div>
  </div>
</template>

<style scoped>
.agraph {
  display: block;
  width: 100%;
  margin-top: 4px;
}
.agraph-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
  padding: 6px 0 4px;
  margin-top: 6px;
}
.agraph-title {
  flex: 1 1 auto;
}
.agraph-group button,
.agraph-addcond {
  font-size: 11px;
  line-height: 1.2;
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.agraph-group button:hover:not(:disabled),
.agraph-addcond:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.agraph-group button:disabled,
.agraph-addcond:disabled {
  opacity: 0.4;
  cursor: default;
}
.agraph-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}
.agraph-row select,
.agraph-row input[type="checkbox"] {
  min-width: 0;
}
.agraph-name {
  flex: 1 1 auto;
  min-width: 40px;
  text-align: left;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px dashed var(--text-dim, #555);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agraph-name:hover {
  border-color: var(--accent, #4a9eff);
}
.agraph-clip {
  flex: 1.4 1 80px;
}
.agraph-loop {
  flex: none;
  width: 52px;
}
.agraph-speed {
  flex: none;
  width: 56px;
}
.agraph-num {
  flex: none;
  width: 56px;
}
.agraph-from {
  flex: 1 1 60px;
}
.agraph-op {
  flex: none;
  width: 44px;
}
.agraph-arrow {
  flex: none;
  color: var(--text-dim, #888);
}
.agraph-del,
.agraph-type {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text-dim, #aaa);
  cursor: pointer;
}
.agraph-del:hover {
  border-color: #e06c5a;
  color: #e06c5a;
}
.agraph-pname {
  flex: 1 1 auto;
  min-width: 40px;
  font-size: 11px;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agraph-tblock {
  border-left: 2px solid var(--border, #333);
  padding-left: 6px;
  margin: 2px 0 4px;
}
.agraph-row.cond {
  padding-left: 8px;
}
.agraph-addcond {
  margin: 2px 0 4px 8px;
}
.agraph-cur {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim, #999);
  padding: 2px 0;
  overflow: hidden;
}
.agraph-force {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}
.agraph-force button {
  font-size: 10px;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #555);
  background: transparent;
  color: var(--text-dim, #aaa);
  cursor: pointer;
}
.agraph-force button.on {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
</style>
