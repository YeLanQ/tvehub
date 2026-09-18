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
import { api } from "../../lib/api";
import { openContextMenu, type CtxMenuItem } from "../../lib/editor/context-menu";
import {
  canConnectPorts,
  graphNodeLabel,
  graphPort,
  GRAPH_DEFAULT_COMMENT_COLOR,
  GRAPH_OP_DEFS,
  G_OP_TRIGGER_LABEL,
  nodeDefaults,
  nodeMenuGroups,
  nodeTypeDef,
  isContainerType,

  normalizeGraphDoc,
  type GComment,
  type GNode,
  type ScriptGraphDoc,
} from "../../framework/graph";
import GraphContainerCard from "./GraphContainerCard.vue";

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
  onNodeDrag,
  onNodeDragStop,
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
  if (isContainerType(type)) return "glogic";
  if (type.startsWith("op.")) return "gop";
  if (type.startsWith("event.")) return "gevent";
  if (type.startsWith("var.")) return "gvar";
  if (type.startsWith("flow.")) return "gflow";
  if (type.startsWith("math.")) return "gmath";
  if (type.startsWith("custom.")) return "gcustom";
  return "gcomment";
}

function toFlowNode(n: GNode): Node {
  const base: Node = { id: n.id, type: flowNodeType(n.type), position: { x: n.x, y: n.y }, data: { g: n } };
  // 容器卡：显式尺寸（组件按 g.w/g.h 渲染，先声明避免首帧测量抖动）；
  // 容器压低 z 序，归属子卡片保持在上层可点/可连
  if (n.w && n.h) {
    base.style = { width: `${n.w}px`, height: `${n.h}px` };
    base.zIndex = -10;
  }
  return base;
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
  assignContainer(n, pos);
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
  assignContainer(n, pos);
  putNode(n);
}

function addOp(opType: string, at?: { x: number; y: number }): void {
  // 注册表驱动：通用操作（GRAPH_OP_DEFS）与驱动器（op.navMove/chase/patrol）都可建
  if (!nodeTypeDef(opType)) return;
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = {
    id: uniqueNodeId(),
    type: opType,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    opType,
    params: nodeDefaults(opType),
  };
  assignContainer(n, pos);
  putNode(n);
}

/** 添加事件节点（执行链入口） */
function addEvent(eventType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: eventType, x: Math.round(pos.x), y: Math.round(pos.y) };
  assignContainer(n, pos);
  putNode(n);
}

/** 添加变量节点（var.get / var.set） */
function addVarNode(varType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: varType, x: Math.round(pos.x), y: Math.round(pos.y) };
  assignContainer(n, pos);
  putNode(n);
}

/** 添加控制流节点（flow.branch/compare/for/forEach/while） */
function addFlowNode(flowType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: flowType, x: Math.round(pos.x), y: Math.round(pos.y) };
  if (flowType === "flow.compare") n.params = { operator: ">" };
  if (flowType === "flow.for") n.params = { start: 0, end: 10, step: 1 };
  assignContainer(n, pos);
  putNode(n);
}

/** 添加数学/工具节点（math.add/sub/.../vec3Make/...） */
function addMathNode(mathType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: mathType, x: Math.round(pos.x), y: Math.round(pos.y) };
  assignContainer(n, pos);
  putNode(n);
}

/** 添加逻辑容器（fsm.container / bt.container；大框卡，子节点以 containerId 归属，可嵌套） */
function addLogicContainer(logicType: string, at?: { x: number; y: number }): void {
  if (!isContainerType(logicType)) return;
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = {
    id: uniqueNodeId(),
    type: logicType,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    w: 560,
    h: 340,
    params: nodeDefaults(logicType),
  };
  // 容器可嵌套：创建位置落在其他容器内时归属该容器
  assignContainer(n, pos);
  putNode(n);
}

// ---------------------------------------------------------------------------
// 容器归属（节点即容器内容）：落点/位置落在容器 rect 内即归属（嵌套取最内层）
// ---------------------------------------------------------------------------

