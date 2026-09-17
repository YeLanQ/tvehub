<script setup lang="ts">
/**
 * 场景图画布（Vue Flow 集成；会话工作板，编辑态以 Vue Flow 数组为权威）：
 * - 三类卡片：原型（层级拖入生成，实体集源）/ 匹配（标签|类型筛选，实体集源）/
 *   操作（原子行为，预览运行时由 graph-behaviors 解释执行）+ 注释框；
 * - 双通道连线：实体集（原型/匹配 out → 操作 in，决定作用对象，操作 out 可透传
 *   串联共用目标集）与执行链（op next → op exec，单入）；连线按通道配色；
 * - 层级面板行可直接拖入画布生成原型（dragstart/drop，同实体去重）；
 * - 会话级 undo/redo 快照栈 + 剪贴板（id 重映射）+ 右键菜单；
 * - 图会话经 store 自动持久化到场景侧车（.tve 旁路，用户不感知文件）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  MarkerType,
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type GraphNode,
  type Node,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import GraphProtoCard from "./GraphProtoCard.vue";
import GraphMatchCard from "./GraphMatchCard.vue";
import GraphOpCard from "./GraphOpCard.vue";
import GraphEventCard from "./GraphEventCard.vue";
import GraphVarCard from "./GraphVarCard.vue";
import GraphFlowCard from "./GraphFlowCard.vue";
import GraphMathCard from "./GraphMathCard.vue";
import GraphCustomCard from "./GraphCustomCard.vue";
import GraphCommentBox from "./GraphCommentBox.vue";
import { getGraphWindowStore } from "../graphStore";
import { openContextMenu, type CtxMenuItem } from "../../lib/editor/context-menu";
import {
  canConnectPorts,
  graphNodeLabel,
  graphOpDefaults,
  graphOpDef,
  graphPort,
  GRAPH_DEFAULT_COMMENT_COLOR,
  GRAPH_OP_DEFS,
  G_OP_TRIGGER_LABEL,
  nodeMenuGroups,

  normalizeGraphDoc,
  type GComment,
  type GNode,
  type ScriptGraphDoc,
} from "../../framework/graph";

const store = getGraphWindowStore();

const {
  nodes,
  edges,
  setNodes,
  setEdges,
  addNodes,
  addEdges,
  removeNodes,
  removeEdges,
  findNode,
  getSelectedNodes,
  getSelectedEdges,
  screenToFlowCoordinate,
  fitView,
  onConnect,
  onNodeDragStart,
  onPaneContextMenu,
  onNodeContextMenu,
  onEdgeContextMenu,
} = useVueFlow();

const wrapRef = ref<HTMLElement | null>(null);
let lastMouse: { x: number; y: number } | null = null;

// ---------------------------------------------------------------------------
// 模型 ↔ 画布互转
// ---------------------------------------------------------------------------

/** GNode.type → Vue Flow 节点类型 */
function flowNodeType(type: string): string {
  if (type === "entity.proto") return "gproto";
  if (type === "entity.match") return "gmatch";
  if (type.startsWith("op.")) return "gop";
  if (type.startsWith("event.")) return "gevent";
  if (type.startsWith("var.")) return "gvar";
  if (type.startsWith("flow.")) return "gflow";
  if (type.startsWith("math.")) return "gmath";
  if (type.startsWith("custom.")) return "gcustom";
  return "gcomment";
}

function toFlowNode(n: GNode): Node {
  return { id: n.id, type: flowNodeType(n.type), position: { x: n.x, y: n.y }, data: { g: n } };
}

function toFlowComment(c: GComment): Node {
  return { id: c.id, type: "gcomment", position: { x: c.x, y: c.y }, data: { c } };
}

