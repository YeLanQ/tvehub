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
  G_COMPARE_OPERATORS,
  G_OP_TRIGGER_LABEL,
  G_PROPERTY_PATHS,
  GRAPH_COMMENT_COLORS,
  graphOpDef,
  isContainerType,
  nodeTypeDef,
  type GComment,
  type GNode,
} from "../../framework/graph";
import type { SceneEntity } from "../lib/scene-index";
import { ENTITY_BASE_PATHS, entityPropPaths, mergePropPaths } from "../lib/prop-paths";
import ComboBox from "../../ui-kit/components/ComboBox.vue";

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

const def = computed(() =>
  g.value?.type.startsWith("op.")
    ? graphOpDef(g.value.opType ?? g.value.type) ?? nodeTypeDef(g.value.type)
    : g.value?.type === "entity.prop"
      ? nodeTypeDef(g.value.type)
      : null,
);
const eventDef = computed(() => (g.value?.type.startsWith("event.") ? nodeTypeDef(g.value.type) : null));
const varDef = computed(() => (g.value?.type.startsWith("var.") ? nodeTypeDef(g.value.type) : null));
const flowDef = computed(() => (g.value?.type.startsWith("flow.") ? nodeTypeDef(g.value.type) : null));
const mathDef = computed(() => (g.value?.type.startsWith("math.") ? nodeTypeDef(g.value.type) : null));
const customDef = computed(() => (g.value?.type.startsWith("custom.") ? nodeTypeDef(g.value.type) : null));
/** 变量节点引用的图变量 */
const referencedVar = computed(() => {
  if (!g.value?.type.startsWith("var.")) return null;
  return store.graphVariables.find((v) => v.id === g.value?.varId) ?? null;
});
/** 原型对应的场景实体（实时属性参照） */
const entity = computed<SceneEntity | null>(() => {
  if (g.value?.type !== "entity.proto") return null;
  return store.sceneEntities.find((e) => e.id === g.value?.entityId) ?? null;
});

/** 匹配节点的实时命中 */
const matched = computed(() => {
  if (g.value?.type !== "entity.match") return [];
  const tagList = g.value.matchMode === "type"
    ? store.sceneEntities.filter((e) => e.type === (g.value?.matchPattern ?? ""))
    : store.sceneEntities.filter((e) => e.tag === (g.value?.matchPattern ?? ""));
  return tagList;
});

/** 模式串候选（场景中去重的标签 / 类型键） */
const patternOptions = computed(() => {
  if (g.value?.type !== "entity.match") return [];
  return [...new Set(store.sceneEntities.map((e) => (g.value?.matchMode === "type" ? e.type : e.tag)).filter(Boolean))];
});