/** 命中测试：包含 pos 的最小面积容器（excludeId 及其祖先链排除），无则 null */
function containerAt(pos: { x: number; y: number }, excludeId?: string): GNode | null {
  let best: GNode | null = null;
  let bestArea = Infinity;
  for (const n of nodes.value) {
    const g = n.data?.g as GNode | undefined;
    if (!g || !isContainerType(g.type) || g.id === excludeId) continue;
    const w = g.w ?? 560;
    const h = g.h ?? 340;
    if (pos.x < g.x || pos.y < g.y || pos.x > g.x + w || pos.y > g.y + h) continue;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      best = g;
    }
  }
  return best;
}

/** 位置归属容器（排除自身；排除会成环的目标——自身已在目标容器内的情况） */
function assignContainer(n: GNode, pos: { x: number; y: number }): void {
  const target = containerAt(pos, n.id);
  if (!target) {
    delete n.containerId;
    return;
  }
  // 防环：目标容器的祖先链包含自身则不归属
  let cur = target.containerId;
  const guard = new Set<string>([n.id]);
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    cur = (nodes.value.find((x) => (x.data?.g as GNode | undefined)?.id === cur)?.data?.g as GNode | undefined)?.containerId;
  }
  if (cur === n.id) return;
  n.containerId = target.id;
}

/** 容器拖动：整棵子树随容器平移（嵌套容器递归），并同步各节点的 g.x/g.y */
function moveSubtree(containerId: string, dx: number, dy: number): void {
  for (const n of nodes.value) {
    const g = n.data?.g as GNode | undefined;
    if (!g || g.containerId !== containerId) continue;
    n.position = { x: n.position.x + dx, y: n.position.y + dy };
    g.x = Math.round(n.position.x);
    g.y = Math.round(n.position.y);
    if (isContainerType(g.type)) moveSubtree(g.id, dx, dy);
  }
}

const dragPrev = new Map<string, { x: number; y: number }>();

/** 拖拽中：容器拖动带动子树；坐标回写 g.x/g.y（容器命中测试依赖它）；结束按位置重算归属 */
function onNodeDragProcess(node: Node, isStop: boolean): void {
  const g = node.data?.g as GNode | undefined;
  if (!g) return;
  const prev = dragPrev.get(node.id);
  if (prev && isContainerType(g.type)) {
    const dx = node.position.x - prev.x;
    const dy = node.position.y - prev.y;
    if (dx || dy) moveSubtree(g.id, dx, dy);
  }
  // 坐标回写：containerAt 用 g.x/g.y 判定归属，拖动后必须同步，否则命中测试
  // 用的是过期矩形（表现为卡片拖进容器无法嵌入）
  g.x = Math.round(node.position.x);
  g.y = Math.round(node.position.y);
  dragPrev.set(node.id, { x: node.position.x, y: node.position.y });
  if (isStop) {
    dragPrev.delete(node.id);
    // 拖拽结束：按最终位置重算归属（容器拖动带动子树后子节点位置不变，跳过容器自身）
    if (!isContainerType(g.type)) {
      assignContainer(g, { x: g.x, y: g.y });
    } else {
      // 容器被拖入其他容器内则归属（嵌套）
      assignContainer(g, { x: g.x + 8, y: g.y + 8 });
    }
    store.markGraphDirty();
  }
}