/** 通道 → 连线样式：执行链白线+箭头；实体集绿色细线；数据引脚青色细线 */
function makeEdge(srcNode: string, srcPort: string, dstNode: string, dstPort: string, id: string): Edge {
  const base: Edge = { id, source: srcNode, sourceHandle: srcPort, target: dstNode, targetHandle: dstPort };
  if (srcPort === "next") {
    return {
      ...base,
      style: { stroke: "#f2f2f2", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#f2f2f2", width: 18, height: 18 },
    };
  }
  if (srcPort === "value") {
    return {
      ...base,
      style: { stroke: "#88c0d0", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#88c0d0", width: 16, height: 16 },
    };
  }
  return { ...base, style: { stroke: "#6a9955", strokeWidth: 1.5 } };
}

function serializeDoc(): ScriptGraphDoc | null {
  const list = nodes.value;
  if (!list) return null;
  const doc: ScriptGraphDoc = { nodes: [], edges: [], comments: [], variables: store.graphVariables, customNodes: store.graphCustomNodes };
  for (const n of list) {
    if (n.type === "gcomment") {
      const c = n.data?.c as GComment | undefined;
      if (!c) continue;
      const st = typeof n.style === "object" ? n.style : undefined;
      doc.comments.push({
        id: n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        w: Math.round(numberOr(parseFloat(String(st?.width ?? "")), n.dimensions?.width ?? c.w)),
        h: Math.round(numberOr(parseFloat(String(st?.height ?? "")), n.dimensions?.height ?? c.h)),
        text: c.text,
        color: c.color,
      });
      continue;
    }
    const g = n.data?.g as GNode | undefined;
    if (!g) continue;
    doc.nodes.push(JSON.parse(JSON.stringify({ ...g, x: Math.round(n.position.x), y: Math.round(n.position.y) })));
  }
  for (const e of edges.value) {
    doc.edges.push({
      id: e.id,
      srcNode: e.source,
      srcPort: e.sourceHandle ?? "",
      dstNode: e.target,
      dstPort: e.targetHandle ?? "",
    });
  }
  return doc;
}

function numberOr(v: number, fb: number): number {
  return Number.isFinite(v) && v > 0 ? v : fb;
}

async function loadDoc(doc: ScriptGraphDoc, opts: { fit?: boolean } = {}): Promise<void> {
  const cards = doc.nodes.map(toFlowNode);
  const comments = doc.comments.map(toFlowComment);
  setNodes([...comments, ...cards]); // 注释框在前：渲染顺序垫底
  setEdges(doc.edges.map((e) => makeEdge(e.srcNode, e.srcPort, e.dstNode, e.dstPort, e.id)));
  store.setSelection(null, false);
  if (opts.fit !== false) {
    await nextTick();
    void fitView({ padding: 0.25, maxZoom: 1.5, duration: 150 });
  }
}

// ---------------------------------------------------------------------------
// undo / redo（会话快照栈；场景数据不被图修改，无需进后端历史栈）
// ---------------------------------------------------------------------------

const undoStack: string[] = [];
const redoStack: string[] = [];
const UNDO_LIMIT = 100;

function requestSnapshot(): void {
  const doc = serializeDoc();
  if (!doc) return;
  undoStack.push(JSON.stringify(doc));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function undo(): void {
  const cur = serializeDoc();
  const prev = undoStack.pop();
  if (!cur || !prev) return;
  redoStack.push(JSON.stringify(cur));
  void loadDoc(normalizeGraphDoc(JSON.parse(prev)), { fit: false });
}

function redo(): void {
  const cur = serializeDoc();
  const next = redoStack.pop();
  if (!cur || !next) return;
  undoStack.push(JSON.stringify(cur));
  void loadDoc(normalizeGraphDoc(JSON.parse(next)), { fit: false });
}

// ---------------------------------------------------------------------------
// id 生成 / 坐标锚点
// ---------------------------------------------------------------------------

function uniqueNodeId(): string {
  const used = new Set(nodes.value.filter((n) => n.type !== "gcomment").map((n) => n.id));
  let i = used.size + 1;
  let id = `n${i}`;
  while (used.has(id)) id = `n${++i}`;
  return id;
}

function uniqueEdgeId(): string {
  const used = new Set(edges.value.map((e) => e.id));
  let i = used.size + 1;
  let id = `e${i}`;
  while (used.has(id)) id = `e${++i}`;
  return id;
}

function uniqueCommentId(): string {
  const used = new Set(nodes.value.filter((n) => n.type === "gcomment").map((n) => n.id));
  let i = used.size + 1;
  let id = `c${i}`;
  while (used.has(id)) id = `c${++i}`;
  return id;
}

/** 鼠标当前位置（画布逻辑坐标；无鼠标记录取视口中心） */
function mouseFlow(): { x: number; y: number } {
  if (lastMouse) return screenToFlowCoordinate({ x: lastMouse.x, y: lastMouse.y });
  const el = wrapRef.value;
  if (el) {
    const r = el.getBoundingClientRect();
    return screenToFlowCoordinate({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }
  return { x: 0, y: 0 };
}

function putNode(n: GNode): void {
  addNodes([toFlowNode(n)]);
  store.markGraphDirty();
}

// ---------------------------------------------------------------------------
// 建卡（原型/匹配/操作/注释框）/ 删除 / 剪贴板
// ---------------------------------------------------------------------------

/** 层级拖入/双击加入：按实体生成原型（同实体已有原型则不重复） */
function addProto(entityId: string, at?: { x: number; y: number }): void {
  if (!entityId) return;
  if (nodes.value.some((n) => n.type === "gproto" && (n.data?.g as GNode)?.entityId === entityId)) {
    store.showToast("该实体已在图中");
    return;
  }
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: "entity.proto", x: Math.round(pos.x), y: Math.round(pos.y), entityId };
  putNode(n);
}

function addMatch(mode: "tag" | "type", at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = {
    id: uniqueNodeId(),
    type: "entity.match",
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    matchMode: mode,
    matchPattern: "",
  };
  putNode(n);
}

function addOp(opType: string, at?: { x: number; y: number }): void {
  if (!graphOpDef(opType)) return;
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = {
    id: uniqueNodeId(),
    type: opType,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    opType,
    params: graphOpDefaults(opType),
  };
  putNode(n);
}

/** 添加事件节点（执行链入口） */
function addEvent(eventType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: eventType, x: Math.round(pos.x), y: Math.round(pos.y) };
  putNode(n);
}

/** 添加变量节点（var.get / var.set） */
function addVarNode(varType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: varType, x: Math.round(pos.x), y: Math.round(pos.y) };
  putNode(n);
}

/** 添加控制流节点（flow.branch/compare/for/forEach/while） */
function addFlowNode(flowType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: flowType, x: Math.round(pos.x), y: Math.round(pos.y) };
  if (flowType === "flow.compare") n.params = { operator: ">" };
  if (flowType === "flow.for") n.params = { start: 0, end: 10, step: 1 };
  putNode(n);
}

/** 添加数学/工具节点（math.add/sub/.../vec3Make/...） */
function addMathNode(mathType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: mathType, x: Math.round(pos.x), y: Math.round(pos.y) };
  putNode(n);
}

