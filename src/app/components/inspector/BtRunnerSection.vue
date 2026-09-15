<script setup lang="ts">
/**
 * 行为树运行器卡（BtRunnerNode）：
 * - Asset：绑定的 .bt 资产下拉（项目内；新建入口在资产面板「新建 ▸ 行为树」）；
 * - Runtime：自动运行开关 + 时间倍率（影响等待/超时节点的计时）；
 * - Live：整树状态（success/failure/running）/ 节点数 / 最近动作叶子；
 * - 控制（运行态操作，不走撤销）：运行/暂停、重启（黑板清空）、黑板增改
 *   （条件叶子的求值对象）；动作叶子经脚本 engine.logic.onAction 注册行为。
 */
import { computed, ref } from "vue";
import type { BtRunnerNode } from "../../../framework/prototype/derived/Primitives";
import { isBtAssetRel } from "../../../framework/behavior";
import { LOGIC_RUNNER_LIMITS } from "../../../framework/logic";
import { getEditorStore } from "../../stores/editor";
import { getAssetsStore } from "../../stores/assets";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: BtRunnerNode; rev?: number }>();

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

/** 项目内 .bt 资产候选 */
const btOptions = computed(() => {
  void props.rev;
  return assetsStore.assets
    .filter((a) => a.kind !== "dir" && isBtAssetRel(a.path))
    .map((a) => ({ rel: a.path, name: a.name }));
});

const assetListed = computed(() => {
  const cur = s.value.asset;
  if (!cur) return true;
  return btOptions.value.some((o) => o.rel === cur);
});

/** 运行时视图（绑定/就绪/树状态；随 logic:changed 的 rev 刷新） */
const view = computed(() => {
  void props.rev;
  return editor().logic.getBtView(props.node.id);
});

const STATUS_TEXT: Record<string, string> = {
  success: "成功",
  failure: "失败",
  running: "运行中",
};

const blackboardRows = computed(() => {
  void props.rev;
  const v = view.value;
  return v ? Object.entries(v.blackboard).map(([name, value]) => ({ name, value })) : [];
});
const newParamName = ref("");
const newParamValue = ref(0);

function onRunToggle(): void {
  const v = view.value;
  if (!v) return;
  editor().logic.setRunning(props.node.id, !v.running);
}

function onRestart(): void {
  editor().logic.restart(props.node.id);
}

function onSetParam(name: string, value: number | boolean): void {
  editor().logic.setBtParam(props.node.id, name, value);
}

function onAddParam(): void {
  const name = newParamName.value.trim();
  if (!name) return;
  editor().logic.setBtParam(props.node.id, name, newParamValue.value);
  newParamName.value = "";
  newParamValue.value = 0;
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
      <label title="绑定的行为树资产（.bt；资产面板「新建 ▸ 行为树」创建后在此绑定）">Tree</label>
      <select :value="s.asset" @change="emit('update', 'Bind BT Asset', ($event.target as HTMLSelectElement).value)">
        <option value="">（未绑定）</option>
        <option v-if="!assetListed" :value="s.asset">（已删除的资产）</option>
        <option v-for="o in btOptions" :key="o.rel" :value="o.rel" :title="o.rel">
          {{ o.name }}
        </option>
      </select>
    </div>

    <!-- ===== Runtime ===== -->
    <div class="ts-group">Runtime</div>
    <div class="field">
      <label title="绑定就绪后自动开始运行（每帧 tick 整棵树）">Auto Start</label>
      <input
        type="checkbox"
        :checked="s.autoStart"
        title="自动运行开关"
        @change="emit('update', 'Toggle BT Auto Start', ($event.target as HTMLInputElement).checked)"
      />
    </div>
    <div class="field">
      <label title="求值时间倍率：影响等待/超时节点的计时">Speed</label>
      <NumberField
        :model-value="s.speed"
        :step="L.speed.step"
        :min="L.speed.min"
        :max="L.speed.max"
        title="时间倍率"
        @commit="(v) => emit('update', 'Set BT Speed', clamp(v, L.speed.min, L.speed.max))"
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
      <label title="整树最近一次 tick 结果">Status</label>
      <span class="mono">{{ view?.ready && view.status ? (STATUS_TEXT[view.status] ?? view.status) : "—" }}</span>
    </div>
    <div class="field">
      <label title="树内节点总数">Nodes</label>
      <span class="mono">{{ view?.ready ? view.nodeCount : "—" }}</span>
    </div>
    <div class="field">
      <label title="最近一次被求值的动作叶子名（动作行为经脚本 engine.logic.onAction 注册）">Action</label>
      <span class="mono">{{ view?.lastAction || "—" }}</span>
    </div>

    <!-- ===== 控制（运行态操作） ===== -->
    <div class="ts-group">Control</div>
    <div class="ts-actions">
      <button title="运行 / 暂停该运行器（不改场景数据）" @click="onRunToggle">
        {{ view?.running ? "暂停" : "运行" }}
      </button>
      <button title="重启：清运行记忆与黑板，树从头求值" @click="onRestart">重启</button>
    </div>

    <!-- ===== 黑板（条件叶子的求值对象） ===== -->
    <div class="ts-group">Blackboard</div>
    <div v-for="row in blackboardRows" :key="row.name" class="field">
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
          title="黑板值"
          @commit="(v) => onSetParam(row.name, v)"
        />
      </template>
    </div>
    <div class="field">
      <label title="新增黑板项（名称 + 数值；布尔以 0/1 参与条件比较）">+ Add</label>
      <input
        class="logic-input"
        :value="newParamName"
        placeholder="名称"
        @input="newParamName = ($event.target as HTMLInputElement).value"
        @keydown.enter="onAddParam"
      />
      <NumberField
        :model-value="newParamValue"
        :step="0.1"
        title="初始值"
        @commit="(v) => (newParamValue = v)"
      />
      <button title="添加" @click="onAddParam">+</button>
    </div>
    <div class="ts-actions">
      <span class="hint">黑板是运行态：脚本可经 engine.logic.setBtParam 读写，不进撤销历史</span>
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
