<script setup lang="ts">
/**
 * 行为树可视化编辑器（弹窗；.bt 资产）：
 * - SVG 画布：树自顶向下自动布局（子树宽度递归），滚轮缩放 /
 *   左键拖空白或中键任意处拖拽平移；右键为自定义菜单（弹窗内屏蔽浏览器默认菜单）；
 * - 右侧属性面板：根为空时选类型建根；选中节点显示类型说明 + 注册表字段表单，
 *   并给出「添加子节点」类型按钮（装饰 ≤1 子、叶子无子，按注册表校验）；
 * - 保存：改动防抖自动写盘 + Ctrl+S / 按钮手动保存，关闭前冲刷未保存改动。
 *   序列化经 parseBehaviorTree 收敛（api.behaviorTreeWrite，格式所有权在后端）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { getProjectStore } from "../../stores/project";
import { logStore } from "../../stores/log";
import { api } from "../../../lib/api";
import { closeBehaviorTreeEditor } from "../../composables/logic-editor";
import { useGraphCanvas } from "../../composables/graph-canvas";
import { isEditingText } from "../../commands/context";
import {
  closeContextMenu,
  ctxMenu,
  openContextMenu,
  type CtxMenuItem,
} from "../../../lib/editor/context-menu";
import "../../../styles/components/logic-editor.scss";
import {
  BT_NODE_DEFS,
  btCanAcceptChildren,
  btNodeDef,
  btNodeLabel,
  btNodeSummary,
  countBtNodes,
  findBtNode,
  findBtParent,
  nextBtId,
  parseBehaviorTree,
  removeBtNode,
  type BTConditionOp,
  type BTNode,
} from "../../../framework/behavior";

const props = defineProps<{ rel: string }>();

const projectStore = getProjectStore();

const CONDITION_OPS: BTConditionOp[] = [">", "<", ">=", "<=", "==", "!="];
/** 分类标签（面板分组用） */
const CATEGORY_LABELS: Record<string, string> = {
  composite: "组合",
  decorator: "装饰",
  leaf: "叶子",
};

/** 自动布局几何（画布逻辑坐标） */
const NODE_W = 150;
const NODE_H = 44;
const LEVEL_H = 104;
const SIBLING_GAP = 26;

const svgEl = ref<SVGSVGElement | null>(null);
const { view, transform, resetView, bindWheel } = useGraphCanvas(svgEl);

const loading = ref(true);
const loadError = ref("");
const tree = ref<BTNode | null>(null);
const dirty = ref(false);
const saving = ref(false);
const selectedId = ref<string | null>(null);

const title = computed(() => props.rel.split("/").pop() ?? props.rel);
const selectedNode = computed(() => (selectedId.value ? findBtNode(tree.value, selectedId.value) : null));
const selectedDef = computed(() => (selectedNode.value ? btNodeDef(selectedNode.value.type) : null));
const selectedParent = computed(() =>
  selectedId.value ? findBtParent(tree.value, selectedId.value) : null,
);

// —— 装载 / 保存 ——

async function load(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  try {
    const text = await api.readText(root, props.rel);
    const doc = JSON.parse(text) as { tree?: unknown };
    tree.value = parseBehaviorTree(doc.tree);
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !tree.value || saving.value) return;
  saving.value = true;
  try {
    const name = title.value.replace(/\.bt$/i, "");
    await api.behaviorTreeWrite(
      root,
      props.rel,
      name,
      JSON.parse(JSON.stringify(tree.value)) as Record<string, unknown>,
    );
    dirty.value = false;
    logStore.log("success", `已保存行为树: ${props.rel}`);
  } catch (e) {
    logStore.log("error", `保存行为树失败: ${e}`);
  } finally {
    saving.value = false;
  }
}

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
function markDirty(): void {
  dirty.value = true;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => void save(), 800);
}

async function requestClose(): Promise<void> {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (dirty.value && tree.value) await save();
  closeBehaviorTreeEditor();
}

// —— 自动布局（自顶向下：子树宽度递归，父居中于子集） ——

interface BtLayout {
  nodes: { node: BTNode; x: number; y: number; def: ReturnType<typeof btNodeDef> }[];
  edges: { d: string }[];
}