const vecText = (v: { x: number; y: number; z: number }): string =>
  `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;

// ----- 属性路径候选（entity.prop / op.set 的「属性」输入） -----

/** 实体的类型定义能力（op/driver/container 透传判定） */
function passThroughSource(type: string): boolean {
  const caps = nodeTypeDef(type)?.capabilities;
  return caps?.op === true || caps?.driver === true || caps?.container === true;
}

/** 沿实体集通道上溯全部可能命中的场景实体（proto 精确 / match 命中 / op·driver·容器·forEach 透传 / 获取子级 = 子级集） */
function upstreamEntities(nodeId: string): SceneEntity[] {
  const doc = store.canvas?.serializeDoc();
  if (!doc) return [];
  const seenNodes = new Set<string>();
  const collect = (nid: string): SceneEntity[] => {
    if (seenNodes.has(nid)) return [];
    seenNodes.add(nid);
    const res: SceneEntity[] = [];
    const has = new Set<string>();
    const push = (e: SceneEntity): void => {
      if (has.has(e.id)) return;
      has.add(e.id);
      res.push(e);
    };
    for (const e of doc.edges) {
      if (e.dstNode !== nid) continue;
      const src = doc.nodes.find((n) => n.id === e.srcNode);
      if (!src || src.unresolved) continue;
      if (src.type === "entity.proto") {
        const ent = store.sceneEntities.find((x) => x.id === src.entityId);
        if (ent) push(ent);
      } else if (src.type === "entity.match") {
        for (const x of store.sceneEntities) {
          if (src.matchMode === "type" ? x.type === src.matchPattern : x.tag === src.matchPattern) push(x);
        }
      } else if (src.type === "op.children") {
        for (const u of collect(src.id)) {
          for (const c of store.sceneEntities) if (c.parentId === u.id) push(c);
        }
      } else if (passThroughSource(src.type) || src.type === "flow.forEach" || src.type === "entity.prop") {
        for (const u of collect(src.id)) push(u);
      }
    }
    return res;
  };
  return collect(nodeId);
}

/** 「属性」输入的路径候选：上游实体集可寻址属性并集（无上游时给基础分量） */
const propCandidates = computed<string[]>(() => {
  const t = g.value?.type;
  if (t !== "entity.prop" && t !== "op.set") return [];
  const ents = upstreamEntities(g.value?.id ?? "");
  if (!ents.length) {
    return t === "entity.prop" ? [...ENTITY_BASE_PATHS] : [...G_PROPERTY_PATHS];
  }
  return mergePropPaths(ents.map((e) => entityPropPaths(e))).slice(0, 400);
});

/** 上游候选对应实体名（下拉候选提示） */
const upstreamNames = computed<string>(() => {
  if (g.value?.type !== "entity.prop" && g.value?.type !== "op.set") return "";
  return upstreamEntities(g.value?.id ?? "")
    .slice(0, 4)
    .map((e) => e.name || e.id)
    .join(", ");
});

// ----- 操作参数提交 -----

function commitParam(key: string, raw: string | boolean): void {
  if (!g.value || (!g.value.type.startsWith("op.") && g.value.type !== "entity.prop")) return;
  const defV = def.value;
  if (!defV) return;
  const f = defV.fields?.find((x) => x.key === key);
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
  if (g.value?.type !== "entity.match") return;
  store.canvas?.requestSnapshot();
  if (patch.matchMode) g.value.matchMode = patch.matchMode;
  if (patch.matchPattern !== undefined) g.value.matchPattern = patch.matchPattern;
  store.markGraphDirty();
}

// ----- 变量节点参数提交 -----

function commitVarId(varId: string): void {
  if (!g.value?.type.startsWith("var.")) return;
  store.canvas?.requestSnapshot();
  g.value.varId = varId || undefined;
  store.markGraphDirty();
}

// ----- 控制流参数提交 -----

function commitFlowParam(key: string, raw: string): void {
  if (!g.value?.type.startsWith("flow.")) return;
  store.canvas?.requestSnapshot();
  if (!g.value.params) g.value.params = {};
  if (key === "operator") g.value.params[key] = String(raw);
  else g.value.params[key] = Number(raw) || 0;
  store.markGraphDirty();
}

// ----- 自定义节点参数提交 -----

function commitCustomParam(key: string, raw: string | boolean): void {
  if (!g.value?.type.startsWith("custom.")) return;
  const defV = customDef.value;
  if (!defV) return;
  const f = defV.fields?.find((x) => x.key === key);
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

// ----- 逻辑容器（fsm.container / bt.container）参数与尺寸提交 -----

const logicDef = computed(() => (g.value && isContainerType(g.value.type) ? nodeTypeDef(g.value.type) : null));

function commitLogicField(key: string, raw: string): void {
  if (!g.value || !isContainerType(g.value.type)) return;
  store.canvas?.requestSnapshot();
  if (!g.value.params || typeof g.value.params !== "object") g.value.params = {};
  g.value.params[key] = String(raw).slice(0, 256);
  store.markGraphDirty();
}

function commitContainerSize(key: "w" | "h", raw: string): void {
  if (!g.value || !isContainerType(g.value.type)) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  store.canvas?.requestSnapshot();
  g.value[key] = Math.max(key === "w" ? 320 : 200, Math.min(key === "w" ? 2400 : 2000, Math.round(n)));
  store.markGraphDirty();
}

// ----- 容器内子节点的状态归属（所属容器为 FSM 时显示） -----

const childStateInfo = computed<{ states: string[] } | null>(() => {
  if (!g.value?.containerId || isContainerType(g.value.type)) return null;
  const parent = store.canvas?.serializeDoc()?.nodes.find((n) => n.id === g.value?.containerId);
  if (!parent || parent.type !== "fsm.container") return null;
  const states = (parent.params?.states ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { states };
});

function commitStateName(raw: string): void {
  if (!g.value) return;
  store.canvas?.requestSnapshot();
  const s = raw.trim();
  if (s) g.value.stateName = s.slice(0, 48);
  else delete g.value.stateName;
  store.markGraphDirty();
}
</script>

<template>
  <div class="ginspector">
    <!-- 容器内子节点：状态归属（所属容器为状态机时） -->
    <template v-if="g && childStateInfo">
      <div class="ginsp-section">状态归属</div>
      <label class="gfield">
        <span class="gfield-label">所属状态</span>
        <select :value="g.stateName ?? ''" @change="commitStateName(($event.target as HTMLSelectElement).value)">
          <option value="">任意状态</option>
          <option v-for="s in childStateInfo.states" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <div class="ginsp-hint">所属状态机容器激活该状态时，本节点的行为才会执行。</div>
    </template>

    <!-- 逻辑容器（状态机容器 / 行为树容器） -->
    <template v-else-if="g && logicDef">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: logicDef.color }"></span>
        <span class="ginsp-static">{{ logicDef.label }}</span>
      </div>
      <div class="ginsp-fields">
        <label v-for="f in logicDef.fields ?? []" :key="f.key" class="gfield">
          <span class="gfield-label">{{ f.label }}</span>
          <input
            :value="String(g.params?.[f.key] ?? f.fallback)"
            :placeholder="f.placeholder ?? ''"
            @change="commitLogicField(f.key, ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="gfield">
          <span class="gfield-label">宽度</span>
          <input type="number" :value="g.w ?? 560" step="20" @change="commitContainerSize('w', ($event.target as HTMLInputElement).value)" />
        </label>
        <label class="gfield">
          <span class="gfield-label">高度</span>
          <input type="number" :value="g.h ?? 340" step="20" @change="commitContainerSize('h', ($event.target as HTMLInputElement).value)" />
        </label>
      </div>
      <div class="ginsp-desc">{{ logicDef.desc }}。</div>
      <div class="ginsp-hint">拖入节点到容器框内即归属（可嵌套）；容器内节点的「状态归属」在检查器顶部设置。行为在预览中执行，状态切换/进入均有引擎日志（预览控制台可查）。</div>
    </template>

    <!-- 原型：实体实时属性参照 -->
    <template v-if="g?.type === 'entity.proto'">
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
          「设置属性」与「属性读取」按点分路径寻址实体自身属性：变换各分量、visible、light/material 分量、
          userData 与脚本 @property（script:脚本路径:属性）；子级属性需先用「获取子级」换作用对象（配 ForEach 按序索引）。
        </div>
      </template>
    </template>

    <!-- 匹配 -->
    <template v-else-if="g?.type === 'entity.match'">
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
          <ComboBox
            :model-value="g.matchPattern ?? ''"
            :options="patternOptions"
            placeholder="运行时批量匹配"
            @update:model-value="commitMatch({ matchPattern: String($event) })"
          />
        </label>
      </div>
      <div class="ginsp-hint">当前命中 {{ matched.length }} 个实体{{ matched.length ? `：${matched.slice(0, 4).map((m) => m.name).join(", ")}${matched.length > 4 ? " …" : ""}` : "" }}</div>
    </template>

    <!-- 属性读取（entity.prop）：属性路径 + 候选 -->
    <template v-else-if="g?.type === 'entity.prop' && def">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: def.color }"></span>
        <span class="ginsp-static">{{ def.label }}</span>
      </div>
      <div class="ginsp-fields">
        <label v-for="f in def.fields" :key="f.key" class="gfield col">
          <span class="gfield-label">{{ f.label }}</span>
          <ComboBox
            :model-value="String(g.params?.[f.key] ?? f.fallback)"
            :options="propCandidates"
            :placeholder="f.placeholder ?? ''"
            @update:model-value="commitParam(f.key, String($event))"
          />
        </label>
      </div>
      <div class="ginsp-desc">{{ def.desc }}。变换分量（旋转为度制）、可见性、灯光/材质分量、userData 与脚本 @property（script:脚本路径:属性）均可读取——只寻址实体自身属性；要读子级属性，先经「获取子级」（配 ForEach 按序索引）把目标换成子级。</div>
      <div v-if="upstreamNames" class="ginsp-hint">候选来自上游接入的实体：{{ upstreamNames }}…</div>
      <div v-else class="ginsp-hint">纯数据节点：把原型/匹配（或 ForEach「当前」）连到「实体」入引脚，「值」引脚连到下游数据入引脚（分支条件/运算节点等），拉取时实时读取。</div>
    </template>

    <!-- 获取子级（op.children）：实体集变换卡（无参数） -->
    <template v-else-if="g?.type === 'op.children' && def">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: def.color }"></span>
        <span class="ginsp-static">{{ def.label }}</span>
      </div>
      <div class="ginsp-desc">{{ def.desc }}。内部子对象（网格烘焙/包装子树）不属于场景层级，不会出现在结果中。</div>
      <div class="ginsp-hint">实体集变换卡（无执行引脚）：「目标」接原型/匹配/操作透传/ForEach「当前」，「输出」把子级实体集接任意操作「目标」、ForEach「集合」或属性读取「实体」引脚；深层子级再串一张本卡。</div>
    </template>

    <!-- 操作 -->
    <template v-else-if="g?.type.startsWith('op.') && def">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: def.color }"></span>
        <span class="ginsp-static">{{ def.label }}</span>
        <span class="ginsp-trigger">{{ def.trigger ? G_OP_TRIGGER_LABEL[def.trigger] : "" }}</span>
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
          <ComboBox
            v-else-if="f.key === 'property'"
            :model-value="String(g.params?.[f.key] ?? '')"
            :options="propCandidates"
            :placeholder="f.placeholder ?? ''"
            @update:model-value="commitParam(f.key, String($event))"
          />
          <input
            v-else
            :value="String(g.params?.[f.key] ?? '')"
            :placeholder="f.placeholder ?? ''"
            @change="commitParam(f.key, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <div v-if="g.type === 'op.set' && upstreamNames" class="ginsp-hint">候选来自上游接入的实体：{{ upstreamNames }}…（脚本属性用「script:路径:属性」；子级先经「获取子级」/ForEach 换目标）</div>
      <div class="ginsp-desc">{{ def.desc }}。连接原型/匹配卡片到「目标」引脚决定作用对象；「执行」链可在应用时级联下游操作。行为在预览中执行。</div>
    </template>

    <!-- 事件节点 -->
    <template v-else-if="g?.type.startsWith('event.') && eventDef">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: eventDef.color }"></span>
        <span class="ginsp-static">{{ eventDef.label }}</span>
        <span class="ginsp-trigger">{{ eventDef.trigger ? G_OP_TRIGGER_LABEL[eventDef.trigger] : "" }}</span>
      </div>
      <div class="ginsp-desc">{{ eventDef.desc }}</div>
      <div class="ginsp-hint">从「执行」引脚连线到操作节点的「执行」入引脚，构成执行链。事件触发时沿链级联执行。</div>
    </template>

    <!-- 变量节点 -->
    <template v-else-if="g?.type.startsWith('var.') && varDef">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: varDef.color }"></span>
        <span class="ginsp-static">{{ varDef.label }}</span>
        <span class="ginsp-trigger">{{ referencedVar ? referencedVar.dataType : "未绑定" }}</span>
      </div>
      <div class="ginsp-fields">
        <label class="gfield">
          <span class="gfield-label">变量</span>
          <select :value="g.varId ?? ''" @change="commitVarId(($event.target as HTMLSelectElement).value)">
            <option value="">— 未绑定 —</option>
            <option v-for="v in store.graphVariables" :key="v.id" :value="v.id">
              {{ v.name }}（{{ v.dataType }}）
            </option>
          </select>
        </label>
      </div>
      <div class="ginsp-desc">{{ varDef.desc }}</div>
      <template v-if="g.type === 'var.get'">
        <div class="ginsp-hint">纯数据节点：从「值」引脚连线到下游数据入引脚。值在拉取时从图变量读取。</div>
      </template>
      <template v-else>
        <div class="ginsp-hint">执行链节点：从「值」入引脚拉取数据写入变量，沿「执行」出引脚级联下游。</div>
      </template>
    </template>

    <!-- 控制流节点 -->
    <template v-else-if="g?.type.startsWith('flow.') && flowDef">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: flowDef.color }"></span>
        <span class="ginsp-static">{{ flowDef.label }}</span>
      </div>
      <div class="ginsp-fields">
        <!-- Compare: 运算符选择 -->
        <label v-if="g.type === 'flow.compare'" class="gfield">
          <span class="gfield-label">运算</span>
          <select :value="String(g.params?.operator ?? '>')" @change="commitFlowParam('operator', ($event.target as HTMLSelectElement).value)">
            <option v-for="op in G_COMPARE_OPERATORS" :key="op" :value="op">{{ op }}</option>
          </select>
        </label>
        <!-- For: start/end/step -->
        <template v-if="g.type === 'flow.for'">
          <label class="gfield">
            <span class="gfield-label">起始</span>
            <input type="number" step="1" :value="Number(g.params?.start ?? 0)" @change="commitFlowParam('start', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="gfield">
            <span class="gfield-label">结束</span>
            <input type="number" step="1" :value="Number(g.params?.end ?? 10)" @change="commitFlowParam('end', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="gfield">
            <span class="gfield-label">步长</span>
            <input type="number" step="1" :value="Number(g.params?.step ?? 1)" @change="commitFlowParam('step', ($event.target as HTMLInputElement).value)" />
          </label>
        </template>
      </div>
      <div class="ginsp-desc">{{ flowDef.desc }}</div>
      <div v-if="g.type === 'flow.compare'" class="ginsp-hint">纯数据节点：比较 A 与 B，结果从「结果」引脚输出。连到 Branch 的「条件」引脚做条件分支。</div>
      <div v-else-if="g.type === 'flow.branch'" class="ginsp-hint">条件为真走「真」分支，否则走「假」分支。条件从数据入引脚拉取（可连 Compare 结果或 var.get）。</div>
      <div v-else-if="g.type === 'flow.for'" class="ginsp-hint">从起始到结束步进，每次触发「循环」分支。「索引」引脚输出当前迭代值。结束后走「完成」分支。</div>
      <div v-else-if="g.type === 'flow.forEach'" class="ginsp-hint">遍历实体集，每次触发「循环」分支。「当前」引脚输出当前实体。结束后走「完成」分支。</div>
      <div v-else-if="g.type === 'flow.while'" class="ginsp-hint">条件为真时循环触发「循环」分支。条件为假或达到上限（10000）后走「完成」分支。</div>
    </template>

    <!-- 数学/工具节点 -->
    <template v-else-if="g?.type.startsWith('math.') && mathDef">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: mathDef.color }"></span>
        <span class="ginsp-static">{{ mathDef.label }}</span>
      </div>
      <div class="ginsp-desc">{{ mathDef.desc }}</div>
      <div class="ginsp-hint">纯数据节点：从输入引脚拉取数据，计算结果从输出引脚输出。连线到下游数据入引脚驱动求值。</div>
    </template>

    <!-- 自定义节点 -->
    <template v-else-if="g?.type.startsWith('custom.') && customDef">
      <div class="ginsp-head">
        <span class="ginsp-dot" :style="{ background: customDef.color }"></span>
        <span class="ginsp-static">{{ customDef.label }}</span>
      </div>
      <div v-if="customDef.desc" class="ginsp-desc">{{ customDef.desc }}</div>
      <div v-if="customDef.fields?.length" class="ginsp-fields">
        <label v-for="f in customDef.fields" :key="f.key" class="gfield">
          <span class="gfield-label">{{ f.label }}</span>
          <input
            v-if="f.kind === 'number'"
            type="number"
            :step="0.1"
            :value="Number(g.params?.[f.key] ?? f.fallback)"
            @change="commitCustomParam(f.key, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="f.kind === 'boolean'"
            type="checkbox"
            :checked="g.params?.[f.key] === true"
            @change="commitCustomParam(f.key, ($event.target as HTMLInputElement).checked)"
          />
          <input
            v-else
            :value="String(g.params?.[f.key] ?? '')"
            @change="commitCustomParam(f.key, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <div class="ginsp-hint">自定义节点：从输入引脚拉取数据，按用户定义的表达式求值，结果从输出引脚输出。在「自定义节点」面板编辑定义。</div>
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
