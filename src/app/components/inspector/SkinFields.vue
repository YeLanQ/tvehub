<script setup lang="ts">
/**
 * 皮肤调试面板（Animation 卡片内嵌，source=model 且含骨骼/形态键时挂载）：
 * 复刻 three 官网 animation/skinning 系列示例的 GUI 交互——
 * - 骨骼树 + 搜索（骨骼/IK）+ 本地变换编辑 + 复位（含显示骨骼辅助线开关）；
 * - 形态键权重滑块（morph 示例的表情滑块模式）；
 * - 动作权重滑块 + 加法层 + 一次性播放（blending/additive/morph 示例模式）；
 * - IK 链启停/移除（脚本 addIK 注册后的运行态展示）；
 * - 骨骼/IK 目标绑定（attachToBone：把场景节点绑到骨骼或 IK 目标上跟随）。
 * 布局为可折叠卡片分组；全部为运行时调试控制（不落盘），数值经 engine.animation 直接生效。
 */
import { computed, ref, watch } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import { parseBoneBindings, type BoneBindingSpec } from "../../../framework/animation";
import { dispatchCommand } from "../../commands";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: MeshNode; rev?: number; clips: string[] }>();

const editorStore = getEditorStore();
const engine = editorStore.engine;

/** 蒙皮能力摘要（随 animation:changed 的 rev 刷新；模型实例未就绪为 null） */
const skin = computed(() => {
  void props.rev;
  return engine.animation.skinInfoOf(props.node.id);
});
const hierarchy = computed(() => {
  void props.rev;
  return engine.animation.boneHierarchy(props.node.id) ?? [];
});
const morphs = computed(() => {
  void props.rev;
  return engine.animation.morphsOf(props.node.id) ?? [];
});
const iks = computed(() => {
  void props.rev;
  return engine.animation.iksOf(props.node.id) ?? [];
});
const attachments = computed(() => {
  void props.rev;
  return engine.animation.attachmentsOf(props.node.id) ?? [];
});

// —— 折叠区状态 ——
const openBones = ref(true);
const openMorphs = ref(false);
const openWeights = ref(false);
const openIk = ref(false);
const openBind = ref(false);

// —— 骨骼树 ——
const expanded = ref(new Set<string>());
const selectedBone = ref<string | null>(null);

watch(
  hierarchy,
  (h) => {
    // 骨架重建（模型重载/实例重绑）后默认展开根骨骼；选中失效则清空
    const set = new Set<string>();
    for (const e of h) if (!e.parent) set.add(e.name);
    expanded.value = set;
    if (selectedBone.value && !h.some((e) => e.name === selectedBone.value)) {
      selectedBone.value = null;
    }
  },
  { immediate: true },
);

interface BoneRow {
  name: string;
  depth: number;
  hasChildren: boolean;
}

/** 展开态下的扁平行（DFS；骨架规模有限，O(n²) 过滤可接受） */
const boneRows = computed<BoneRow[]>(() => {
  const out: BoneRow[] = [];
  const known = new Set(hierarchy.value.map((e) => e.name));
  const visit = (parent: string | null, depth: number) => {
    for (const e of hierarchy.value) {
      const p = e.parent && known.has(e.parent) ? e.parent : null;
      if (p !== parent) continue;
      out.push({ name: e.name, depth, hasChildren: e.children.length > 0 });
      if (expanded.value.has(e.name)) visit(e.name, depth + 1);
    }
  };
  visit(null, 0);
  return out;
});

function toggleExpand(name: string): void {
  const set = new Set(expanded.value);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  expanded.value = set;
}

function selectBone(name: string): void {
  selectedBone.value = name;
}

// —— 骨骼/IK 搜索（大小写不敏感子串；命中骨骼平铺 + 命中 IK 单列）——
const boneQuery = ref("");
const searchBones = computed<string[]>(() => {
  const q = boneQuery.value.trim().toLowerCase();
  if (!q) return [];
  return hierarchy.value.filter((e) => e.name.toLowerCase().includes(q)).map((e) => e.name);
});
const searchIks = computed(() => {
  const q = boneQuery.value.trim().toLowerCase();
  if (!q) return [];
  return iks.value.filter(
    (ik) => ik.id.toLowerCase().includes(q) || ik.name.toLowerCase().includes(q),
  );
});

/** 搜索命中 IK：直接设为绑定下拉的目标（骨骼命中则走树选中联动） */
function selectSearchIK(id: string): void {
  attachBone.value = id;
}

