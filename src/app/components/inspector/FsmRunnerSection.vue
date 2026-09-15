<script setup lang="ts">
/**
 * 状态机运行器卡（FsmRunnerNode）：
 * - Asset：绑定的 .fsm 资产下拉（项目内；新建入口在资产面板「新建 ▸ 状态机」）；
 * - Runtime：自动运行开关（绑定就绪即跑）+ 时间倍率（影响定时/等待类计时）；
 * - Live：当前状态 / 停留时长 / 最近过渡（随 logic:changed 刷新）；
 * - 控制（运行态操作，不走撤销）：运行/暂停、重启（状态回入口、黑板回默认）、
 *   发射事件、强制切换状态、参数黑板增改删（条件过渡的数据源）。
 */
import { computed, ref } from "vue";
import type { FsmRunnerNode } from "../../../framework/prototype/derived/Primitives";
import { isFsmAssetRel } from "../../../framework/fsm";
import { LOGIC_RUNNER_LIMITS } from "../../../framework/logic";
import { getEditorStore } from "../../stores/editor";
import { getAssetsStore } from "../../stores/assets";
import { logStore } from "../../stores/log";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: FsmRunnerNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const L = LOGIC_RUNNER_LIMITS;

const s = computed(() => {
  void props.rev;
  return props.node.settings;
});

const editor = () => getEditorStore().engine;
const assetsStore = getAssetsStore();

/** 项目内 .fsm 资产候选（资产面板导入/新建后自动出现） */
const fsmOptions = computed(() => {
  void props.rev;
  return assetsStore.assets
    .filter((a) => a.kind !== "dir" && isFsmAssetRel(a.path))
    .map((a) => ({ rel: a.path, name: a.name }));
});

const assetListed = computed(() => {
  const cur = s.value.asset;
  if (!cur) return true;
  return fsmOptions.value.some((o) => o.rel === cur);
});

/** 运行时视图（绑定/就绪/当前状态；随 logic:changed 的 rev 刷新） */
const view = computed(() => {
  void props.rev;
  return editor().logic.getFsmView(props.node.id);
});

/** 图内全部状态（强制切换下拉；未就绪为空） */
const stateOptions = computed(() => {
  void props.rev;
  return editor().logic.fsmGraph(props.node.id)?.states ?? [];
});

/** 参数黑板编辑（本地副本 + 提交到运行器；新增行） */
const paramRows = computed(() => {
  void props.rev;
  const v = view.value;
  return v ? Object.entries(v.params).map(([name, value]) => ({ name, value })) : [];
});
const newParamName = ref("");
const newParamValue = ref(0);
const fireName = ref("");
const lastResult = ref("");

function onRunToggle(): void {
  const v = view.value;
  if (!v) return;
  editor().logic.setRunning(props.node.id, !v.running);
}

function onRestart(): void {
  editor().logic.restart(props.node.id);
}

function onFire(): void {
  const name = fireName.value.trim();
  if (!name) return;
  editor().logic.fireFsmEvent(props.node.id, name);
  lastResult.value = `已发射事件 ${name}`;
}

function onForceState(e: Event): void {
  const id = (e.target as HTMLSelectElement).value;
  if (!id) return;
  editor().logic.forceFsmState(props.node.id, id);
  const name = stateOptions.value.find((st) => st.id === id)?.name ?? id;
  lastResult.value = `已切换到 ${name}`;
}

function onSetParam(name: string, value: number | boolean): void {
  editor().logic.setFsmParam(props.node.id, name, value);
}

function onAddParam(): void {
  const name = newParamName.value.trim();
  if (!name) return;
  editor().logic.setFsmParam(props.node.id, name, newParamValue.value);
  newParamName.value = "";
  newParamValue.value = 0;
}