const layout = computed<BtLayout>(() => {
  const root = tree.value;
  const out: BtLayout = { nodes: [], edges: [] };
  if (!root) return out;
  const widths = new Map<string, number>();
  const pos = new Map<string, { x: number; y: number }>();

  function widthOf(n: BTNode): number {
    if (!n.children.length) {
      widths.set(n.id, NODE_W);
      return NODE_W;
    }
    let s = 0;
    for (const c of n.children) s += widthOf(c) + SIBLING_GAP;
    const w = Math.max(NODE_W, s - SIBLING_GAP);
    widths.set(n.id, w);
    return w;
  }
  widthOf(root);

  function place(n: BTNode, left: number, depth: number): void {
    const w = widths.get(n.id) ?? NODE_W;
    pos.set(n.id, { x: left + w / 2, y: depth * LEVEL_H + NODE_H / 2 });
    if (!n.children.length) return;
    let childTotal = -SIBLING_GAP;
    for (const c of n.children) childTotal += (widths.get(c.id) ?? NODE_W) + SIBLING_GAP;
    let cx = left + (w - childTotal) / 2;
    for (const c of n.children) {
      place(c, cx, depth + 1);
      cx += (widths.get(c.id) ?? NODE_W) + SIBLING_GAP;
    }
  }
  place(root, 40, 0);

  for (const n of walkAll(root)) {
    const p = pos.get(n.id)!;
    out.nodes.push({ node: n, x: p.x, y: p.y, def: btNodeDef(n.type) });
    for (const c of n.children) {
      const cp = pos.get(c.id)!;
      const midY = (p.y + NODE_H / 2 + (cp.y - NODE_H / 2)) / 2;
      out.edges.push({
        d: `M ${p.x.toFixed(1)} ${(p.y + NODE_H / 2).toFixed(1)} C ${p.x.toFixed(1)} ${midY.toFixed(1)}, ${cp.x.toFixed(1)} ${midY.toFixed(1)}, ${cp.x.toFixed(1)} ${(cp.y - NODE_H / 2).toFixed(1)}`,
      });
    }
  }
  return out;
});

function walkAll(root: BTNode): BTNode[] {
  const out: BTNode[] = [];
  const walk = (n: BTNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

// —— 画布交互（平移；节点无拖拽，布局自动） ——

let panning: { startClientX: number; startClientY: number; startViewX: number; startViewY: number } | null =
  null;

function isBgTarget(e: Event): boolean {
  const t = e.target as HTMLElement | SVGElement | null;
  return !t || t === svgEl.value || t.dataset?.bg === "1";
}

/** 从指针按下处开始平移（move 中按起点绝对定位 view，避免增量累加漂移） */
function startPan(e: PointerEvent): void {
  panning = {
    startClientX: e.clientX,
    startClientY: e.clientY,
    startViewX: view.x,
    startViewY: view.y,
  };
}

function onSvgPointerDown(e: PointerEvent): void {
  // 中键：任意位置（含节点上）拖拽平移；preventDefault 阻止自动滚动
  if (e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0 || !isBgTarget(e)) return;
  selectedId.value = null;
  startPan(e);
}

function onNodePointerDown(e: PointerEvent, n: BTNode): void {
  if (e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  selectedId.value = n.id;
}

function onPointerMove(e: PointerEvent): void {
  const p = panning;
  if (!p) return;
  // 绝对定位：起点视图 + 指针相对起点的位移（不可用增量累加，否则漂移）
  view.x = p.startViewX + (e.clientX - p.startClientX);
  view.y = p.startViewY + (e.clientY - p.startClientY);
}

function onPointerUp(): void {
  panning = null;
}

// —— 右键菜单（屏蔽浏览器默认菜单，按目标给出编辑动作） ——

function onBgContext(e: MouseEvent): void {
  openContextMenu(e, [{ label: "重置视图", onClick: resetView }]);
}

function onNodeContext(e: MouseEvent, n: BTNode): void {
  selectedId.value = n.id;
  const items: CtxMenuItem[] = [];
  if (btCanAcceptChildren(n)) {
    items.push({
      label: "添加子节点",
      children: BT_NODE_DEFS.map((d) => ({ label: d.label, onClick: () => addChild(d.type) })),
    });
  }
  if (findBtParent(tree.value, n.id)) {
    items.push({
      label: "选中父节点",
      onClick: () => {
        selectedId.value = findBtParent(tree.value, n.id)?.id ?? null;
      },
    });
  }
  items.push({ separator: true });
  items.push({ label: "删除节点", danger: true, shortcut: "Del", onClick: deleteSelected });
  openContextMenu(e, items);
}

// —— 树编辑 ——

function createRoot(type: string): void {
  const def = btNodeDef(type);
  if (!def) return;
  tree.value = { id: nextBtId(null), type, children: [], ...defaultsOf(def) };
  selectedId.value = tree.value.id;
  markDirty();
}

function addChild(type: string): void {
  const parent = selectedNode.value;
  if (!parent || !btCanAcceptChildren(parent)) return;
  const def = btNodeDef(type);
  if (!def) return;
  parent.children.push({ id: nextBtId(tree.value), type, children: [], ...defaultsOf(def) });
  selectedId.value = parent.children[parent.children.length - 1].id;
  markDirty();
}

/** 按注册表字段缺省值构造节点初始字段 */
function defaultsOf(def: NonNullable<ReturnType<typeof btNodeDef>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) out[f.key] = f.fallback;
  return out;
}

function deleteSelected(): void {
  if (!tree.value || !selectedId.value) return;
  if (selectedId.value === tree.value.id) {
    tree.value = null;
  } else {
    tree.value = removeBtNode(tree.value, selectedId.value);
  }
  selectedId.value = null;
  markDirty();
}

// —— 键盘 ——

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (ctxMenu.open) {
      closeContextMenu();
      return;
    }
    void requestClose();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    e.stopPropagation();
    void save();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !isEditingText()) {
    e.preventDefault();
    deleteSelected();
  }
}