// —— 选中骨骼的本地变换编辑（rotation 度制）——
const boneTf = ref({ px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

/** 显示清洗：近零值归零、6 位有效数字（避免 1e-7 之类的长尾数值撑爆输入框） */
function tidy(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) < 1e-4) return 0;
  return parseFloat(v.toPrecision(6));
}

function refreshBoneTf(): void {
  const t = selectedBone.value
    ? engine.animation.getBoneTransform(props.node.id, selectedBone.value)
    : null;
  if (t) {
    boneTf.value = {
      px: t.position.x,
      py: t.position.y,
      pz: t.position.z,
      rx: t.rotation.x,
      ry: t.rotation.y,
      rz: t.rotation.z,
      sx: t.scale.x,
      sy: t.scale.y,
      sz: t.scale.z,
    };
  }
}

watch([selectedBone, () => props.rev], refreshBoneTf, { immediate: true });

function commitTf(part: "position" | "rotation" | "scale", axis: number, v: number): void {
  const name = selectedBone.value;
  if (!name) return;
  const t = boneTf.value;
  const id = props.node.id;
  if (part === "position") {
    if (axis === 0) t.px = v;
    else if (axis === 1) t.py = v;
    else t.pz = v;
    engine.animation.setBonePosition(id, name, t.px, t.py, t.pz);
  } else if (part === "rotation") {
    if (axis === 0) t.rx = v;
    else if (axis === 1) t.ry = v;
    else t.rz = v;
    engine.animation.setBoneRotation(id, name, t.rx, t.ry, t.rz);
  } else {
    if (axis === 0) t.sx = v;
    else if (axis === 1) t.sy = v;
    else t.sz = v;
    engine.animation.setBoneScale(id, name, t.sx, t.sy, t.sz);
  }
}

// —— 显示骨骼 / 复位 ——
const showBones = ref(false);
watch(showBones, (v) => engine.animation.setBoneHelperVisible(props.node.id, v));

function resetSelected(): void {
  if (selectedBone.value) engine.animation.resetBone(props.node.id, selectedBone.value);
  refreshBoneTf();
}

function resetAll(): void {
  engine.animation.resetPose(props.node.id);
  refreshBoneTf();
}

// —— 形态键 ——
function morphVal(mesh: string, target: string): number {
  return engine.animation.getMorphWeight(props.node.id, mesh, target) ?? 0;
}

// 拖动草稿（滑块显示层）：权重/形态键读的是引擎运行时值（非响应式），拖动中
// Vue 不重渲染，自定义填充轨道（--fill）需要本地草稿驱动才能实时跟随。
// 键 = clip 或 mesh\0target；换节点重置（草稿属于当前模型的调试会话）。
const weightDraft = ref<Record<string, number>>({});
const morphDraft = ref<Record<string, number>>({});
watch(
  () => props.node.id,
  () => {
    weightDraft.value = {};
    morphDraft.value = {};
  },
);

function displayWeight(clip: string): number {
  const d = weightDraft.value[clip];
  return typeof d === "number" ? d : weightOf(clip);
}
function displayMorph(mesh: string, target: string): number {
  const d = morphDraft.value[`${mesh}\u0000${target}`];
  return typeof d === "number" ? d : morphVal(mesh, target);
}

function onMorph(mesh: string, target: string, e: Event): void {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  morphDraft.value[`${mesh}\u0000${target}`] = v;
  engine.animation.setMorphWeight(props.node.id, mesh, target, v);
}

// —— 动作权重 / 加法层 / 一次性 ——
function weightOf(clip: string): number {
  return engine.animation.getWeight(props.node.id, clip) ?? 0;
}

function onWeight(clip: string, e: Event): void {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  weightDraft.value[clip] = v;
  engine.animation.setWeight(props.node.id, clip, v);
}

/** 加法层开关（面板本地状态；对应官方 additive 示例的叠加权重滑块） */
const additiveOn = ref(new Set<string>());

function onAdditive(clip: string, e: Event): void {
  const on = (e.target as HTMLInputElement).checked;
  const set = new Set(additiveOn.value);
  if (on) {
    engine.animation.playAdditive(props.node.id, clip, weightOf(clip) || 1);
    set.add(clip);
  } else {
    engine.animation.stopAdditive(props.node.id, clip);
    set.delete(clip);
  }
  additiveOn.value = set;
}

function onOneShot(clip: string): void {
  engine.animation.playOneShot(props.node.id, clip, 0.25);
}