function onRemoveParam(name: string): void {
  const v = view.value;
  if (!v || !(name in v.params)) return;
  // 黑板删除：写 undefined 语义由参数表达成——这里按 0 值删除不可行，
  // 直接置 0 并提示（条件按 0 求值，等于该参数中性化）
  editor().logic.setFsmParam(props.node.id, name, 0);
  logStore.log("info", `参数 ${name} 已置 0（黑板不支持删除，条件可按 0 判定）`);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
</script>

<template>
  <div class="terrain-section" :data-rev="rev">
    <!-- ===== Asset ===== -->
    <div class="ts-group">Asset</div>
    <div class="field">
      <label title="绑定的状态机资产（.fsm；资产面板「新建 ▸ 状态机」创建后在此绑定）">Graph</label>
      <select :value="s.asset" @change="emit('update', 'Bind FSM Asset', ($event.target as HTMLSelectElement).value)">
        <option value="">（未绑定）</option>
        <option v-if="!assetListed" :value="s.asset">（已删除的资产）</option>
        <option v-for="o in fsmOptions" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </select>
    </div>

    <!-- ===== Runtime ===== -->
    <div class="ts-group">Runtime</div>
    <div class="field">
      <label title="绑定就绪后自动开始运行（检查器可随时暂停/继续）">Auto Start</label>
      <input
        type="checkbox"
        :checked="s.autoStart"
        title="自动运行开关"
        @change="emit('update', 'Toggle FSM Auto Start', ($event.target as HTMLInputElement).checked)"
      />
    </div>
    <div class="field">
      <label title="求值时间倍率：影响 duration 定时过渡等计时">Speed</label>
      <NumberField
        :model-value="s.speed"
        :step="L.speed.step"
        :min="L.speed.min"
        :max="L.speed.max"
        title="时间倍率"
        @commit="(v) => emit('update', 'Set FSM Speed', clamp(v, L.speed.min, L.speed.max))"
      />
    </div>

    <!-- ===== Live（运行态视图） ===== -->
    <div class="ts-group">Live</div>
    <div class="field">
      <label title="资产解析状态">Ready</label>
      <span class="mono">
        {{ !view?.bound ? "未绑定" : view.assetMissing ? "资产缺失/解析失败" : view.ready ? "就绪" : "加载中…" }}
      </span>
    </div>
    <div class="field">
      <label title="当前状态（含停留时长；定时/条件过渡实时求值）">State</label>
      <span class="mono">
        {{ view?.ready ? `${view.stateName || "—"}（${view.stateTime.toFixed(1)}s）` : "—" }}
      </span>
    </div>
    <div class="field">
      <label title="图规模：状态数 / 过渡数">Graph</label>
      <span class="mono">{{ view?.ready ? `${view.stateCount} / ${view.transitionCount}` : "—" }}</span>
    </div>
    <div class="field">
      <label title="最近一次过渡（from → to，触发方式）">Last</label>
      <span class="mono">
        {{ view?.lastTransition ? `${view.lastTransition.from} → ${view.lastTransition.to}（${view.lastTransition.via}）` : "—" }}
      </span>
    </div>

    <!-- ===== 控制（运行态操作） ===== -->
    <div class="ts-group">Control</div>
    <div class="ts-actions">
      <button title="运行 / 暂停该运行器（不改场景数据）" @click="onRunToggle">
        {{ view?.running ? "暂停" : "运行" }}
      </button>
      <button title="重启：状态回入口、黑板回默认值" @click="onRestart">重启</button>
    </div>
    <div class="field">
      <label title="发射事件（进入当前状态以来的首次发射有效；事件过渡的触发器）">Fire</label>
      <input
        class="logic-input"
        :value="fireName"
        placeholder="事件名"
        @input="fireName = ($event.target as HTMLInputElement).value"
        @keydown.enter="onFire"
      />
      <button title="发射该事件" @click="onFire">→</button>
    </div>
    <div class="field">
      <label title="强制切换到指定状态（不经触发器）">Force</label>
      <select title="强制切换状态" @change="onForceState">
        <option value="">（选择状态…）</option>
        <option v-for="st in stateOptions" :key="st.id" :value="st.id">{{ st.name }}</option>
      </select>
    </div>

    <!-- ===== 参数黑板（条件过渡的数据源） ===== -->
    <div class="ts-group">Params</div>
    <div v-for="row in paramRows" :key="row.name" class="field">
      <label :title="row.name">{{ row.name }}</label>
      <template v-if="typeof row.value === 'boolean'">
        <input
          type="checkbox"
          :checked="row.value"
          @change="onSetParam(row.name, ($event.target as HTMLInputElement).checked)"
        />
      </template>
      <template v-else>
        <NumberField
          :model-value="row.value"
          :step="0.1"
          title="参数值"
          @commit="(v) => onSetParam(row.name, v)"
        />
        <button class="logic-del" title="置 0（黑板不支持删除）" @click="onRemoveParam(row.name)">0</button>
      </template>
    </div>
    <div class="field">
      <label title="新增参数（名称 + 数值；布尔以 0/1 参与条件比较）">+ Add</label>
      <input
        class="logic-input"
        :value="newParamName"
        placeholder="参数名"
        @input="newParamName = ($event.target as HTMLInputElement).value"
        @keydown.enter="onAddParam"
      />
      <NumberField
        :model-value="newParamValue"
        :step="0.1"
        title="初始值"
        @commit="(v) => (newParamValue = v)"
      />
      <button title="添加参数" @click="onAddParam">+</button>
    </div>
    <div class="ts-actions">
      <span v-if="lastResult" class="hint">{{ lastResult }}</span>
      <span v-else class="hint">参数/事件是运行态：检查器写入即时生效，不进撤销历史</span>
    </div>
  </div>
</template>

<style scoped>
.ts-group {
  margin: 8px 0 2px;
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
}
.ts-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 4px;
}
.ts-actions button,
.field button {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ts-actions button:hover,
.field button:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.ts-actions .hint,
.mono {
  font-size: 10px;
  color: var(--text-dim, #888);
}
.logic-input {
  min-width: 0;
  flex: 1;
  font-size: 11px;
  padding: 2px 4px;
}
</style>