/** 添加自定义节点（custom.xxx） */
function addCustomNode(customType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: customType, x: Math.round(pos.x), y: Math.round(pos.y) };
  putNode(n);
}

function addComment(at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const c: GComment = {
    id: uniqueCommentId(),
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    w: 240,
    h: 140,
    text: "",
    color: GRAPH_DEFAULT_COMMENT_COLOR,
  };
  addNodes([toFlowComment(c)]);
  store.markGraphDirty();
}

function deleteSelection(): void {
  const sel = getSelectedNodes.value;
  const selEdges = getSelectedEdges.value;
  if (!sel.length && !selEdges.length) return;
  requestSnapshot();
  if (sel.length) removeNodes(sel);
  if (selEdges.length) removeEdges(selEdges);
  store.setSelection(null, false);
  store.markGraphDirty();
}

interface ClipData {
  nodes: Pick<Node, "type" | "data">[];
  edges: { srcNode: string; srcPort: string; dstNode: string; dstPort: string }[];
}
let clip: ClipData | null = null;

function copySelection(): void {
  const sel = getSelectedNodes.value;
  if (!sel.length) return;
  const ids = new Set(sel.map((n) => n.id));
  clip = {
    nodes: sel.map((n) => ({ type: n.type, data: JSON.parse(JSON.stringify(n.data)) })),
    edges: edges.value
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({
        srcNode: e.source,
        srcPort: e.sourceHandle ?? "",
        dstNode: e.target,
        dstPort: e.targetHandle ?? "",
      })),
  };
}

