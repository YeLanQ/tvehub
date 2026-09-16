// ---------------------------------------------------------------------------
// 脚本图行为解释器（预览/发布运行时）：解释脚本图文档（proto/match/op），
// 把图上对原型定义的操作作为运行时行为执行 —— 不修改场景数据，只在运行期
// 改变实体的表现（与脚本语义一致：位姿/可见性/状态机事件）。
//
// 目标解析（图文档 edges 的实体集通道）：
// - proto：按场景节点 id 精确匹配（拖入的原型引用源）；
// - match：按 userData.nodeTag（标签）或 nodeKind（类型）批量匹配。
// 操作触发时机由类型固定（见 framework/graph opRegistry）：
// - start：装配时执行一次（op.set 绝对设值 / op.setFsmParam）；
// - frame：每帧累计（op.spin 角速度 / op.bob 正弦浮动）；
// - click：指针射线命中目标实体时（op.toggleVisible / op.fireFsm）。
// 执行链通道（op.next → op.exec）：应用某操作时级联下游操作。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { GNode, ScriptGraphDoc } from "../../framework/graph";

/** 场景节点对象（buildSceneTree 打 userData.nodeId/nodeKind/nodeTag 标记） */
interface NodeObj {
  obj: THREE.Object3D;
  id: string;
  kind: string;
  tag: string;
}

export interface GraphBehaviorsCtx {
  scene: THREE.Scene;
  dom: HTMLElement;
  camera: THREE.Camera;
  logicApi: {
    fire(entity: { id: string }, event: string): void;
    setParam(entity: { id: string }, key: string, value: number): void;
  };
  graph: ScriptGraphDoc;
}

export interface GraphBehaviorsHandle {
  update(dt: number): void;
  dispose(): void;
}

/** 属性路径写入（Entity 暴露的分量：position/rotation/scale 各分量 + visible） */
function setPath(obj: THREE.Object3D, path: string, value: number): boolean {
  switch (path) {
    case "position.x": obj.position.x = value; return true;
    case "position.y": obj.position.y = value; return true;
    case "position.z": obj.position.z = value; return true;
    case "rotation.x": obj.rotation.x = (value * Math.PI) / 180; return true;
    case "rotation.y": obj.rotation.y = (value * Math.PI) / 180; return true;
    case "rotation.z": obj.rotation.z = (value * Math.PI) / 180; return true;
    case "scale.x": obj.scale.x = value; return true;
    case "scale.y": obj.scale.y = value; return true;
    case "scale.z": obj.scale.z = value; return true;
    default: return false;
  }
}

const DEG = Math.PI / 180;

