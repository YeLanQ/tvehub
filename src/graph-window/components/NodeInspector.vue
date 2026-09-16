<script setup lang="ts">
/**
 * 右侧检查器：按选中卡片种类显示 ——
 * - 原型：实体实时属性参照（变换/状态/灯光），提示用操作节点定义运行时行为；
 * - 匹配：模式（标签|类型）与模式串（候选来自场景实体），实时命中数；
 * - 操作：触发时机 + 参数表（提交先压会话快照，自动保存随之落盘）；
 * - 注释框：文本与主题色。
 */
import { computed, ref, watch } from "vue";
import { getGraphWindowStore } from "../graphStore";
import {
  G_OP_TRIGGER_LABEL,
  GRAPH_COMMENT_COLORS,
  graphOpDef,
  type GComment,
  type GNode,
} from "../../framework/graph";
import type { SceneEntity } from "../lib/scene-index";

const store = getGraphWindowStore();

const g = ref<GNode | null>(null);
const c = ref<GComment | null>(null);

watch(
  () => [store.selectedId, store.selectedIsComment],
  () => {
    g.value = store.canvas?.getSelectedNode() ?? null;
    c.value = store.canvas?.getSelectedComment() ?? null;
  },
);

const def = computed(() => (g.value?.kind === "op" ? graphOpDef(g.value.opType ?? "") : null));
/** 原型对应的场景实体（实时属性参照） */
const entity = computed<SceneEntity | null>(() => {
  if (g.value?.kind !== "proto") return null;
  return store.sceneEntities.find((e) => e.id === g.value?.entityId) ?? null;
});

/** 匹配节点的实时命中 */
const matched = computed(() => {
  if (g.value?.kind !== "match") return [];
  const tagList = g.value.matchMode === "type"
    ? store.sceneEntities.filter((e) => e.type === (g.value?.matchPattern ?? ""))
    : store.sceneEntities.filter((e) => e.tag === (g.value?.matchPattern ?? ""));
  return tagList;
});

/** 模式串候选（场景中去重的标签 / 类型键） */
const patternOptions = computed(() => {
  if (g.value?.kind !== "match") return [];
  return [...new Set(store.sceneEntities.map((e) => (g.value?.matchMode === "type" ? e.type : e.tag)).filter(Boolean))];
});