function paste(at?: { x: number; y: number }): void {
  if (!clip || !clip.nodes.length) return;
  requestSnapshot();
  const refs = clip.nodes.map((n) => (n.data?.g ?? n.data?.c) as { x: number; y: number });
  const minX = Math.min(...refs.map((p) => p.x));
  const minY = Math.min(...refs.map((p) => p.y));
  const maxX = Math.max(...refs.map((p) => p.x));
  const maxY = Math.max(...refs.map((p) => p.y));
  const anchor = at ?? mouseFlow();
  const dx = Math.round(anchor.x - (minX + (maxX - minX) / 2));
  const dy = Math.round(anchor.y - (minY + (maxY - minY) / 2));

  const idMap = new Map<string, string>();
  const newNodes: Node[] = clip.nodes.map((n) => {
    const isCard = n.type !== "gcomment";
    const newId = isCard ? uniqueNodeId() : uniqueCommentId();
    if (n.type === "gcomment") {
      const c = n.data?.c as GComment;
      idMap.set(c.id, newId);
      return toFlowComment({ ...c, id: newId, x: c.x + dx, y: c.y + dy });
    }
    const g = n.data?.g as GNode;
    idMap.set(g.id, newId);
    return toFlowNode({ ...JSON.parse(JSON.stringify(g)), id: newId, x: g.x + dx, y: g.y + dy });
  });
  const newEdges: Edge[] = clip.edges
    .filter((e) => idMap.has(e.srcNode) && idMap.has(e.dstNode))
    .map((e) => makeEdge(idMap.get(e.srcNode)!, e.srcPort, idMap.get(e.dstNode)!, e.dstPort, uniqueEdgeId()));
  addNodes(newNodes);
  if (newEdges.length) addEdges(newEdges);
  store.markGraphDirty();
}

// ---------------------------------------------------------------------------
// 连线（通道校验 + 入端口替换）
// ---------------------------------------------------------------------------

function checkConnection(conn: Connection): boolean {
  if (!conn.source || !conn.target || conn.source === conn.target) return false;
  const sg = findNode(conn.source)?.data?.g as GNode | undefined;
  const dg = findNode(conn.target)?.data?.g as GNode | undefined;
  if (!sg || !dg) return false;
  const sp = graphPort(sg, conn.sourceHandle ?? "", "out");
  const dp = graphPort(dg, conn.targetHandle ?? "", "in");
  if (!sp || !dp) return false;
  return canConnectPorts(sp, dp);
}

onConnect((params) => {
  if (!params.source || !params.target) return;
  requestSnapshot();
  // 入端口唯一：替换已有入线（拖到已占用的入引脚 = 重新连接）
  const occupied = edges.value.filter(
    (e) => e.target === params.target && e.targetHandle === params.targetHandle,
  );
  if (occupied.length) removeEdges(occupied);
  addEdges([makeEdge(params.source, params.sourceHandle ?? "", params.target, params.targetHandle ?? "", uniqueEdgeId())]);
  store.markGraphDirty();
});

// ---------------------------------------------------------------------------
// 选区 / 拖拽 / 层级拖入 / 右键菜单
// ---------------------------------------------------------------------------

