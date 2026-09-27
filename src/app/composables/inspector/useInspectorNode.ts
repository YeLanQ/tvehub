// ---------------------------------------------------------------------------
// 检查器根上下文与节点级字段：inspector 系列组合式函数的根模块，对外提供
// node / revision 两个上下文 computed、统一提交链路（commit / mutateNode），
// 以及节点自身的字段编辑（重命名、显隐、标签、单轴变换、网格来源与几何、
// 动画设置与动画图）。
//
// 协作：域组合式函数（材质 / 组件 / 物理 / 灯光音频 / 相机天空）都以本文件
// 返回的 ctx 为唯一依赖（单向依赖，域之间互不引用）；InspectorPanel.vue 只保留
// 面板壳层状态、生命周期与模板。store / engine / projectStore / assetsStore /
// scriptsStore 一并下发，各域不再重复取单例。
//
// 背景：从 InspectorPanel.vue（原 1291 行）抽出的节点部分——行为、文案与调用
// 顺序与拆分前逐字保持一致。
// ---------------------------------------------------------------------------
import { computed, type ComputedRef } from "vue";
import { getEditorStore, type EditorStore } from "../../stores/editor";
import { getProjectStore, type ProjectStore } from "../../stores/project";
import { getAssetsStore, type AssetsStore } from "../../stores/assets";
import { getScriptsStore, type ScriptsStore } from "../../stores/scripts";
import type { EditorEngine } from "../../../framework/engine/EditorEngine";
import type { Node } from "../../../framework/prototype/Node";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import type { JsonRecord } from "../../../framework/prototype/types";
import type { TransformSnapshot } from "../../../framework/scene/SceneClient";
import type { AnimGraph } from "../../../framework/animation";
import { isModelAssetRel, parseMeshData } from "../../../framework/mesh";
import { dispatchCommand } from "../../commands";

/** Set Mesh Size 载荷：逐轴提交（与变换字段同交互），axis 限定 xyz */
export interface MeshSizePayload {
  axis: "x" | "y" | "z";
  value: number;
}

/**
 * 解析基元尺寸提交载荷（纯函数，独立便于单测）：
 * 轴限定 x/y/z、数值须有限且为正（几何尺寸非正无意义）；
 * 不合法返回 null 供调用方丢弃（与 Import Mesh Data 的"非法不提交"同口径）。
 */
export function parseMeshSizePayload(value: unknown): MeshSizePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Partial<MeshSizePayload>;
  if (p.axis !== "x" && p.axis !== "y" && p.axis !== "z") return null;
  const num = Number(p.value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return { axis: p.axis, value: num };
}

/** inspector 系列共享上下文：由 useInspectorNode 构造，域组合式函数只消费它 */
export interface InspectorNodeApi {
  /** 当前选中节点（选中项驱动；无选中为 undefined） */
  node: ComputedRef<Node | undefined>;
  /** 失效信号：选择 / 属性补丁 / 模型异步加载完成都会 bump，卡片派生据此重算 */
  revision: ComputedRef<number>;
  store: EditorStore;
  engine: EditorEngine;
  projectStore: ProjectStore;
  assetsStore: AssetsStore;
  scriptsStore: ScriptsStore;
  /** 对当前选中节点提交一次修改（可撤销） */
  commit: (mutate: (n: Node) => void, label: string) => void;
  /** 直接对指定节点执行 patch（节点可能非当前选中；捕获前后快照进历史） */
  mutateNode: (n: Node, mutate: (nn: Node) => void, label: string) => void;
  setTransformAxis: (axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number) => void;
  onNodeRename: (name: string) => void;
  onNodeToggleVisible: (value: boolean) => void;
  /** 设置节点标签 */
  onNodeSetTag: (tag: string) => void;
  /** 设置节点渲染层级（渲染侧经 SceneSynchronizer 落到 object.layers） */
  onNodeSetLayer: (layer: number) => void;
  onTransformChange: (axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number) => void;
  onMeshUpdate: (label: string, value: unknown) => void;
  onAnimUpdate: (label: string, value: unknown) => void;
  /** 动画图数据变更（编辑器每次操作提交整图；null = 删除图回到单剪辑） */
  onAnimGraphUpdate: (graph: AnimGraph | null) => void;
}