const vecText = (v: { x: number; y: number; z: number }): string =>
  `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;

// ----- 操作参数提交 -----

function commitParam(key: string, raw: string | boolean): void {
  if (g.value?.kind !== "op") return;
  const defV = def.value;
  if (!defV) return;
  const f = defV.fields.find((x) => x.key === key);
  if (!f) return;
  store.canvas?.requestSnapshot();
  if (!g.value.params || typeof g.value.params !== "object") g.value.params = {};
  if (f.kind === "number") {
    let n = Number(raw);
    if (!Number.isFinite(n)) n = Number(f.fallback);
    g.value.params[key] = n;
  } else if (f.kind === "boolean") {
    g.value.params[key] = raw === true;
  } else {
    g.value.params[key] = String(raw);
  }
  store.markGraphDirty();
}

// ----- 匹配参数提交 -----

function commitMatch(patch: { matchMode?: "tag" | "type"; matchPattern?: string }): void {
  if (g.value?.kind !== "match") return;
  store.canvas?.requestSnapshot();
  if (patch.matchMode) g.value.matchMode = patch.matchMode;
  if (patch.matchPattern !== undefined) g.value.matchPattern = patch.matchPattern;
  store.markGraphDirty();
}

// ----- 注释框 -----

function commitCommentText(raw: string): void {
  if (!c.value) return;
  store.canvas?.requestSnapshot();
  c.value.text = raw.slice(0, 2000);
  store.markGraphDirty();
}

function commitCommentColor(color: string): void {
  if (!c.value) return;
  store.canvas?.requestSnapshot();
  c.value.color = color;
  store.markGraphDirty();
}
</script>

<template>
  <div class="ginspector">
    <!-- 原型：实体实时属性参照 -->
    <template v-if="g?.kind === 'proto'">
      <div class="ginsp-head">
        <span class="ginsp-dot" style="background: #569cd6"></span>
        <span class="ginsp-static">{{ entity?.name || "原型" }}</span>
      </div>
      <div class="ginsp-type">{{ entity?.type || "实体不在当前场景" }}</div>

      <template v-if="entity">
        <div class="ginsp-section">变换</div>
        <div class="gprop"><span class="gk">位置</span><span class="gv mono">{{ vecText(entity.position) }}</span></div>
        <div class="gprop"><span class="gk">旋转</span><span class="gv mono">{{ vecText(entity.rotation) }}</span></div>
        <div class="gprop"><span class="gk">缩放</span><span class="gv mono">{{ vecText(entity.scale) }}</span></div>
        <div class="ginsp-section">状态</div>
        <div class="gprop"><span class="gk">可见</span><span class="gv">{{ entity.visible ? "是" : "否" }}</span></div>
        <div class="gprop"><span class="gk">启用</span><span class="gv">{{ entity.active ? "是" : "否" }}</span></div>
        <div class="gprop"><span class="gk">标签</span><span class="gv">{{ entity.tag || "—" }}</span></div>
        <template v-if="entity.light">
          <div class="ginsp-section">灯光</div>
          <div class="gprop"><span class="gk">强度</span><span class="gv mono">{{ entity.light.intensity }}</span></div>
          <div class="gprop"><span class="gk">距离</span><span class="gv mono">{{ entity.light.distance }}</span></div>
        </template>
        <div class="ginsp-desc">
          以上为场景实时属性参照。把操作节点连到本卡片（目标引脚），即可定义预览运行时作用于该实体的行为；
          「设置属性」可引用 position/rotation/scale 各分量与 visible。
        </div>
      </template>
    </template>

    <!-- 匹配 -->
    <template v-else-if="g?.kind === 'match'">
      <div class="ginsp-head">
        <span class="ginsp-dot" style="background: #c586c0"></span>
        <span class="ginsp-static">匹配</span>
      </div>
      <div class="ginsp-fields">
        <label class="gfield">
          <span class="gfield-label">模式</span>
          <select :value="g.matchMode" @change="commitMatch({ matchMode: ($event.target as HTMLSelectElement).value as 'tag' | 'type' })">
            <option value="tag">按标签</option>
            <option value="type">按类型</option>
          </select>
        </label>
        <label class="gfield">
          <span class="gfield-label">{{ g.matchMode === "type" ? "类型键" : "标签名" }}</span>
          <input
            :value="g.matchPattern"
            :list="`dl-pattern`"
            placeholder="运行时批量匹配"
            @change="commitMatch({ matchPattern: ($event.target as HTMLInputElement).value })"
          />
          <datalist id="dl-pattern">
            <option v-for="o in patternOptions" :key="o" :value="o" />
          </datalist>
        </label>
      </div>
      <div class="ginsp-hint">当前命中 {{ matched.length }} 个实体{{ matched.length ? `：${matched.slice(0, 4).map((m) => m.name).join(", ")}${matched.length > 4 ? " …" : ""}` : "" }}</div>
    </template>

    <!-- 操作 -->
    <template v-else-if="g?.kind === 'op' && def">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: def.color }"></span>
        <span class="ginsp-static">{{ def.label }}</span>
        <span class="ginsp-trigger">{{ G_OP_TRIGGER_LABEL[def.trigger] }}</span>
      </div>
      <div class="ginsp-fields">
        <label v-for="f in def.fields" :key="f.key" class="gfield">
          <span class="gfield-label">{{ f.label }}</span>
          <input
            v-if="f.kind === 'number'"
            type="number"
            :step="f.step ?? 0.1"
            :value="Number(g.params?.[f.key] ?? f.fallback)"
            @change="commitParam(f.key, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="f.kind === 'boolean'"
            type="checkbox"
            :checked="g.params?.[f.key] === true"
            @change="commitParam(f.key, ($event.target as HTMLInputElement).checked)"
          />
          <input
            v-else
            :value="String(g.params?.[f.key] ?? '')"
            :placeholder="f.placeholder ?? ''"
            @change="commitParam(f.key, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <div class="ginsp-desc">{{ def.desc }}。连接原型/匹配卡片到「目标」引脚决定作用对象；「执行」链可在应用时级联下游操作。行为在预览中执行。</div>
    </template>

    <!-- 注释框 -->
    <template v-else-if="c">
      <div class="ginsp-head"><span class="ginsp-dot" :style="{ background: c.color }"></span><span class="ginsp-static">注释框</span></div>
      <div class="ginsp-fields">
        <label class="gfield col">
          <span class="gfield-label">文本</span>
          <textarea rows="5" :value="c.text" @change="commitCommentText(($event.target as HTMLTextAreaElement).value)"></textarea>
        </label>
        <div class="gfield">
          <span class="gfield-label">颜色</span>
          <span class="gcolor-row">
            <button
              v-for="col in GRAPH_COMMENT_COLORS"
              :key="col"
              class="gcolor-dot"
              :class="{ active: c.color === col }"
              :style="{ background: col }"
              @click="commitCommentColor(col)"
            ></button>
          </span>
        </div>
      </div>
    </template>

    <!-- 未选中 -->
    <div v-else class="ginsp-empty">
      <div class="ginsp-hint">从左侧「层级」把实体拖入画布生成原型卡片；右键画布添加匹配与操作节点。</div>
      <div class="ginsp-hint">场景实体：{{ store.sceneEntities.length }} 个。对原型的操作是预览运行时执行的逻辑，不改动编辑器场景。</div>
    </div>
  </div>
</template>