watch(getSelectedNodes, (sel: GraphNode[]) => {
  if (sel.length === 1 && sel[0].type !== "gcomment") {
    store.setSelection(sel[0].id, false);
  } else if (sel.length === 1 && sel[0].type === "gcomment") {
    store.setSelection(sel[0].id, true);
  } else {
    store.setSelection(null, false);
  }
});

onNodeDragStart(() => requestSnapshot());

/** 层级面板拖入：dragover 需 preventDefault 才允许 drop */
function onDragOver(e: DragEvent): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function onDrop(e: DragEvent): void {
  const entityId = e.dataTransfer?.getData("application/x-tve-entity") ?? "";
  if (!entityId) return;
  e.preventDefault();
  addProto(entityId, screenToFlowCoordinate({ x: e.clientX, y: e.clientY }));
}

/** 右键落点的画布坐标（菜单触发时记录，添加节点用它定位） */
let ctxFlowPos = { x: 0, y: 0 };

onPaneContextMenu((event) => {
  ctxFlowPos = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  const eventItems: CtxMenuItem[] = [
    { label: "On Begin（启动时）", onClick: () => addEvent("event.onBegin", ctxFlowPos) },
    { label: "On Tick（每帧）", onClick: () => addEvent("event.onTick", ctxFlowPos) },
    { label: "On Click（点击时）", onClick: () => addEvent("event.onClick", ctxFlowPos) },
  ];
  const varItems: CtxMenuItem[] = [
    { label: "Get 变量（读取）", onClick: () => addVarNode("var.get", ctxFlowPos) },
    { label: "Set 变量（写入）", onClick: () => addVarNode("var.set", ctxFlowPos) },
  ];
  const flowItems: CtxMenuItem[] = [
    { label: "分支（Branch）", onClick: () => addFlowNode("flow.branch", ctxFlowPos) },
    { label: "比较（Compare）", onClick: () => addFlowNode("flow.compare", ctxFlowPos) },
    { label: "For 循环", onClick: () => addFlowNode("flow.for", ctxFlowPos) },
    { label: "ForEach 循环", onClick: () => addFlowNode("flow.forEach", ctxFlowPos) },
    { label: "While 循环", onClick: () => addFlowNode("flow.while", ctxFlowPos) },
  ];
  const mathGroup = nodeMenuGroups().find((g) => g.category === "math");
  const mathItems: CtxMenuItem[] = (mathGroup?.items ?? []).map((d) => ({
    label: d.label,
    onClick: () => addMathNode(d.type, ctxFlowPos),
  }));
  const customGroup = nodeMenuGroups().find((g) => g.category === "custom");
  const customItems: CtxMenuItem[] = (customGroup?.items ?? []).map((d) => ({
    label: d.label,
    onClick: () => addCustomNode(d.type, ctxFlowPos),
  }));
  const opItems: CtxMenuItem[] = GRAPH_OP_DEFS.map((d) => ({
    label: `${d.label}（${G_OP_TRIGGER_LABEL[d.trigger]}）`,
    onClick: () => addOp(d.type, ctxFlowPos),
  }));
  const items: CtxMenuItem[] = [
    { label: "添加事件", children: eventItems },
    { label: "添加变量节点", children: varItems },
    { label: "添加控制流", children: flowItems },
    { label: "添加数学/工具", children: mathItems },
    ...(customItems.length ? [{ label: "添加自定义节点", children: customItems }] : []),
    { separator: true },
    { label: "添加原型", disabled: true },
    { label: "从左侧层级拖入实体生成原型", disabled: true },
    { separator: true },
    { label: "添加匹配（按标签）", onClick: () => addMatch("tag", ctxFlowPos) },
    { label: "添加匹配（按类型）", onClick: () => addMatch("type", ctxFlowPos) },
    { label: "添加操作", children: opItems },
    { separator: true },
    { label: "添加注释框", onClick: () => addComment(ctxFlowPos) },
    { label: "粘贴", disabled: !clip, onClick: () => paste(ctxFlowPos) },
    { separator: true },
    { label: "适配视图", onClick: () => void fitView({ padding: 0.25, maxZoom: 1.5, duration: 150 }) },
  ];
  openContextMenu(event, items);
});