let unbindWheel: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  await load();
  // svg 在 loading 结束后才渲染，等一帧再绑 wheel，避免绑到空引用
  await nextTick();
  unbindWheel = bindWheel();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  if (unbindWheel) unbindWheel();
});
</script>

<template>
  <Teleport to="body">
    <div class="logic-modal-backdrop" @contextmenu.prevent>
      <div class="logic-modal">
        <div class="logic-modal-head">
          <span class="logic-modal-title">行为树编辑器 · {{ title }}</span>
          <span v-if="dirty" class="logic-modal-dirty">未保存</span>
          <span class="logic-modal-rel mono">{{ rel }}</span>
          <button
            class="logic-modal-btn primary"
            :disabled="saving || !dirty"
            :title="dirty ? '保存（Ctrl+S）' : '无改动'"
            @click="save"
          >
            {{ saving ? "保存中…" : "保存" }}
          </button>
          <button class="logic-modal-close" title="关闭（Esc）" @click="requestClose">✕</button>
        </div>

        <div class="logic-toolbar">
          <button
            class="logic-modal-btn danger"
            :disabled="!selectedNode"
            title="删除选中节点（连同其子树）"
            @click="deleteSelected"
          >
            删除选中
          </button>
          <button class="logic-modal-btn" title="重置平移与缩放" @click="resetView">重置视图</button>
          <span class="logic-tool-hint">点击节点选中 · 左键拖空白 / 中键拖拽平移 · 滚轮缩放 · 右键菜单 · Del 删除</span>
        </div>

        <div class="logic-modal-body">
          <div v-if="loading" class="logic-empty">读取中…</div>
          <div v-else-if="!tree" class="logic-empty">读取失败：{{ loadError }}</div>
          <template v-else>
            <div class="logic-canvas-wrap">
              <svg
                ref="svgEl"
                class="logic-canvas"
                @pointerdown="onSvgPointerDown"
                @contextmenu.prevent="onBgContext"
              >
                <defs>
                  <pattern
                    id="bt-grid"
                    width="24"
                    height="24"
                    patternUnits="userSpaceOnUse"
                    :patternTransform="`translate(${view.x},${view.y}) scale(${view.k})`"
                  >
                    <circle cx="1" cy="1" r="1" fill="#2c2c2c" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#bt-grid)" data-bg="1" />
                <g :transform="transform">
                  <path v-for="(e, i) in layout.edges" :key="i" class="logic-bt-edge" :d="e.d" />
                  <g
                    v-for="n in layout.nodes"
                    :key="n.node.id"
                    class="logic-bt-card"
                    :class="{ selected: selectedId === n.node.id }"
                    :transform="`translate(${n.x - NODE_W / 2},${n.y - NODE_H / 2})`"
                    @pointerdown.stop="onNodePointerDown($event, n.node)"
                    @contextmenu.prevent.stop="onNodeContext($event, n.node)"
                  >
                    <rect
                      class="logic-bt-box"
                      :width="NODE_W"
                      :height="NODE_H"
                      rx="8"
                      :stroke="n.def?.color ?? '#555'"
                    />
                    <rect
                      class="logic-bt-band"
                      :width="5"
                      :height="NODE_H - 2"
                      x="1"
                      y="1"
                      rx="2"
                      :fill="n.def?.color ?? '#888'"
                    />
                    <text class="logic-bt-title" :x="14" y="19">{{ btNodeLabel(n.node) }}</text>
                    <text class="logic-bt-summary" :x="14" y="35">{{ btNodeSummary(n.node) }}</text>
                  </g>
                </g>
              </svg>
            </div>

            <div class="logic-props">
              <!-- 无树：先建根 -->
              <template v-if="!tree">
                <div class="logic-props-section">
                  <span class="logic-props-title">根节点类型</span>
                  <div class="logic-type-grid">
                    <button
                      v-for="d in BT_NODE_DEFS"
                      :key="d.type"
                      class="logic-type-btn"
                      :style="{ '--type-color': d.color }"
                      @click="createRoot(d.type)"
                    >
                      <span class="logic-type-btn-label">{{ d.label }}</span>
                      <span class="logic-type-btn-desc">{{ d.desc }}</span>
                    </button>
                  </div>
                </div>
              </template>

              <!-- 选中节点：面包屑 + 字段 + 子节点 -->
              <template v-else-if="selectedNode && selectedDef">
                <div class="logic-props-section">
                  <span class="logic-props-title">选中节点</span>
                  <div class="logic-field">
                    <label>名称</label>
                    <input
                      class="logic-input"
                      :value="selectedNode.name ?? ''"
                      :placeholder="selectedDef.label"
                      @change="selectedNode.name = ($event.target as HTMLInputElement).value || undefined; markDirty()"
                    />
                  </div>
                  <span class="logic-hint">
                    <span class="logic-badge">{{ CATEGORY_LABELS[selectedDef.category] }}</span>
                    {{ selectedDef.label }} — {{ selectedDef.desc }}
                  </span>
                </div>

                <div v-if="selectedDef.fields.length" class="logic-props-section">
                  <span class="logic-props-title">参数</span>
                  <template v-for="f in selectedDef.fields" :key="f.key">
                    <div v-if="f.kind === 'number'" class="logic-field">
                      <label>{{ f.label }}</label>
                      <input
                        v-model.number="selectedNode[f.key]"
                        type="number"
                        :min="f.min"
                        :step="f.step"
                        class="logic-input"
                        @change="markDirty"
                      />
                    </div>
                    <div v-else-if="f.kind === 'option'" class="logic-field">
                      <label>{{ f.label }}</label>
                      <select v-model="selectedNode[f.key]" class="logic-input" @change="markDirty">
                        <option v-for="op in f.options ?? CONDITION_OPS" :key="op" :value="op">{{ op }}</option>
                      </select>
                    </div>
                    <div v-else class="logic-field">
                      <label>{{ f.label }}</label>
                      <input v-model="selectedNode[f.key]" class="logic-input mono" @change="markDirty" />
                    </div>
                  </template>
                </div>

                <div class="logic-props-section">
                  <span class="logic-props-title">
                    子节点（{{ selectedNode.children.length }}{{ selectedDef.maxChildren < 0 ? "" : `/${selectedDef.maxChildren}` }}）
                  </span>
                  <button
                    v-if="selectedParent"
                    class="logic-modal-btn"
                    @click="selectedId = selectedParent.id; markDirty()"
                  >
                    选中父节点
                  </button>
                  <div v-if="btCanAcceptChildren(selectedNode)" class="logic-type-grid">
                    <button
                      v-for="d in BT_NODE_DEFS"
                      :key="d.type"
                      class="logic-type-btn"
                      :style="{ '--type-color': d.color }"
                      @click="addChild(d.type)"
                    >
                      <span class="logic-type-btn-label">{{ d.label }}</span>
                      <span class="logic-type-btn-desc">{{ d.desc }}</span>
                    </button>
                  </div>
                  <span v-else class="logic-hint">
                    {{ selectedDef.maxChildren === 0 ? "叶子节点没有子节点" : "该类型子节点已满" }}
                  </span>
                </div>

                <div class="logic-props-section">
                  <span class="logic-hint">
                    删除节点会连同其子树一起移除；running 状态在运行时从上次运行的子节点恢复。
                  </span>
                </div>
              </template>

              <!-- 有树未选中 -->
              <template v-else>
                <div class="logic-props-section">
                  <span class="logic-props-title">行为树概览</span>
                  <div class="logic-stat"><span>节点数</span><span class="mono">{{ countBtNodes(tree) }}</span></div>
                  <div class="logic-stat">
                    <span>根节点</span><span class="mono">{{ tree.type }}</span>
                  </div>
                </div>
                <div class="logic-props-section">
                  <span class="logic-hint">
                    点击画布中的节点编辑属性；组合节点可挂多个子节点，装饰节点至多一个，
                    叶子节点（等待/条件/动作）为执行终点。
                  </span>
                </div>
              </template>
            </div>
          </template>
        </div>

        <div class="logic-modal-foot">
          行为树资产（.bt）：根节点自顶向下自动布局。求值为三值语义（成功/失败/运行中），
          顺序节点在子节点运行中时会从该子节点恢复；动作节点在运行时按动作名交由脚本处理器执行。
        </div>
      </div>
    </div>
  </Teleport>
</template>