export function useInspectorNode(): InspectorNodeApi {
  const store = getEditorStore();
  const projectStore = getProjectStore();
  const assetsStore = getAssetsStore();
  const scriptsStore = getScriptsStore();
  const { state, engine } = store;

  const node = computed<Node | undefined>(() => store.nodeById(state.selectedId ?? undefined));
  const revision = computed(() => store.revision());

  // -------------------------------------------------------------------------
  // 统一提交链路：所有节点编辑都经它进撤销历史（整节点前后快照）
  // -------------------------------------------------------------------------

  function commit(mutate: (n: Node) => void, label: string): void {
    const n = node.value;
    if (!n) return;
    mutateNode(n, mutate, label);
  }

  /** 直接对指定节点执行 patch（节点可能非当前选中；捕获前后快照进历史） */
  function mutateNode(n: Node, mutate: (nn: Node) => void, label: string): void {
    const before = n.toJSON() as JsonRecord;
    mutate(n);
    const after = n.toJSON() as JsonRecord;
    void dispatchCommand("node.patch", { id: n.id, before, after, label });
  }

  // -------------------------------------------------------------------------
  // 节点级字段编辑（Node / Transform / Mesh / Animation 卡片）
  // -------------------------------------------------------------------------

  function setTransformAxis(axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number): void {
    const n = node.value;
    if (!n) return;
    const cur = engine.getTransform(n.id);
    if (!cur) return;
    const next: TransformSnapshot = {
      position: { ...cur.position },
      rotation: { ...cur.rotation },
      scale: { ...cur.scale },
    };
    next[axis][part] = value;
    void dispatchCommand("node.setTransform", { id: n.id, snapshot: next });
  }

  function onNodeRename(name: string): void {
    void dispatchCommand("node.rename", { name });
  }

  function onNodeToggleVisible(value: boolean): void {
    commit((n) => { n.visible = value; }, "Toggle Visible");
  }

  function onTransformChange(axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number): void {
    setTransformAxis(axis, part, value);
  }

  function onMeshUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof MeshNode)) return;
    switch (label) {
      case "Set Geometry":
        commit((m) => {
          (m as MeshNode).source = "primitive";
          (m as MeshNode).geometry = value as MeshNode["geometry"];
        }, label);
        break;
      case "Set Mesh Size": {
        // 基元尺寸逐轴补丁（非法载荷丢弃不提交）；引擎经 properties 变更管线重建几何
        const size = parseMeshSizePayload(value);
        if (!size) return;
        commit((m) => {
          (m as MeshNode).size[size.axis] = size.value;
        }, label);
        break;
      }
      case "Set Mesh Source": {
        const source = value === "model" ? "model" : value === "data" ? "data" : "primitive";
        commit((m) => {
          const mesh = m as MeshNode;
          mesh.source = source;
          if (source === "model") mesh.material = ""; // 模型材质内嵌，不走资产引用
        }, label);
        break;
      }
      case "Import Mesh Data": {
        // 数据化网格：载荷经 parseMeshData 收敛（非法丢弃不提交）
        const payload = parseMeshData(value);
        if (!payload) return;
        commit((m) => {
          const mesh = m as MeshNode;
          mesh.source = "data";
          mesh.dataMesh = payload;
        }, `导入数据网格: ${payload.sourceName || payload.format}`);
        break;
      }
      case "Clear Mesh Data":
        commit((m) => {
          const mesh = m as MeshNode;
          mesh.dataMesh = null;
          mesh.source = "primitive"; // 清除回基元（载荷空置时 data 无意义）
        }, "清除数据网格");
        break;
      case "Set Model": {
        const rel = value as string;
        if (!isModelAssetRel(rel)) return;
        const apply = (): void => {
          commit((m) => {
            (m as MeshNode).source = "model";
            (m as MeshNode).model = rel;
            (m as MeshNode).material = "";
          }, label);
        };
        // 先预取模型再提交：节点入图即渲染实例（未就绪则先占位后自动刷新）
        if (!engine.models.has(rel)) {
          void engine.models.preload([rel]);
        }
        apply();
        engine.refreshModelNodes(rel);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 动画卡片（Animation）事件：节点数据提交（可撤销）；运行时控制由卡片直连引擎
  // ---------------------------------------------------------------------------

  function onAnimUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof MeshNode)) return;
    commit((m) => {
      const anim = (m as MeshNode).anim;
      switch (label) {
        case "Set Anim Autoplay":
          anim.autoplay = value === true;
          break;
        case "Set Anim Clip":
          anim.clip = typeof value === "string" ? value : "";
          break;
        case "Set Anim Speed":
          anim.speed = typeof value === "number" ? Math.max(0, value) : 1;
          break;
        case "Set Anim Loop":
          if (value === "loop" || value === "once" || value === "pingpong") anim.loop = value;
          break;
      }
    }, label);
  }

  /** 动画图数据变更（编辑器每次操作提交整图；null = 删除图回到单剪辑） */
  function onAnimGraphUpdate(graph: AnimGraph | null): void {
    const n = node.value;
    if (!n || !(n instanceof MeshNode)) return;
    commit((m) => {
      (m as MeshNode).animGraph = graph;
      if (graph) (m as MeshNode).anim.autoplay = true; // 图模式下自动播放入口状态
    }, "编辑动画图");
  }

  /** 设置节点标签 */
  function onNodeSetTag(tag: string): void {
    commit((n) => {
      n.tag = tag;
    }, "设置标签");
  }

  /** 设置节点渲染层级（0~31；越界值在数据层收敛） */
  function onNodeSetLayer(layer: number): void {
    commit((n) => {
      n.layer = layer;
    }, "Set Layer");
  }

  return {
    node,
    revision,
    store,
    engine,
    projectStore,
    assetsStore,
    scriptsStore,
    commit,
    mutateNode,
    setTransformAxis,
    onNodeRename,
    onNodeToggleVisible,
    onNodeSetTag,
    onNodeSetLayer,
    onTransformChange,
    onMeshUpdate,
    onAnimUpdate,
    onAnimGraphUpdate,
  };
}