export function createGraphBehaviors(ctx: GraphBehaviorsCtx): GraphBehaviorsHandle {
  const { scene, dom, camera, logicApi, graph } = ctx;

  // ----- 收集场景节点对象（traverse 含子孙，去重） -----
  const byId = new Map<string, NodeObj>();
  const all: NodeObj[] = [];
  scene.traverse((o) => {
    const id = typeof o.userData?.nodeId === "string" ? o.userData.nodeId : "";
    if (!id || byId.has(id)) return;
    const n: NodeObj = {
      obj: o,
      id,
      kind: typeof o.userData?.nodeKind === "string" ? o.userData.nodeKind : "",
      tag: typeof o.userData?.nodeTag === "string" ? o.userData.nodeTag : "",
    };
    byId.set(id, n);
    all.push(n);
  });

  const nodeOf = (id: string): GNode | undefined => graph.nodes.find((n) => n.id === id);

  /** 匹配节点/原型的实体集 */
  function resolveSet(refId: string, seen = new Set<string>()): NodeObj[] {
    if (seen.has(refId)) return [];
    seen.add(refId);
    const node = nodeOf(refId);
    if (!node) return [];
    if (node.kind === "proto") {
      const hit = byId.get(node.entityId ?? "");
      return hit ? [hit] : [];
    }
    if (node.kind === "match") {
      const p = node.matchPattern ?? "";
      if (!p) return [];
      return all.filter((n) => (node.matchMode === "type" ? n.kind === p : n.tag === p));
    }
    return [];
  }

  /** 操作的目标集：实体集通道上游（op.out 实体透传 → 递归上游） */
  function resolveTargets(opId: string, seen = new Set<string>()): NodeObj[] {
    if (seen.has(opId)) return [];
    seen.add(opId);
    const out: NodeObj[] = [];
    for (const e of graph.edges) {
      if (e.dstNode !== opId || e.dstPort !== "in") continue;
      const src = nodeOf(e.srcNode);
      if (!src) continue;
      if (src.kind === "op") out.push(...resolveTargets(src.id, seen));
      else out.push(...resolveSet(src.id));
    }
    return out;
  }

  /** 参数读取（缺省回退：解析容错） */
  const numP = (n: GNode, key: string, fb = 0): number => {
    const v = n.params?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fb;
  };
  const strP = (n: GNode, key: string): string => {
    const v = n.params?.[key];
    return typeof v === "string" ? v : "";
  };

  // ----- 操作分类 -----
  const ops = graph.nodes.filter((n) => n.kind === "op");
  const startOps = ops.filter((n) => n.opType === "op.set" || n.opType === "op.setFsmParam");
  const spinOps = ops.filter((n) => n.opType === "op.spin");
  const bobOps = ops.filter((n) => n.opType === "op.bob");
  const clickOps = ops.filter((n) => n.opType === "op.toggleVisible" || n.opType === "op.fireFsm");

  // ----- start：装配即执行一次 -----
  for (const op of startOps) {
    const targets = resolveTargets(op.id);
    for (const t of targets) {
      if (op.opType === "op.set") {
        setPath(t.obj, strP(op, "property"), numP(op, "value"));
      } else if (op.opType === "op.setFsmParam") {
        try {
          logicApi.setParam({ id: t.id }, strP(op, "param"), numP(op, "value"));
        } catch {
          /* 状态机未绑定等运行态缺失：跳过 */
        }
      }
    }
  }

  // ----- frame：每帧行为 -----
  const frameOps: { node: GNode; targets: NodeObj[]; baseY: Map<string, number> }[] = [];
  for (const op of spinOps.length || bobOps.length ? ops : []) {
    if (op.opType !== "op.spin" && op.opType !== "op.bob") continue;
    const targets = resolveTargets(op.id);
    if (!targets.length) continue;
    const baseY = new Map<string, number>();
    for (const t of targets) baseY.set(t.id, t.obj.position.y);
    frameOps.push({ node: op, targets, baseY });
  }

  // ----- click：指针射线命中 -----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function onPointerDown(e: PointerEvent): void {
    const rect = dom.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    for (const op of clickOps) {
      const targets = resolveTargets(op.id);
      if (!targets.length) continue;
      const hits = raycaster.intersectObjects(
        targets.map((t) => t.obj),
        true,
      );
      // 命中对象可能是不带标记的内部子对象：向上找最近的带标记节点
      const hitId = (() => {
        for (const h of hits) {
          let o: THREE.Object3D | null = h.object;
          while (o) {
            const id = typeof o.userData?.nodeId === "string" ? o.userData.nodeId : "";
            if (id && targets.some((t) => t.id === id)) return id;
            o = o.parent;
          }
        }
        return "";
      })();
      if (!hitId) continue;
      if (op.opType === "op.toggleVisible") {
        const t = targets.find((t) => t.id === hitId);
        if (t) t.obj.visible = !t.obj.visible;
      } else if (op.opType === "op.fireFsm") {
        try {
          logicApi.fire({ id: hitId }, strP(op, "event"));
        } catch {
          /* 状态机未绑定：跳过 */
        }
      }
    }
  }
  if (clickOps.length) dom.addEventListener("pointerdown", onPointerDown);

  let elapsed = 0;

  return {
    update(dt: number) {
      elapsed += dt;
      for (const behavior of frameOps) {
        const { node, targets, baseY } = behavior;
        if (node.opType === "op.spin") {
          const dx = numP(node, "speedX") * DEG * dt;
          const dy = numP(node, "speedY") * DEG * dt;
          const dz = numP(node, "speedZ") * DEG * dt;
          for (const t of targets) {
            if (dx) t.obj.rotation.x += dx;
            if (dy) t.obj.rotation.y += dy;
            if (dz) t.obj.rotation.z += dz;
          }
        } else if (node.opType === "op.bob") {
          const amp = numP(node, "amplitude");
          const period = numP(node, "period", 2);
          if (period <= 0 || !amp) continue;
          const y = amp * Math.sin((elapsed / period) * Math.PI * 2);
          for (const t of targets) {
            const base = baseY.get(t.id) ?? t.obj.position.y;
            t.obj.position.y = base + y;
          }
        }
      }
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