/** 添加自定义节点（custom.xxx） */
function addCustomNode(customType: string, at?: { x: number; y: number }): void {
  requestSnapshot();
  const pos = at ?? mouseFlow();
  const n: GNode = { id: uniqueNodeId(), type: customType, x: Math.round(pos.x), y: Math.round(pos.y) };
  assignContainer(n, pos);
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
  // 容器删除级联：归属子树（含嵌套容器）一并删除
  const doomed = new Set(sel.map((n) => n.id));
  const expand = (id: string): void => {
    for (const n of nodes.value) {
      const g = n.data?.g as GNode | undefined;
      if (!g || g.containerId !== id || doomed.has(n.id)) continue;
      doomed.add(n.id);
      if (isContainerType(g.type)) expand(g.id);
    }
  };
  for (const n of sel) if (n.type !== "gcomment") expand(n.id);
  const all = nodes.value.filter((n) => doomed.has(n.id));
  if (all.length) removeNodes(all);
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
  // 先为全部剪贴板元素分配新 id（容器归属重映射需要完整映射，与顺序无关）
  for (const n of clip.nodes) {
    const isCard = n.type !== "gcomment";
    const ref = (n.data?.g ?? n.data?.c) as { id: string } | undefined;
    if (ref?.id) idMap.set(ref.id, isCard ? uniqueNodeId() : uniqueCommentId());
  }
  const newNodes: Node[] = clip.nodes.map((n) => {
    const isCard = n.type !== "gcomment";
    const ref = (n.data?.g ?? n.data?.c) as { id: string } | undefined;
    const newId = idMap.get(ref?.id ?? "") ?? (isCard ? uniqueNodeId() : uniqueCommentId());
    if (n.type === "gcomment") {
      const c = n.data?.c as GComment;
      return toFlowComment({ ...c, id: newId, x: c.x + dx, y: c.y + dy });
    }
    const g = n.data?.g as GNode;
    const copy = JSON.parse(JSON.stringify({ ...g, id: newId, x: g.x + dx, y: g.y + dy })) as GNode;
    // 容器归属重映射：随复制容器走；原容器不在复制集内则清除归属
    if (copy.containerId) {
      copy.containerId = idMap.get(copy.containerId) ?? "";
      if (!copy.containerId) delete copy.containerId;
    }
    return toFlowNode(copy);
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
  // 入端口唯一（非 multi 口）：替换已有入线（拖到已占用的入引脚 = 重新连接）；
  // multi 口（目标/路径点等多入汇聚）追加连线，仅同源同引脚的重复连线按重连处理
  const occupied = edges.value.filter(
    (e) => e.target === params.target && e.targetHandle === params.targetHandle,
  );
  const dg = findNode(params.target)?.data?.g as GNode | undefined;
  const dp = dg ? graphPort(dg, params.targetHandle ?? "", "in") : null;
  if (dp?.multi) {
    const dup = occupied.filter(
      (e) => e.source === params.source && e.sourceHandle === params.sourceHandle,
    );
    if (dup.length) removeEdges(dup);
  } else if (occupied.length) {
    removeEdges(occupied);
  }
  addEdges([makeEdge(params.source, params.sourceHandle ?? "", params.target, params.targetHandle ?? "", uniqueEdgeId())]);
  store.markGraphDirty();
  // 状态机卡片接入状态机容器：容器自动读取该卡片绑定的 .fsm 资产状态
  void importFsmStatesIfWired(params.source, params.target, params.targetHandle ?? "");
});

/**
 * 逻辑容器接入原型卡：连线落到容器「作用域」入端口且源是携带对应逻辑资产
 * 的原型卡时，读取资产写回容器——
 * - fsm.container + .fsm：状态名写入状态列表，initial 取入口状态；
 * - bt.container + .bt：模式取树根类型，并统计树节点构成写入摘要。
 * 读取失败仅提示，不阻断连线。
 */
interface FsmAssetGraph {
  states?: { id?: string; name?: string }[];
  entry?: string;
}

interface BtAssetNode {
  type?: string;
  children?: BtAssetNode[];
}

async function importFsmStatesIfWired(sourceId: string, targetId: string, dstPort: string): Promise<void> {
  const container = findNode(targetId)?.data?.g as GNode | undefined;
  if (!container || !isContainerType(container.type) || dstPort !== "in") return;
  const isFsm = container.type === "fsm.container";
  const wantKind = isFsm ? "fsm" : "bt";
  const source = findNode(sourceId)?.data?.g as GNode | undefined;
  if (!source || source.type !== "entity.proto") return;
  const entity = store.sceneEntities.find((e) => e.id === source.entityId);
  if (!entity || entity.logic?.kind !== wantKind) {
    store.showToast(isFsm ? "作用域需接入携带 .fsm 的状态机原型卡" : "作用域需接入携带 .bt 的行为树原型卡");
    return;
  }
  const asset = entity.logic.asset;
  if (!asset) {
    store.showToast(`该原型未绑定 .${wantKind} 资产，容器无法读取`);
    return;
  }
  const root = store.root;
  if (!root) return;
  try {
    const text = await api.readText(root, asset);
    const parsed = JSON.parse(text ?? "{}") as Record<string, unknown>;
    if (isFsm) {
      const graph = ((parsed.graph ?? parsed) ?? {}) as FsmAssetGraph;
      const names = (Array.isArray(graph.states) ? graph.states : [])
        .map((s) => (typeof s.name === "string" ? s.name.trim() : ""))
        .filter(Boolean);
      if (!names.length) {
        store.showToast("状态机资产内没有状态");
        return;
      }
      const entryState = (graph.states ?? []).find((s) => s.id === graph.entry)?.name ?? "";
      if (!container.params || typeof container.params !== "object") container.params = {};
      container.params.states = names.join(",");
      container.params.initial = names.includes(entryState) ? entryState : names[0];
      store.markGraphDirty();
      store.showToast(`状态机容器已读取状态：${names.join(" / ")}`);
      return;
    }
    // bt.container：模式取树根类型；统计树节点构成写入摘要 chips
    const tree = ((parsed.tree ?? parsed) ?? {}) as BtAssetNode;
    const counts = new Map<string, number>();
    let total = 0;
    const walk = (n: BtAssetNode | undefined): void => {
      if (!n || typeof n !== "object") return;
      total += 1;
      const t = typeof n.type === "string" ? n.type : "?";
      counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const c of Array.isArray(n.children) ? n.children : []) walk(c);
    };
    walk(tree);
    if (!total) {
      store.showToast("行为树资产内没有节点");
      return;
    }
    const rootType = typeof tree.type === "string" ? tree.type : "sequence";
    if (!container.params || typeof container.params !== "object") container.params = {};
    container.params.mode = rootType;
    container.params.treeSummary = `${total} 节点 · ${[...counts.entries()].map(([t, c]) => `${t}×${c}`).join("、")}`;
    store.markGraphDirty();
    store.showToast(`行为树容器已读取资产：${total} 个节点`);
  } catch (e) {
    store.showToast(`读取逻辑资产失败: ${e}`);
  }
}

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
onNodeDrag(({ node }) => onNodeDragProcess(node, false));
onNodeDragStop(({ node }) => onNodeDragProcess(node, true));

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
  // 驱动器（帧驱动的移动类操作）与其余原子操作分组展示
  const DRIVER_OP_TYPES = new Set(["op.patrol", "op.chase", "op.navMove"]);
  const opItems: CtxMenuItem[] = GRAPH_OP_DEFS.filter((d) => !DRIVER_OP_TYPES.has(d.type)).map((d) => ({
    label: `${d.label}（${G_OP_TRIGGER_LABEL[d.trigger]}）`,
    onClick: () => addOp(d.type, ctxFlowPos),
  }));
  const driverItems: CtxMenuItem[] = [
    { label: "导航移动（跟随 Nav Agent）", onClick: () => addOp("op.navMove", ctxFlowPos) },
    { label: "追击目标", onClick: () => addOp("op.chase", ctxFlowPos) },
    { label: "路径巡逻", onClick: () => addOp("op.patrol", ctxFlowPos) },
  ];
  const logicItems: CtxMenuItem[] = (nodeMenuGroups().find((g) => g.category === "logic")?.items ?? []).map((d) => ({
    label: d.label,
    onClick: () => addLogicContainer(d.type, ctxFlowPos),
  }));
  const items: CtxMenuItem[] = [
    { label: "添加事件", children: eventItems },
    { label: "添加逻辑容器", children: logicItems },
    { label: "添加驱动器", children: driverItems },
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
      <template #node-glogic="p">
        <GraphContainerCard :id="p.id" :data="p.data" :selected="p.selected" />
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