// —— IK ——
function onIKEnabled(id: string, e: Event): void {
  engine.animation.setIKEnabled(props.node.id, id, (e.target as HTMLInputElement).checked);
}

function onIKRemove(id: string): void {
  engine.animation.removeIK(props.node.id, id);
}

// —— 骨骼/IK 目标绑定（attachToBone）——
/** 可绑定的场景节点（模型节点自身与其子树排除：目标须在模型之外） */
const bindableNodes = computed(() => {
  void props.rev;
  const graph = engine.graph;
  const excluded = new Set<string>([props.node.id]);
  const collectDesc = (id: string) => {
    for (const c of graph.childrenOf(id)) {
      excluded.add(c.id);
      collectDesc(c.id);
    }
  };
  collectDesc(props.node.id);
  return graph
    .all()
    .filter((n) => !excluded.has(n.id))
    .map((n) => ({ id: n.id, name: n.name || n.id }));
});

/** 绑定骨骼下拉：全部骨骼 + IK（id 寻址） */
const boneNames = computed(() => skin.value?.boneNames ?? []);
const attachBoneOptions = computed(() => [
  ...boneNames.value.map((n) => ({ value: n, label: n })),
  ...iks.value.map((ik) => ({ value: ik.id, label: `IK: ${ik.name || ik.id}` })),
]);

const attachTarget = ref("");
const attachBone = ref("");
const attachKeepOffset = ref(true);
const attachSyncRotation = ref(true);

/** 骨骼树选中 → 绑定下拉联动（IK 选择不反向联动） */
watch(selectedBone, (v) => {
  if (v) attachBone.value = v;
});

const targetNameOf = computed(() => {
  const map = new Map(bindableNodes.value.map((n) => [n.id, n.name]));
  return (id: string) => map.get(id) ?? id;
});

// —— 绑定数据写入（node.boneBindings 随场景持久化；经 node.patch 进撤销历史）——
function writeBindings(mutate: (list: BoneBindingSpec[]) => void): void {
  const n = props.node;
  const before = n.toJSON();
  const list = parseBoneBindings(n.boneBindings);
  mutate(list);
  n.boneBindings = list;
  const after = n.toJSON();
  void dispatchCommand("node.patch", { id: n.id, before, after, label: "Set Bone Bindings" });
}

function addBinding(): void {
  if (!attachTarget.value || !attachBone.value) return;
  const target = attachTarget.value;
  const bone = attachBone.value;
  writeBindings((list) => {
    // 同目标重复绑定 = 改绑（先移除旧条目）
    const i = list.findIndex((b) => b.target === target);
    if (i >= 0) list.splice(i, 1);
    list.push({
      target,
      bone,
      keepOffset: attachKeepOffset.value,
      syncRotation: attachSyncRotation.value,
      syncScale: false,
    });
  });
}

function removeBinding(targetNodeId: string): void {
  writeBindings((list) => {
    const i = list.findIndex((b) => b.target === targetNodeId);
    if (i >= 0) list.splice(i, 1);
  });
}
</script>