onNodeContextMenu(({ event, node }) => {
  const items: CtxMenuItem[] = [];
  if (node.type !== "gcomment") {
    const g = node.data?.g as GNode;
    items.push({
      label: "重命名",
      onClick: async () => {
        const name = await store.askText("重命名", "显示名（留空恢复默认）", graphNodeLabel(g));
        if (name === null) return;
        requestSnapshot();
        g.title = name.trim() || undefined;
        store.markGraphDirty();
      },
    });
  }
  items.push(
    { label: "复制", onClick: () => copySelection() },
    { label: "删除", onClick: () => deleteSelection() },
  );
  openContextMenu(event as MouseEvent, items);
});

onEdgeContextMenu(({ event, edge }) => {
  openContextMenu(event as MouseEvent, [
    {
      label: "删除连线",
      onClick: () => {
        requestSnapshot();
        removeEdges([edge.id]);
        store.markGraphDirty();
      },
    },
  ]);
});

// ---------------------------------------------------------------------------
// 画布桥注册（工具栏/检查器/面板经 store.canvas 驱动）
// ---------------------------------------------------------------------------

onMounted(() => {
  const el = wrapRef.value;
  const onMouseMove = (e: MouseEvent): void => {
    lastMouse = { x: e.clientX, y: e.clientY };
  };
  el?.addEventListener("mousemove", onMouseMove);
  onBeforeUnmount(() => el?.removeEventListener("mousemove", onMouseMove));

  store.setCanvas({
    loadDoc: (doc) => void loadDoc(doc),
    serializeDoc: () => serializeDoc(),
    fitView: () => void fitView({ padding: 0.25, maxZoom: 1.5, duration: 150 }),
    undo,
    redo,
    requestSnapshot,
    addProto,
    addMatch,
    addOp,
    addComment,
    copySelection,
    paste: (at) => paste(at),
    deleteSelection,
    getSelectedNode: () => {
      const sel = getSelectedNodes.value;
      if (sel.length !== 1 || sel[0].type === "gcomment") return null;
      return (sel[0].data?.g as GNode) ?? null;
    },
    getSelectedComment: () => {
      const sel = getSelectedNodes.value;
      if (sel.length !== 1 || sel[0].type !== "gcomment") return null;
      return (sel[0].data?.c as GComment) ?? null;
    },
  });
});

onBeforeUnmount(() => {
  store.setCanvas(null);
});
</script>

<template>
  <div ref="wrapRef" class="graph-canvas-wrap" @dragover="onDragOver" @drop="onDrop">
    <VueFlow
      :delete-key-code="null"
      :is-valid-connection="checkConnection"
      :snap-to-grid="store.snapToGrid"
      :snap-grid="[16, 16]"
      :min-zoom="0.2"
      :max-zoom="2.5"
      fit-view-on-init
    >
      <template #node-gproto="p">
        <GraphProtoCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gmatch="p">
        <GraphMatchCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gop="p">
        <GraphOpCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gevent="p">
        <GraphEventCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gvar="p">
        <GraphVarCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gflow="p">
        <GraphFlowCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gmath="p">
        <GraphMathCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gcustom="p">
        <GraphCustomCard :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <template #node-gcomment="p">
        <GraphCommentBox :id="p.id" :data="p.data" :selected="p.selected" />
      </template>
      <Background :gap="44" :size="2" pattern-color="#343434" />
      <Controls position="bottom-left" :show-interactive="false" />
      <MiniMap position="bottom-right" pannable zoomable />
    </VueFlow>
  </div>
</template>