<template>
  <div class="skin-fields" :data-rev="rev">
    <div v-if="!skin" class="hint">模型实例未就绪（骨骼信息随实例建立）…</div>
    <template v-else>
      <!-- 骨骼卡片 -->
      <section v-if="hierarchy.length > 0" class="skin-card">
        <div class="card-header">
          <button class="card-toggle" @click="openBones = !openBones">
            <span class="arrow">{{ openBones ? "▾" : "▸" }}</span>
            <span>骨骼</span>
            <span class="count">{{ hierarchy.length }}</span>
          </button>
          <div class="header-tools">
            <label class="skin-toggle" title="强制显示骨骼辅助线（不必选中节点）" @click.stop>
              <input v-model="showBones" type="checkbox" />
              <span>显示骨骼</span>
            </label>
            <button class="skin-btn sm" title="全部骨骼复位到加载姿势" @click="resetAll">复位姿势</button>
          </div>
        </div>
        <div v-if="openBones" class="card-body">
          <input
            v-model="boneQuery"
            class="skin-search"
            placeholder="查找骨骼 / IK…"
            spellcheck="false"
            @click.stop
          />
          <!-- 搜索命中：骨骼平铺 + IK 单列（点击 IK 直接设为绑定目标） -->
          <div v-if="boneQuery.trim()" class="bone-tree">
            <div
              v-for="name in searchBones"
              :key="name"
              class="bone-row"
              :class="{ selected: name === selectedBone }"
              @click="selectBone(name)"
            >
              <span class="bone-name" :title="name">{{ name }}</span>
            </div>
            <div
              v-for="ik in searchIks"
              :key="ik.id"
              class="bone-row ik-hit"
              :title="`${ik.id} → ${ik.effector}`"
              @click="selectSearchIK(ik.id)"
            >
              <span class="bone-name">IK: {{ ik.name || ik.id }}（{{ ik.effector }}）</span>
            </div>
            <div v-if="!searchBones.length && !searchIks.length" class="hint">无匹配骨骼 / IK</div>
          </div>
          <!-- 常规树 -->
          <div v-else class="bone-tree">
            <div
              v-for="row in boneRows"
              :key="row.name"
              class="bone-row"
              :class="{ selected: row.name === selectedBone }"
              :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
              @click="selectBone(row.name)"
            >
              <span
                class="arrow"
                :class="{ ghost: !row.hasChildren }"
                @click.stop="row.hasChildren && toggleExpand(row.name)"
              >{{ row.hasChildren ? (expanded.has(row.name) ? "▾" : "▸") : "·" }}</span>
              <span class="bone-name" :title="row.name">{{ row.name }}</span>
            </div>
          </div>
          <div v-if="selectedBone" class="bone-edit">
            <div class="bone-edit-head">
              <span class="bone-chip mono" :title="selectedBone">{{ selectedBone }}</span>
              <button class="skin-btn sm" @click="resetSelected">复位</button>
            </div>
            <div class="tf-grid">
              <span class="tf-label">位移</span>
              <NumberField :model-value="tidy(boneTf.px)" :step="0.01" @commit="(v) => commitTf('position', 0, v)" />
              <NumberField :model-value="tidy(boneTf.py)" :step="0.01" @commit="(v) => commitTf('position', 1, v)" />
              <NumberField :model-value="tidy(boneTf.pz)" :step="0.01" @commit="(v) => commitTf('position', 2, v)" />
              <span class="tf-label">旋转°</span>
              <NumberField :model-value="tidy(boneTf.rx)" :step="0.5" @commit="(v) => commitTf('rotation', 0, v)" />
              <NumberField :model-value="tidy(boneTf.ry)" :step="0.5" @commit="(v) => commitTf('rotation', 1, v)" />
              <NumberField :model-value="tidy(boneTf.rz)" :step="0.5" @commit="(v) => commitTf('rotation', 2, v)" />
              <span class="tf-label">缩放</span>
              <NumberField :model-value="tidy(boneTf.sx)" :step="0.01" @commit="(v) => commitTf('scale', 0, v)" />
              <NumberField :model-value="tidy(boneTf.sy)" :step="0.01" @commit="(v) => commitTf('scale', 1, v)" />
              <NumberField :model-value="tidy(boneTf.sz)" :step="0.01" @commit="(v) => commitTf('scale', 2, v)" />
            </div>
          </div>
        </div>
      </section>

      <!-- 形态键卡片 -->
      <section v-if="morphs.length > 0" class="skin-card">
        <button class="card-toggle solo" @click="openMorphs = !openMorphs">
          <span class="arrow">{{ openMorphs ? "▾" : "▸" }}</span>
          <span>形态键</span>
          <span class="count">{{ morphs.length }} 网格</span>
        </button>
        <div v-if="openMorphs" class="card-body">
          <div v-for="group in morphs" :key="group.mesh" class="morph-group">
            <div class="morph-mesh mono">{{ group.mesh }}</div>
            <div v-for="target in group.targets" :key="target" class="morph-row">
              <span class="morph-name" :title="target">{{ target }}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :style="{ '--fill': `${(displayMorph(group.mesh, target) * 100).toFixed(2)}%` }"
                :value="displayMorph(group.mesh, target)"
                @input="onMorph(group.mesh, target, $event)"
              />
              <span class="morph-val mono">{{ displayMorph(group.mesh, target).toFixed(2) }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 动作权重卡片 -->
      <section v-if="clips.length > 0" class="skin-card">
        <button class="card-toggle solo" @click="openWeights = !openWeights">
          <span class="arrow">{{ openWeights ? "▾" : "▸" }}</span>
          <span>动作权重</span>
          <span class="count">{{ clips.length }}</span>
        </button>
        <div v-if="openWeights" class="card-body">
          <div v-for="clip in clips" :key="clip" class="weight-row">
            <div class="weight-top">
              <span class="morph-name" :title="clip">{{ clip }}</span>
              <label class="skin-toggle" title="以加法混合层叠加播放（差值叠加在基础动作上）" @click.stop>
                <input type="checkbox" :checked="additiveOn.has(clip)" @change="onAdditive(clip, $event)" />
                <span>加法</span>
              </label>
              <button class="skin-btn sm" title="一次性播放（定格末帧后自动回落）" @click="onOneShot(clip)">1×</button>
            </div>
            <div class="slider-row">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :style="{ '--fill': `${(displayWeight(clip) * 100).toFixed(2)}%` }"
                :value="displayWeight(clip)"
                @input="onWeight(clip, $event)"
              />
              <span class="morph-val mono">{{ displayWeight(clip).toFixed(2) }}</span>
            </div>
          </div>
          <div class="hint">拖动滑块叠加混合多个动作 · 加法=差值叠加 · 1×=播完自动回落</div>
        </div>
      </section>

      <!-- IK 卡片 -->
      <section v-if="iks.length > 0" class="skin-card">
        <button class="card-toggle solo" @click="openIk = !openIk">
          <span class="arrow">{{ openIk ? "▾" : "▸" }}</span>
          <span>IK</span>
          <span class="count">{{ iks.length }}</span>
        </button>
        <div v-if="openIk" class="card-body">
          <div v-for="ik in iks" :key="ik.id" class="list-row">
            <label class="skin-toggle" @click.stop>
              <input type="checkbox" :checked="ik.enabled" @change="onIKEnabled(ik.id, $event)" />
              <span class="mono" :title="`${ik.id} → ${ik.effector}`">{{ ik.name }}</span>
            </label>
            <button class="skin-btn sm" title="移除该 IK" @click="onIKRemove(ik.id)">✕</button>
          </div>
        </div>
      </section>

      <!-- 绑定卡片 -->
      <section v-if="boneNames.length > 0 || iks.length > 0" class="skin-card">
        <button class="card-toggle solo" @click="openBind = !openBind">
          <span class="arrow">{{ openBind ? "▾" : "▸" }}</span>
          <span>绑定</span>
          <span class="count">{{ attachments.length }}</span>
        </button>
        <div v-if="openBind" class="card-body">
          <div class="attach-grid">
            <select v-model="attachTarget" class="attach-select" title="要绑定的场景节点（模型子树外）">
              <option value="" disabled>选择节点…</option>
              <option v-for="n in bindableNodes" :key="n.id" :value="n.id">{{ n.name }}</option>
            </select>
            <select v-model="attachBone" class="attach-select" title="骨骼 / IK 目标">
              <option value="" disabled>骨骼 / IK…</option>
              <option v-for="opt in attachBoneOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div class="attach-opts">
            <label class="skin-toggle" title="保持绑定时刻的相对位姿；关闭则对象原点对齐骨骼原点" @click.stop>
              <input v-model="attachKeepOffset" type="checkbox" />
              <span>保持偏移</span>
            </label>
            <label class="skin-toggle" title="跟随骨骼旋转；关闭则仅位置跟随" @click.stop>
              <input v-model="attachSyncRotation" type="checkbox" />
              <span>跟随旋转</span>
            </label>
            <button
              class="skin-btn add-btn"
              :disabled="!attachTarget || !attachBone"
              title="把节点绑到骨骼/IK 目标上（每帧跟随）"
              @click="addBinding"
            >添加绑定</button>
          </div>
          <div v-for="at in attachments" :key="at.node" class="list-row bound">
            <span
              class="morph-name"
              :title="`${targetNameOf(at.node)} → ${at.bone}（${at.syncRotation ? '跟随旋转' : '仅位置'}${at.keepOffset ? '' : '，原点对齐'}）`"
            >{{ targetNameOf(at.node) }} → <span class="mono">{{ at.bone }}</span></span>
            <button class="skin-btn sm" title="解除绑定" @click="removeBinding(at.node)">✕</button>
          </div>
          <div v-if="attachments.length > 0" class="hint">绑定随场景保存，预览/发布同样生效。</div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.skin-fields {
  border-top: 1px solid var(--border, #333);
  margin-top: 6px;
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* —— 卡片分组 —— */
.skin-card {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  background: var(--panel-deep, #17171c);
  overflow: hidden;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 8px 4px 2px;
}
.card-toggle {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: var(--text, #ddd);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  padding: 3px 6px;
  cursor: pointer;
  min-width: 0;
}
.card-toggle.solo {
  width: 100%;
  box-sizing: border-box;
}
.card-toggle .arrow {
  font-size: 9px;
  width: 10px;
  flex: none;
  color: var(--text-dim, #999);
}
.card-toggle .count {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-dim, #999);
}
.header-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.card-body {
  padding: 2px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border, #333);
}

/* —— 通用控件 —— */
.skin-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 2px 0;
  white-space: nowrap;
}
.skin-btn {
  font-size: 11px;
  line-height: 1.2;
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
  white-space: nowrap;
}
.skin-btn:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.skin-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.skin-btn.sm {
  padding: 1px 6px;
  font-size: 10px;
}
.mono {
  font-family: var(--mono, monospace);
}
.hint {
  font-size: 10px;
  color: var(--text-dim, #999);
  padding: 1px 0;
}

/* —— 骨骼树 —— */
.skin-search {
  width: 100%;
  box-sizing: border-box;
  font-size: 11px;
  padding: 3px 6px;
  border: 1px solid var(--border, #333);
  border-radius: 3px;
  background: var(--input-bg, #1b1b22);
  color: var(--text, #ddd);
}
.skin-search:focus {
  outline: none;
  border-color: var(--accent, #4a9eff);
}
.bone-tree {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--border, #333);
  border-radius: 3px;
}
.bone-row {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 1px 4px;
  white-space: nowrap;
}
.bone-row:hover {
  background: var(--hover, #ffffff14);
}
.bone-row.selected {
  background: var(--accent-dim, #4a9eff33);
  color: var(--accent, #4a9eff);
}
.bone-row .arrow {
  width: 10px;
  flex: none;
  text-align: center;
  color: var(--text-dim, #999);
}
.bone-row .arrow.ghost {
  visibility: hidden;
}
.bone-row.ik-hit .bone-name {
  color: var(--accent, #4a9eff);
}
.bone-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 骨骼变换编辑 —— */
.bone-edit {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bone-edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.bone-chip {
  font-size: 10px;
  color: var(--accent, #4a9eff);
  background: var(--accent-dim, #4a9eff26);
  border-radius: 3px;
  padding: 2px 6px;
  max-width: 75%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tf-grid {
  display: grid;
  grid-template-columns: 30px 1fr 1fr 1fr;
  gap: 3px;
  align-items: center;
}
.tf-grid :deep(.nf-input) {
  font-size: 10px;
  padding: 2px 3px;
  text-align: right;
}
.tf-label {
  font-size: 10px;
  color: var(--text-dim, #999);
}

/* —— 形态键 / 权重滑块 —— */
.morph-group {
  padding: 1px 0;
}
.morph-mesh {
  font-size: 10px;
  color: var(--text-dim, #999);
  padding: 2px 0;
}
.morph-row {
  display: grid;
  grid-template-columns: minmax(50px, 40%) 1fr 30px;
  gap: 6px;
  align-items: center;
  padding: 1px 0;
}
.slider-row {
  display: grid;
  grid-template-columns: 1fr 30px;
  gap: 6px;
  align-items: center;
}
.morph-name {
  font-size: 11px;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.morph-val {
  font-size: 10px;
  color: var(--text-dim, #999);
  text-align: right;
}
/* 自绘填充轨道：原生 accent-color 的填充止于滑块中心，1.0 时右端留约
   半个滑块宽的空隙；改用 --fill（0~100%）驱动渐变，拉满即满格 */
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 14px;
  background: transparent;
  cursor: pointer;
}
input[type="range"]::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--accent, #4a9eff) 0%,
    var(--accent, #4a9eff) var(--fill, 0%),
    var(--border, #3a3a44) var(--fill, 0%),
    var(--border, #3a3a44) 100%
  );
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px; /* 居中于 4px 轨道：(4 - 12) / 2 */
  border-radius: 50%;
  background: var(--accent, #4a9eff);
  border: none;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 35%);
}
.weight-row {
  padding: 2px 0;
  border-bottom: 1px dashed var(--border, #333);
}
.weight-row:last-of-type {
  border-bottom: none;
}
.weight-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.weight-top .morph-name {
  flex: 1 1 auto;
}

/* —— IK / 绑定列表行 —— */
.list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  background: var(--hover, #ffffff0a);
}
.attach-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.attach-select {
  width: 100%;
  box-sizing: border-box;
  font-size: 11px;
  padding: 3px 4px;
  border: 1px solid var(--border, #333);
  border-radius: 3px;
  background: var(--input-bg, #1b1b22);
  color: var(--text, #ddd);
  min-width: 0;
}
.attach-opts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.add-btn {
  margin-left: auto;
}
</style>
