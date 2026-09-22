// ---------------------------------------------------------------------------
// 场景图内置运行时语义模块（与框架层 core-* manifest 双端对齐的另一半）。
//
// 每个 createCore* 工厂产出一个 GraphRuntimeModule（每次图装配新建实例，
// 模块内部状态——FSM 当前状态、巡逻相位、表达式缓存——天然按图隔离）。
// 注入模块（L1 脚本图模块）与本文件模块经同一张 handler 表合并，无特权差异。
//
// 模块清单：
// - core-entity     实体集源解析（entity.proto 精确 / entity.match 标签|类型 /
//                   op.children 直属子级 / flow.forEach 当前实体）
// - core-ops        一次性原子操作（op.set / op.setFsmParam / op.fireFsm）
// - core-drivers    驱动器（op.spin / op.bob / op.patrol / op.chase / op.navMove）
// - core-data       拉模型数据求值（var / flow.compare / loop 上下文 / math / sense / custom 表达式）
// - core-exec       执行链路由（var.set / flow.branch / flow.for / flow.forEach /
//                   flow.while / flow.gate 中断开关）
// - core-containers 容器行为（fsm.container 状态机 / bt.container 行为树）
// ---------------------------------------------------------------------------

import type * as THREE from "three";
import { type GCustomNodeDef, type GNode } from "../../framework/graph";
import {
  DEG,
  unwrapEntities,
  unwrapEntity,
  toNum,
  toStr,
  type ContainerBehavior,
  type DataValue,
  type GraphKernel,
  type GraphRuntimeModule,
  type NodeObj,
} from "./graph-runtime";
import { readPropPath, writePropPath } from "./graph-prop-path";

/**
 * 对象世界坐标平移分量（matrixWorld 平移列；不引入 THREE 值导入）。
 * 先刷新父链矩阵（与 three getWorldPosition 同语义）——图在渲染前写入位姿时，
 * matrixWorld 可能还是上一帧的，直接读会得到过期坐标。
 */
function worldPos(obj: THREE.Object3D): { x: number; y: number; z: number } {
  obj.updateWorldMatrix(true, false);
  const e = obj.matrixWorld.elements;
  return { x: e[12] ?? 0, y: e[13] ?? 0, z: e[14] ?? 0 };
}

/** 祖先链判定（obj 是否在 root 子树内）：移动者不能把"自己的子级"当路径点/追击目标 */
function isDescendantOf(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = obj.parent;
  while (p) {
    if (p === root) return true;
    p = p.parent;
  }
  return false;
}

/** 异常文本（诊断日志附加信息；非 Error 走 String 兜底） */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 比较运算符白名单（与框架层 G_COMPARE_OPERATORS 一致；运行时自持副本，非法值给出告警） */
const COMPARE_OPERATORS = [">", "<", "==", ">=", "<=", "!="];

// ---------------------------------------------------------------------------
// 属性路径写入（Entity 暴露的分量：position/rotation/scale 各分量 + visible）
// ---------------------------------------------------------------------------

/** 变换/可见性分量写入（度制输入 → 弧度） */
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

/** 灯光分量路径写入（light 组件：强度/距离/聚光角；对象树内找首个光源） */
function setLightPath(obj: THREE.Object3D, path: string, value: number): boolean {
  if (!path.startsWith("light.")) return false;
  let light: THREE.Light | null = null;
  obj.traverse((o) => {
    if (!light && (o as THREE.Light).isLight === true) light = o as THREE.Light;
  });
  if (!light) return false;
  switch (path) {
    case "light.intensity": (light as THREE.Light).intensity = value; return true;
    case "light.distance": (light as THREE.PointLight).distance = value; return true;
    case "light.angle": (light as THREE.SpotLight).angle = value * DEG; return true;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// core-entity：实体集源解析
// ---------------------------------------------------------------------------

export function createCoreEntityModule(): GraphRuntimeModule {
  return {
    id: "core-entity",
    resolvers: {
      "entity.proto": (k, node) => {
        const eid = node.entityId ?? "";
        const hit = k.sceneById.get(eid);
        if (!hit) {
          // 原型实体缺失 → 目标集为空 → 下游行为静默不动；给出可定位告警
          // （常见原因：实体被删除/重建、图与场景版本不一致、预览的不是同一场景）
          k.warnOnce(
            `proto-miss:${eid}`,
            `[graph] 原型节点 ${node.id} 引用的场景实体 "${eid || "(空)"}" 在运行场景中不存在——该原型不产生目标（请确认实体未被删除/重建，且预览的是同一场景）`,
          );
          return [];
        }
        return [hit];
      },
      "entity.match": (k, node) => {
        const p = node.matchPattern ?? "";
        if (!p) {
          k.warnOnce(
            `match-nopattern:${node.id}`,
            `[graph] 匹配卡 (${node.id}) 未设置匹配串（命中 0 个实体）——在检查器选择标签/类型`,
          );
          return [];
        }
        const hit = k.sceneAll.filter((n) => (node.matchMode === "type" ? n.kind === p : n.tag === p));
        if (!hit.length) {
          k.warnOnce(
            `match-empty:${node.id}:${p}`,
            `[graph] 匹配卡 (${node.id}) ${node.matchMode === "type" ? "类型" : "标签"}「${p}」未命中任何实体（下游操作无目标）`,
          );
        } else {
          k.log(
            `match-hit:${node.id}:${p}`,
            `[graph] 匹配卡 (${node.id}) ${node.matchMode === "type" ? "类型" : "标签"}「${p}」命中 ${hit.length} 个实体 [${hit.map((h) => h.id).join(", ")}]`,
            3,
          );
        }
        return hit;
      },
      // op.children「获取子级」：目标集的直属子级实体（对象树中带 nodeId 标记的
      // 子对象；内部烘焙/包装子树无标记自然排除），多目标按连线顺序合并去重
      "op.children": (k, node) => {
        const out: NodeObj[] = [];
        const seen = new Set<string>();
        const targets = k.resolveTargets(node.id);
        for (const t of targets) {
          for (const child of t.obj.children) {
            const cid = typeof child.userData?.nodeId === "string" ? child.userData.nodeId : "";
            if (!cid || seen.has(cid)) continue;
            const hit = k.sceneById.get(cid);
            if (!hit) continue; // 标记存在但未被索引（异常兜底）
            seen.add(cid);
            out.push(hit);
          }
        }
        // 解析结果日志（限额；输出"空子级集"也记录——下游无目标时据此定位）
        if (targets.length && !out.length) {
          k.warnOnce(
            `children-empty:${node.id}`,
            `[graph] 获取子级 (${node.id})：目标 [${targets.map((t) => t.id).join(", ")}] 没有直属子级实体（输出空集）`,
          );
        } else if (out.length) {
          k.log(
            `children-hit:${node.id}`,
            `[graph] 获取子级 (${node.id})：目标 [${targets.map((t) => t.id).join(", ")}] → 子级 [${out.map((o) => o.id).join(", ")}]`,
            3,
          );
        }
        return out;
      },
      // flow.forEach「当前」引脚：迭代上下文内解析为当前实体（配合获取子级按序索引子级；
      // 迭代外为空 → 下游操作不执行，与数据引脚的 loopItem 回退语义一致）
      "flow.forEach": (k, node) => {
        const item = k.loopItem(node.id);
        return item ? [item] : [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-ops：一次性原子操作
// ---------------------------------------------------------------------------

export function createCoreOpsModule(): GraphRuntimeModule {
  return {
    id: "core-ops",
    ops: {
      "op.set": (k, node, targets) => {
        if (!targets.length) return;
        const path = k.strP(node, "property");
        const value = k.numP(node, "value");
        if (!path) {
          k.warnOnce(`set-nopath:${node.id}`, `[graph] 设置属性 (${node.id}) 未填写属性路径（未生效）——检查器「属性」输入点选或手输`);
          return;
        }
        for (const t of targets) {
          // 快路径（变换分量/灯光分量）→ 通用路径（visible/材质/userData/script:…）
          if (setPath(t.obj, path, value)) { k.log(`set-ok:${node.id}`, `[graph] 设置属性：${path} = ${value} → ${t.id}`, 5); continue; }
          if (setLightPath(t.obj, path, value)) { k.log(`set-ok:${node.id}`, `[graph] 设置属性：${path} = ${value} → ${t.id}`, 5); continue; }
          if (!writePropPath(t, path, value, k.scriptApi)) {
            k.warnOnce(
              `set-miss:${node.id}:${path}:${t.id}`,
              `[graph] 设置属性「${path}」失败：目标实体 ${t.id} 上该路径不可写（检查路径拼写与实体组件；要设置子级属性，先接「获取子级」/ForEach 把作用对象换成子级；脚本属性用 script:<脚本路径>:<属性>）`,
            );
          } else {
            k.log(`set-ok:${node.id}`, `[graph] 设置属性：${path} = ${value} → ${t.id}`, 5);
          }
        }
      },
      "op.setFsmParam": (k, node, targets) => {
        const key = k.strP(node, "param");
        if (!key) {
          k.warnOnce(`setparam-nokey:${node.id}`, `[graph] FSM 参数 (${node.id}) 未填写参数名，已跳过`);
          return;
        }
        for (const t of targets) {
          try {
            k.logicApi.setParam({ id: t.id }, key, k.numP(node, "value"));
            k.log(`setparam-ok:${node.id}`, `[graph] FSM 参数：${t.id}.${key} = ${k.numP(node, "value")}`, 5);
          } catch (e) {
            k.warnOnce(`setparam-fail:${node.id}:${t.id}`, `[graph] FSM 参数写入失败（${t.id} 可能没有状态机运行器）: ${errText(e)}`);
          }
        }
      },
      "op.fireFsm": (k, node, targets) => {
        const ev = k.strP(node, "event");
        if (!ev) {
          k.warnOnce(`fire-nokev:${node.id}`, `[graph] FSM 事件 (${node.id}) 未填写事件名，已跳过`);
          return;
        }
        for (const t of targets) {
          try {
            k.logicApi.fire({ id: t.id }, ev);
            k.log(`fire-ok:${node.id}`, `[graph] FSM 事件：${t.id} ← ${ev}`, 5);
          } catch (e) {
            k.warnOnce(`fire-fail:${node.id}:${t.id}`, `[graph] FSM 事件发送失败（${t.id} 可能没有状态机运行器）: ${errText(e)}`);
          }
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-drivers：帧驱动 + 实例态（基准位/相位/路径下标随 DriverInstance 走）
// ---------------------------------------------------------------------------

/** 路径点巡回去重距离（米） */
const WAYPOINT_ARRIVE = 0.3;
/** 追击停止距离（米） */
const CHASE_STOP = 0.05;
/** 追击重寻路间隔（秒；目标移动超过 CHASE_REPATH_DIST 提前触发） */
const CHASE_REPATH = 0.4;
/** 触发提前重寻路的目标位移（米） */
const CHASE_REPATH_DIST = 1;
/** 追击路径点到达距离（米；路径已按代理半径拉直，点距较疏） */
const CHASE_PATH_ARRIVE = 0.35;

/**
 * 朝向移动方向：按本帧位移（移动者父空间水平分量）写 yaw。
 * 与导航代理同一约定（+Z 前向、atan2(dx,dz)、只写 rotation.y 不清 x/z，
 * 避免破坏与其它驱动器组合的姿态）；位移没有水平分量（垂直移动/未动）不改朝向。
 */
function faceMoveDir(face: boolean, obj: NodeObj, dx: number, dz: number): void {
  if (!face) return;
  if (Math.hypot(dx, dz) > 1e-6) obj.rotation.y = Math.atan2(dx, dz);
}

export function createCoreDriversModule(): GraphRuntimeModule {
  return {
    id: "core-drivers",
    drivers: {
      // 持续旋转：每帧按角速度（度/秒）累计
      "op.spin": (k, node) => ({
        step(dt, targets) {
          const dx = k.numP(node, "speedX") * DEG * dt;
          const dy = k.numP(node, "speedY", 45) * DEG * dt;
          const dz = k.numP(node, "speedZ") * DEG * dt;
          for (const t of targets) {
            if (dx) t.obj.rotation.x += dx;
            if (dy) t.obj.rotation.y += dy;
            if (dz) t.obj.rotation.z += dz;
          }
        },
      }),
      // 上下浮动：正弦往复平移 Y（以 boot 捕获的基准位为准）
      "op.bob": (k, node) => {
        const baseY = new Map<string, number>();
        return {
          boot(targets) {
            for (const t of targets) baseY.set(t.id, t.obj.position.y);
          },
          step(dt, targets) {
            void dt;
            const amp = k.numP(node, "amplitude");
            const period = k.numP(node, "period", 2);
            if (period <= 0 || !amp) return;
            const y = amp * Math.sin((k.elapsed() / period) * Math.PI * 2);
            for (const t of targets) {
              const base = baseY.get(t.id) ?? t.obj.position.y;
              t.obj.position.y = base + y;
            }
          },
        };
      },
      // 路径巡逻：路径口接入路径点 → 依次巡回；未接 → 沿轴在起点与起点+距离间往返
      "op.patrol": (k, node) => {
        /** 巡逻相位（target.id → 秒；周期由 距离/速度 推导） */
        const phase = new Map<string, number>();
        /** 巡逻基准位置（target.id → 首次执行时的世界坐标） */
        const base = new Map<string, { x: number; y: number; z: number }>();
        /** 路径点模式：当前巡回的路径点下标 */
        const wpIdx = new Map<string, number>();
        return {
          step(dt, targets) {
            // 路径点模式：路径口接入的实体位置即路径点（多入按连线顺序巡回）。
            // 路径口接的是「实体集」输出（获取子级/匹配/原型等）；ForEach「当前」
            // 一类遍历期引脚在帧驱动器求值时不在遍历上下文，解析为空 → 回退轴往返
            const waypointEdges = k.graph.edges.filter((e) => e.dstNode === node.id && e.dstPort === "path");
            const waypoints = k.evalInputs(node.id, "path").map(unwrapEntity).filter((v): v is NodeObj => !!v);
            if (!waypoints.length && waypointEdges.length) {
              const src = k.nodeOf(waypointEdges[0].srcNode);
              k.warnOnce(
                `patrol-path-empty:${node.id}`,
                `[graph] 路径巡逻 (${node.id}) 的「路径点」口已接线（源：${src?.type ?? "?"}）但解析不到实体，已回退为轴往返——` +
                  `路径点请直接接实体集输出（获取子级/匹配/原型）；ForEach「当前」是遍历期引脚（帧驱动器求值时不在遍历上下文，取不到值）`,
              );
            }
            if (!waypoints.length && !waypointEdges.length) {
              k.log(
                `patrol-axis:${node.id}`,
                `[graph] 路径巡逻 (${node.id}) 未接路径点 → 轴往返模式（轴 ${k.strP(node, "axis", "x")}，距离 ${k.numP(node, "distance", 6)}，速度 ${k.numP(node, "speed", 2)}）`,
              );
            }
            if (waypoints.length) {
              const speed = k.numP(node, "speed", 2);
              const face = k.boolP(node, "faceMove", true);
              for (const t of targets) {
                const idx = wpIdx.get(t.id) ?? 0;
                const wp = waypoints[idx % waypoints.length];
                if (!wp) continue;
                // 路径点与移动者常挂在不同父级下（子级挂在父实体下、移动者在别处），
                // 局部坐标不可比：一律在世界坐标下判定到达/计算方向，写回时换算回父空间
                if (wp.obj === t.obj || isDescendantOf(wp.obj, t.obj)) {
                  k.warnOnce(
                    `patrol-self-wp:${node.id}:${t.id}`,
                    `[graph] 路径巡逻 (${node.id})：路径点 ${wp.id} 是移动者自身或其子级——其位置随移动者一起移动，巡逻永远到不了；路径点应为独立实体`,
                  );
                  wpIdx.set(t.id, (idx + 1) % waypoints.length);
                  continue;
                }
                const moverWorld = worldPos(t.obj);
                const wpWorld = worldPos(wp.obj);
                if (Math.hypot(moverWorld.x - wpWorld.x, moverWorld.y - wpWorld.y, moverWorld.z - wpWorld.z) < WAYPOINT_ARRIVE) {
                  wpIdx.set(t.id, (idx + 1) % waypoints.length);
                  continue;
                }
                const target = t.obj.position.clone(); // 借位 Vector3 实例（不引入 THREE 值导入）
                wp.obj.getWorldPosition(target);
                t.obj.parent?.worldToLocal(target); // 世界 → 移动者父空间
                const dx = target.x - t.obj.position.x;
                const dy = target.y - t.obj.position.y;
                const dz = target.z - t.obj.position.z;
                const len = Math.hypot(dx, dy, dz);
                if (!len) continue;
                // 步长按世界单位折算（父级带缩放时仍保持 speed units/s）
                const step = (speed * dt) / Math.hypot(moverWorld.x - wpWorld.x, moverWorld.y - wpWorld.y, moverWorld.z - wpWorld.z);
                t.obj.position.x += dx * step;
                t.obj.position.y += dy * step;
                t.obj.position.z += dz * step;
                faceMoveDir(face, t.obj, dx, dz);
              }
              return;
            }
            // 轴往返模式：沿轴在起点与起点+距离之间三角波往返
            const dist = k.numP(node, "distance", 6);
            const speed = k.numP(node, "speed", 2);
            const axis = k.strP(node, "axis", "x");
            const period = speed > 0 && dist > 0 ? (2 * dist) / speed : 0;
            if (period <= 0) return;
            const faceAxis = k.boolP(node, "faceMove", true);
            for (const t of targets) {
              let b = base.get(t.id);
              if (!b) {
                b = { x: t.obj.position.x, y: t.obj.position.y, z: t.obj.position.z };
                base.set(t.id, b);
              }
              let ph = (phase.get(t.id) ?? 0) + dt;
              if (ph >= period) ph -= period;
              phase.set(t.id, ph);
              const half = period / 2;
              const off = (ph < half ? ph : period - ph) * speed;
              const prevX = t.obj.position.x;
              const prevZ = t.obj.position.z;
              if (axis === "z") t.obj.position.z = b.z + off;
              else if (axis === "y") t.obj.position.y = b.y + off;
              else t.obj.position.x = b.x + off;
              // 往返折返点处位移自然反号，朝向随移动方向翻转
              faceMoveDir(faceAxis, t.obj, t.obj.position.x - prevX, t.obj.position.z - prevZ);
            }
          },
        };
      },
      // 追击目标：每帧朝 prey 引脚实体移动。场景有导航区域 → 按烘焙网格 A*
      // 寻路沿平滑路径绕行障碍（定期重寻路跟随机动目标）；无导航运行时/区域
      // 不可达 → 回退直线移动（原行为）
      "op.chase": (k, node) => {
        /** 每目标寻路状态（pts=null 表示当前不可达，倒计时后重试） */
        const navPaths = new Map<
          string,
          { pts: { x: number; y: number; z: number }[] | null; seg: number; preyX: number; preyZ: number; t: number } | undefined
        >();
        return {
          step(dt, targets) {
            const prey = unwrapEntity(k.evalInput(node.id, "prey"));
            if (!prey) {
              k.warnOnce(
                `chase-noprey:${node.id}`,
                `[graph] 追击目标 (${node.id}) 的「追击目标」口未接入实体（不移动）——接入原型/匹配/获取子级`,
              );
              return;
            }
            const speed = k.numP(node, "speed", 3);
            const face = k.boolP(node, "faceMove", true);
            const pathBetween = k.navApi?.pathBetween?.bind(k.navApi);
            for (const t of targets) {
              // 同巡逻：跨父级时局部坐标不可比，一律世界坐标判定/换向
              if (prey.obj === t.obj || isDescendantOf(prey.obj, t.obj)) continue;
              const moverWorld = worldPos(t.obj);
              const preyWorld = worldPos(prey.obj);
              const worldDist = Math.hypot(moverWorld.x - preyWorld.x, moverWorld.y - preyWorld.y, moverWorld.z - preyWorld.z);
              if (worldDist < CHASE_STOP) continue;

              // 寻路跟随：按间隔（或目标位移超限）重寻路；路径点贴地，绕行障碍
              let moved = false;
              if (pathBetween) {
                let st = navPaths.get(t.id);
                if (
                  !st ||
                  (st.t -= dt) <= 0 ||
                  Math.hypot(preyWorld.x - st.preyX, preyWorld.z - st.preyZ) > CHASE_REPATH_DIST
                ) {
                  const pts = pathBetween({ x: moverWorld.x, z: moverWorld.z }, { x: preyWorld.x, z: preyWorld.z });
                  st = { pts: pts && pts.length > 1 ? pts : null, seg: 1, preyX: preyWorld.x, preyZ: preyWorld.z, t: CHASE_REPATH };
                  navPaths.set(t.id, st);
                }
                const pts = st.pts;
                const wp = pts?.[st.seg];
                if (wp) {
                  if (
                    Math.hypot(moverWorld.x - wp.x, moverWorld.z - wp.z) < CHASE_PATH_ARRIVE &&
                    st.seg < pts!.length - 1
                  ) {
                    st.seg++;
                  }
                  const cur = pts![st.seg];
                  const target = t.obj.position.clone(); // 借位 Vector3 实例（不引入 THREE 值导入）
                  target.set(cur.x, cur.y, cur.z);
                  t.obj.parent?.worldToLocal(target);
                  const dx = target.x - t.obj.position.x;
                  const dy = target.y - t.obj.position.y;
                  const dz = target.z - t.obj.position.z;
                  const wpDist = Math.hypot(moverWorld.x - cur.x, moverWorld.y - cur.y, moverWorld.z - cur.z);
                  if (wpDist > 1e-6) {
                    const step = (speed * dt) / wpDist;
                    t.obj.position.x += dx * step;
                    t.obj.position.y += dy * step;
                    t.obj.position.z += dz * step;
                    faceMoveDir(face, t.obj, dx, dz);
                    moved = true;
                  }
                }
              }
              if (!moved) {
                // 回退：直线移动（无导航运行时 / 不可达 / 无路径点）
                const target = t.obj.position.clone();
                prey.obj.getWorldPosition(target);
                t.obj.parent?.worldToLocal(target);
                const dx = target.x - t.obj.position.x;
                const dy = target.y - t.obj.position.y;
                const dz = target.z - t.obj.position.z;
                const step = (speed * dt) / worldDist;
                t.obj.position.x += dx * step;
                t.obj.position.y += dy * step;
                t.obj.position.z += dz * step;
                faceMoveDir(face, t.obj, dx, dz);
              }
            }
          },
        };
      },
      // 导航移动：每帧贴合导航代理位姿（位置 + 朝向 + 高度偏移）
      "op.navMove": (k, node) => ({
        step(_dt, targets) {
          const agent = unwrapEntity(k.evalInput(node.id, "agent"));
          if (!agent) {
            k.warnOnce(
              `navmove-noagent:${node.id}`,
              `[graph] 导航移动 (${node.id}) 的「导航代理」口未接入实体（不移动）——接入 Nav Agent 原型卡`,
            );
            return;
          }
          const yOff = k.numP(node, "yOffset", 0);
          for (const t of targets) {
            t.obj.position.x = agent.obj.position.x;
            t.obj.position.y = agent.obj.position.y + yOff;
            t.obj.position.z = agent.obj.position.z;
            t.obj.rotation.y = agent.obj.rotation.y;
          }
        },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// core-data：拉模型数据求值
// ---------------------------------------------------------------------------

/** 自定义节点表达式（编译缓存；inputIds + fieldKeys + Math 注入） */
interface CompiledExpr {
  fn: (...args: unknown[]) => unknown;
  inputIds: string[];
  fieldKeys: string[];
}

export function createCoreDataModule(): GraphRuntimeModule {
  // 自定义节点表达式编译缓存（type\0port → 编译产物；null = 无可编译表达式）
  const customExprCache = new Map<string, CompiledExpr | null>();
  const customDefMap = new Map<string, GCustomNodeDef>();
  let customInited = false;
  function initCustom(k: GraphKernel): void {
    if (customInited) return;
    customInited = true;
    for (const def of k.graph.customNodes ?? []) {
      customDefMap.set(def.type, def);
      for (const out of def.outputs ?? []) {
        const expr = def.expressions?.[out.id];
        if (!expr) {
          customExprCache.set(`${def.type}\u0000${out.id}`, null);
          continue;
        }
        const inputIds = (def.inputs ?? []).map((p) => p.id);
        const fieldKeys = (def.fields ?? []).map((f) => f.key);
        try {
          const fn = new Function(...inputIds, ...fieldKeys, "Math", `"use strict"; return (${expr});`) as (...args: unknown[]) => unknown;
          customExprCache.set(`${def.type}\u0000${out.id}`, { fn, inputIds, fieldKeys });
        } catch {
          customExprCache.set(`${def.type}\u0000${out.id}`, null);
        }
      }
    }
  }

  // 数学节点：标量二元/一元求值工厂
  const numIn = (k: GraphKernel, node: GNode, port: string): number => toNum(k.evalInput(node.id, port));

  /** 比较运算符求值（与框架层 G_COMPARE_OPERATORS 语义一致；此处为运行时自持副本） */
  function compareValues(an: number, op: string, bn: number): boolean {
    switch (op) {
      case ">": return an > bn;
      case "<": return an < bn;
      case "==": return an === bn;
      case ">=": return an >= bn;
      case "<=": return an <= bn;
      case "!=": return an !== bn;
      default: return false;
    }
  }

  return {
    id: "core-data",
    data: {
      "var.get": (k, node, portId) => {
        if (portId !== "value") return undefined;
        if (!node.varId) {
          k.warnOnce(`var-unbound:${node.id}`, `[graph] Get 变量 (${node.id}) 未绑定图变量，输出空值——在检查器选择变量`);
          return null;
        }
        return k.varGet(node.varId);
      },
      // var.set：输出 = 已写入的值（exec 链执行时写入 varStore，此处读回）
      "var.set": (k, node, portId) => (portId === "value" ? k.varGet(node.varId ?? "") : undefined),
      // flow.compare：a op b → boolean（B 引脚未连线时回退 params.b 参数值）
      "flow.compare": (k, node, portId) => {
        if (portId !== "result") return undefined;
        const an = numIn(k, node, "a");
        const bRaw = k.evalInput(node.id, "b");
        const bn = bRaw === null ? k.numP(node, "b") : toNum(bRaw);
        const op = k.strP(node, "operator", ">");
        if (!COMPARE_OPERATORS.includes(op)) {
          k.warnOnce(`compare-badop:${node.id}:${op}`, `[graph] 比较卡 (${node.id}) 运算符「${op}」非法（可选 ${COMPARE_OPERATORS.join(" ")}），结果恒为假`);
          return false;
        }
        return compareValues(an, op, bn);
      },
      "flow.for": (k, node, portId) => (portId === "index" ? k.loopIndex(node.id) ?? 0 : undefined),
      "flow.forEach": (k, node, portId) => {
        if (portId !== "item") return undefined;
        const item = k.loopItem(node.id);
        return item ? [item] : null;
      },
      // 算术
      "math.add": (k, node) => numIn(k, node, "a") + numIn(k, node, "b"),
      "math.sub": (k, node) => numIn(k, node, "a") - numIn(k, node, "b"),
      "math.mul": (k, node) => numIn(k, node, "a") * numIn(k, node, "b"),
      "math.div": (k, node) => {
        const bv = numIn(k, node, "b");
        if (bv === 0) {
          k.warnOnce(`div-zero:${node.id}`, `[graph] 除法 (${node.id}) 除数为 0（回退 0）——检查除数连线/参数`);
          return 0;
        }
        return numIn(k, node, "a") / bv;
      },
      "math.mod": (k, node) => {
        const bv = numIn(k, node, "b");
        if (bv === 0) {
          k.warnOnce(`mod-zero:${node.id}`, `[graph] 取余 (${node.id}) 除数为 0（回退 0）——检查除数连线/参数`);
          return 0;
        }
        return numIn(k, node, "a") % bv;
      },
      // 三角（角度制输入）
      "math.sin": (k, node) => Math.sin(numIn(k, node, "a") * DEG),
      "math.cos": (k, node) => Math.cos(numIn(k, node, "a") * DEG),
      "math.tan": (k, node) => Math.tan(numIn(k, node, "a") * DEG),
      // 向量
      "math.vec3Make": (k, node, portId) =>
        portId === "v"
          ? { x: numIn(k, node, "x"), y: numIn(k, node, "y"), z: numIn(k, node, "z") }
          : null,
      "math.vec3Break": (k, node, portId) => {
        const v = k.evalInput(node.id, "v");
        const vec = (v && typeof v === "object" && !Array.isArray(v) && "x" in v && "y" in v && "z" in v)
          ? (v as { x: number; y: number; z: number })
          : { x: 0, y: 0, z: 0 };
        if (portId === "x") return vec.x;
        if (portId === "y") return vec.y;
        if (portId === "z") return vec.z;
        return null;
      },
      // 字符串
      "math.stringConcat": (k, node) => toStr(k.evalInput(node.id, "a")) + toStr(k.evalInput(node.id, "b")),
      "math.toString": (k, node) => toStr(k.evalInput(node.id, "value")),
      // 插值/工具
      "math.lerp": (k, node) => { const av = numIn(k, node, "a"), bv = numIn(k, node, "b"), t = numIn(k, node, "t"); return av + (bv - av) * t; },
      "math.clamp": (k, node) => Math.max(numIn(k, node, "min"), Math.min(numIn(k, node, "max"), numIn(k, node, "value"))),
      "math.abs": (k, node) => Math.abs(numIn(k, node, "a")),
      // 属性读取卡：实体集通道取首个实体，按通用属性路径拉取该实体自身的任意属性
      // （position.x / rotation.y(度) / worldPosition.z / visible / light.intensity /
      //   material.opacity / userData.key / script:<路径>:<属性>；子级先经获取子级/ForEach 换目标）
      "entity.prop": (k, node, portId) => {
        if (portId !== "value") return undefined;
        const path = k.strP(node, "property");
        const ent = unwrapEntity(k.evalInput(node.id, "target"));
        if (!ent) {
          // 实体口空（未接线/上游实体缺失）时静默回 null 会表现为"值恒为空"
          k.warnOnce(
            `prop-no-entity:${node.id}`,
            `[graph] 属性读取 (${node.id}) 的「实体」口未解析到实体（输出空值）——接入原型/匹配/获取子级或 ForEach「当前」`,
          );
          return null;
        }
        const v = readPropPath(ent, path, k.scriptApi);
        if (v === null && path) {
          // 路径拼错/该实体没有该属性：一次性可定位告警（逐帧拉取不刷屏）
          k.warnOnce(
            `prop-miss:${node.id}:${path}`,
            `[graph] 属性读取 (${node.id}) 路径「${path}」在实体 ${ent.id} 上不可读（检查路径拼写；可用路径见检查器候选）`,
          );
        }
        return v;
      },
      // 感知：两实体世界距离（原型卡接线后每帧拉取求值）
      "sense.distance": (k, node) => {
        const from = unwrapEntity(k.evalInput(node.id, "from"));
        const to = unwrapEntity(k.evalInput(node.id, "to"));
        if (!from || !to) {
          // 缺输入时回退 0：若静默，用户会看到"距离恒为 0"却不知原因
          k.warnOnce(
            `sense-miss:${node.id}`,
            `[graph] 实体距离 (${node.id}) 的「从/到」未接入实体（回退 0）——两端口都需连接原型/匹配/获取子级等实体源`,
          );
          return 0;
        }
        const a = worldPos(from.obj);
        const b = worldPos(to.obj);
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      },
    },
    // 自定义节点（expression 能力类型）：按输出端口的 JS 表达式求值
    prefixData: {
      "custom.": (k, node, portId) => {
        initCustom(k);
        const compiled = customExprCache.get(`${node.type}\u0000${portId}`);
        if (!compiled) return null;
        const args: unknown[] = [];
        for (const id of compiled.inputIds) args.push(k.evalInput(node.id, id));
        for (const key of compiled.fieldKeys) {
          const def = customDefMap.get(node.type);
          const f = def?.fields?.find((x) => x.key === key);
          const v = node.params?.[key];
          if (f?.kind === "number") args.push(typeof v === "number" ? v : (f.fallback as number));
          else if (f?.kind === "boolean") args.push(v === true);
          else args.push(typeof v === "string" ? v : (f?.fallback as string ?? ""));
        }
        args.push(Math);
        try {
          return compiled.fn(...args) as DataValue;
        } catch (e) {
          // 表达式运行时异常（引用未定义变量/类型错误）：静默 null 会让卡片"看起来没接对"
          k.warnOnce(
            `custom-fail:${node.id}:${portId}`,
            `[graph] 自定义节点「${node.title || node.type}」(${node.id}) 表达式求值失败（端口 ${portId}）：${errText(e)}`,
          );
          return null;
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-exec：执行链路由节点（var.set / flow.*）
// ---------------------------------------------------------------------------

/** flow.for 最大迭代数（防参数错致页面冻结） */
const FOR_MAX_ITER = 100000;
/** flow.while 最大迭代数（防死循环） */
const WHILE_MAX_ITER = 10000;

export function createCoreExecModule(): GraphRuntimeModule {
  return {
    id: "core-exec",
    executors: {
      // var.set：从 value 入引脚拉取数据 → 写入图变量 → 级联 next
      "var.set": (k, node, ec) => {
        const val = k.evalInput(node.id, "value");
        if (val !== null) k.varSet(node.varId ?? "", val);
        k.cascadeNext(node, ec);
      },
      // flow.branch：条件选择 true/false 分支（分支名兼作容器事件名）
      "flow.branch": (k, node, ec) => {
        const cond = k.evalInput(node.id, "condition") === true;
        const port = cond ? "true" : "false";
        k.log(
          `branch:${node.id}`,
          `[graph] 分支 (${node.id}) 条件=${cond ? "真" : "假"} → 走「${cond ? "真" : "假"}」分支（条件来源：${k.graph.edges.find((e) => e.dstNode === node.id && e.dstPort === "condition")?.srcNode ?? "未连线（恒假）"}）`,
          3,
        );
        for (const t of k.execTargetsOf(node.id, port)) {
          k.cascade(t.id, { seen: ec.seen, viaSrcPort: port, viaDstPort: t.dstPort, eventName: ec.fireEv || port });
        }
      },
      // flow.compare：纯数据节点，exec 链中不执行（由数据求值处理），链路透传
      "flow.compare": (k, node, ec) => {
        k.cascadeNext(node, ec);
      },
      // flow.for：计数循环（每次触发 loop，索引可拉取）
      "flow.for": (k, node, ec) => {
        const start = k.numP(node, "start", 0);
        const end = k.numP(node, "end", 10);
        const step = k.numP(node, "step", 1);
        const loop = k.execTargetsOf(node.id, "loop");
        const completed = k.execTargetsOf(node.id, "completed");
        let iter = 0;
        for (let i = start; (step > 0 ? i < end : i > end) && iter < FOR_MAX_ITER; i += step, iter++) {
          k.setLoopIndex(node.id, i);
          for (const t of loop) k.cascade(t.id, { seen: new Set(), viaSrcPort: "loop", viaDstPort: t.dstPort, eventName: ec.fireEv });
        }
        k.clearLoopIndex(node.id);
        for (const t of completed) k.cascade(t.id, { seen: ec.seen, viaSrcPort: "completed", viaDstPort: t.dstPort, eventName: ec.fireEv });
      },
      // flow.forEach：实体集遍历（当前实体可拉取）
      "flow.forEach": (k, node, ec) => {
        const items = unwrapEntities(k.evalInput(node.id, "array"));
        const loop = k.execTargetsOf(node.id, "loop");
        const completed = k.execTargetsOf(node.id, "completed");
        if (!items.length) {
          k.warnOnce(
            `foreach-empty:${node.id}`,
            `[graph] ForEach 循环 (${node.id}) 的「集合」为空，循环体不执行（直接走「完成」分支）——检查上游实体集（原型/匹配/获取子级）`,
          );
        }
        k.log(`foreach:${node.id}`, `[graph] ForEach 循环 (${node.id}) 遍历 ${items.length} 个实体`, 3);
        for (const item of items) {
          k.setLoopItem(node.id, item);
          for (const t of loop) k.cascade(t.id, { seen: new Set(), viaSrcPort: "loop", viaDstPort: t.dstPort, eventName: ec.fireEv });
        }
        // 遍历期结束：「当前」引脚回归空。帧驱动器（巡逻/追击等）每帧求值时
        // 不在遍历上下文，若不清空会读到"最后一个元素"这一过期值
        k.clearLoopItem(node.id);
        for (const t of completed) k.cascade(t.id, { seen: ec.seen, viaSrcPort: "completed", viaDstPort: t.dstPort, eventName: ec.fireEv });
      },
      // flow.while：条件循环（最多 WHILE_MAX_ITER 次防死循环）
      "flow.while": (k, node, ec) => {
        const loop = k.execTargetsOf(node.id, "loop");
        const completed = k.execTargetsOf(node.id, "completed");
        for (let i = 0; i < WHILE_MAX_ITER; i++) {
          if (k.evalInput(node.id, "condition") !== true) break;
          for (const t of loop) k.cascade(t.id, { seen: new Set(), viaSrcPort: "loop", viaDstPort: t.dstPort, eventName: ec.fireEv });
        }
        for (const t of completed) k.cascade(t.id, { seen: ec.seen, viaSrcPort: "completed", viaDstPort: t.dstPort, eventName: ec.fireEv });
      },
      // 中断开关：电路开关式通断——「开/关」控制口触发翻转锁存（侧链，不透传
      // 级联）；主链路级联仅在导通时放行。断开时下游执行链不级联、下游帧驱动器
      // 暂停步进（kernel driverGated 门控），「开」恢复后从当前状态继续
      "flow.gate": (k, node, ec) => {
        if (ec.viaDstPort === "on" || ec.viaDstPort === "off") {
          const open = ec.viaDstPort === "on";
          k.setGateOpen(node.id, open);
          k.log(
            `gate-flip:${node.id}:${open ? "on" : "off"}`,
            `[graph] 中断开关 (${node.id}) ${open ? "闭合 → 下游恢复" : "断开 → 下游中断（执行链不级联、帧驱动器暂停步进）"}`,
            3,
          );
          return;
        }
        if (!k.gateOpen(node.id)) {
          k.log(
            `gate-block:${node.id}`,
            `[graph] 中断开关 (${node.id}) 断开中，下游执行链与帧驱动器已中断——触发「开」口恢复`,
            3,
          );
          return;
        }
        k.cascadeNext(node, ec);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-containers：逻辑容器行为（fsm 状态机 / bt 行为树；可嵌套）
// ---------------------------------------------------------------------------

/** 追击类型键（容器帧钩子据此收集本帧被追击实体 → 暂停其导航巡回） */
const CHASE_TYPE = "op.chase";

export function createCoreContainersModule(): GraphRuntimeModule {
  /** FSM 容器当前状态（containerId → 状态名；未激活无键） */
  const fsmCurrent = new Map<string, string>();
  /** FSM 条件边上一次求值（containerId\0srcId → 上帧结果；上升沿触发切换） */
  const fsmCondState = new Map<string, boolean>();
  /** 追击涉及的实体（本帧暂停其导航巡回，追击结束自动恢复；跨容器聚合） */
  let navPausedTargets = new Set<string>();
  /** 本帧追击目标聚合（全部容器 frame 后统一 flush，与旧 driveFsmContainers 时序一致） */
  let chaseTargetsNow = new Set<string>();

  /**
   * FSM 进入/事件切换：exec 入「进入」激活 initial；「event」入端口按事件名切换。
   * 激活状态 = 执行 containerId 归属且 stateName 匹配（无标签则任意状态）的
   * 直接子节点链，随后级联容器 next 下游。
   * 迁移守卫（guards，from>to 列表）：列出的迁移只允许从 from 出发，未列出的
   * 迁移不受限；尚未激活时无当前状态可比，放行（守卫约束「迁移」而非初次进入）。
   * 同状态去重：已在目标状态且未勾选「重复进入」→ 忽略（入口链与下游不重跑）；
   * 去重先于守卫——同状态短路是无条件的，守卫只裁决真正的状态变更。
   */
  function fsmSwitch(k: GraphKernel, node: GNode, seen: Set<string>, evName: string, viaDstPort: string): void {
    const states = k.strP(node, "states").split(",").map((s) => s.trim()).filter(Boolean);
    if (!states.length) {
      k.warnOnce(
        `fsm-no-states:${node.id}`,
        `[graph] 状态机容器 (${node.id}) 未配置状态列表，状态切换被忽略——把携带 .fsm 的原型卡连到「作用域」自动读取，或在检查器填写状态列表`,
      );
      return;
    }
    const initial = k.strP(node, "initial", states[0]) || states[0];
    let target: string;
    if (viaDstPort === "event" || viaDstPort === "condition") {
      // 命名切换事件：容器「切换事件」表（事件>状态）把事件名映射到目标状态，
      // 事件名因此可与状态名解耦；事件名恰为状态名时直接按状态切换（向后兼容）
      const byEvent = new Map<string, string>();
      for (const rule of k.strP(node, "transitions").split(/[，,]/)) {
        const gt = rule.indexOf(">");
        if (gt <= 0) continue;
        const evt = rule.slice(0, gt).trim();
        const st = rule.slice(gt + 1).trim();
        if (evt && states.includes(st)) byEvent.set(evt, st);
      }
      if (evName && byEvent.has(evName)) {
        target = byEvent.get(evName)!;
      } else if (evName && states.includes(evName)) {
        target = evName;
      } else {
        // 非状态事件且无映射忽略（拼错事件名/比较卡未填触发事件名时的静默失效可定位）
        k.warnOnce(
          `fsm-bad-event:${node.id}:${evName}`,
          `[graph] 状态机容器 (${node.id}) 收到事件「${evName || "(空)"}」，既不是状态名也不在「切换事件」映射里（状态：${states.join(", ")}）——检查来源卡片的事件名/比较卡「触发事件名」/容器「切换事件」`,
        );
        return;
      }
    } else {
      target = states.includes(initial) ? initial : states[0];
    }
    const prev = fsmCurrent.get(node.id);
    if (prev === target && !k.boolP(node, "reentry")) {
      k.log(
        `fsm-same:${node.id}:${target}`,
        `[graph] 状态机容器 (${node.id}) 已处于状态「${target}」，忽略重复切换（勾选「重复进入」可重入）`,
        3,
      );
      return;
    }
    if (prev !== undefined && (viaDstPort === "event" || viaDstPort === "condition")) {
      for (const rule of k.strP(node, "guards").split(/[，,]/)) {
        const gt = rule.indexOf(">");
        if (gt <= 0) continue;
        const from = rule.slice(0, gt).trim();
        const to = rule.slice(gt + 1).trim();
        if (!to) continue;
        if (to === target && from !== prev) {
          k.log(
            `fsm-guard:${node.id}:${from}>${to}`,
            `[graph] 状态机容器 (${node.id}) 迁移守卫 ${from}>${to}：当前状态「${prev}」不允许切到「${target}」，触发已忽略`,
            3,
          );
          return;
        }
      }
    }
    fsmCurrent.set(node.id, target);
    k.log(
      `fsm-switch:${node.id}:${target}`,
      `[graph] 状态机容器 (${node.id}) ${prev === undefined ? "进入" : `${prev} →`} 状态「${target}」（${viaDstPort === "condition" ? "条件上升沿" : viaDstPort === "event" ? "事件" : "进入端口"}）`,
      3,
    );
    // 执行归属当前状态的直接子节点链（无状态标签的子节点任意状态都执行）
    for (const child of k.containerChildren(node.id)) {
      if (child.stateName && child.stateName !== target) continue;
      k.cascade(child.id, { seen: new Set(), viaSrcPort: "next", viaDstPort: "exec" });
    }
    // 状态切换完成 → 容器 next 下游（事件名沿用触发方/新状态）
    for (const t of k.execTargetsOf(node.id, "next")) {
      k.cascade(t.id, { seen, viaSrcPort: "next", viaDstPort: t.dstPort, eventName: evName || target });
    }
  }

  const fsm: ContainerBehavior = {
    enter(k, node, ec) {
      fsmSwitch(k, node, ec.seen, ec.eventName || ec.viaSrcPort, ec.viaDstPort);
    },
    childActive(_k, container, child) {
      const cur = fsmCurrent.get(container.id);
      // FSM 未激活（无入边驱动的纯整理容器）视为全状态可用
      if (cur !== undefined && child.stateName && child.stateName !== cur) return false;
      return true;
    },
    frame(k, node, dt) {
      // 条件边轮询：源数据节点 result 引脚上升沿 → 按源卡「触发事件名」切换状态。
      // 「条件」口（布尔数据边）+「事件」口（旧图兼容）一并轮询
      for (const e of k.graph.edges) {
        if (e.dstNode !== node.id || (e.dstPort !== "condition" && e.dstPort !== "event")) continue;
        const src = k.nodeOf(e.srcNode);
        if (!src || src.unresolved) continue;
        const key = `${node.id}\u0000${e.srcNode}`;
        const nowTrue = k.evalOutput(e.srcNode, "result") === true;
        const prev = fsmCondState.get(key);
        fsmCondState.set(key, nowTrue);
        if (nowTrue && prev === false) {
          fsmSwitch(k, node, new Set(), k.strP(src, "event"), e.dstPort);
        }
      }
      // 激活状态的子驱动器步进（纯容器驱动、不在全局 tick 链上的巡逻/追击/旋转等；
      // 已被 frameOps 步进的跳过，避免双重步进）
      const cur = fsmCurrent.get(node.id);
      if (cur === undefined) return;
      for (const child of k.containerChildren(node.id)) {
        if (child.stateName && child.stateName !== cur) continue;
        if (k.inFrameLoop(child.id)) continue;
        const targets = k.resolveTargets(child.id);
        if (!targets.length) continue;
        k.stepDriver(child, dt, targets);
        if (child.type === CHASE_TYPE) for (const tt of targets) chaseTargetsNow.add(tt.id);
      }
    },
    frameEnd(k) {
      // 追击目标 → 暂停导航巡回；脱离追击 → 恢复
      for (const id of chaseTargetsNow) {
        if (!navPausedTargets.has(id)) k.navApi?.setAgentPaused(id, true);
      }
      for (const id of navPausedTargets) {
        if (!chaseTargetsNow.has(id)) k.navApi?.setAgentPaused(id, false);
      }
      navPausedTargets = chaseTargetsNow;
      chaseTargetsNow = new Set();
    },
  };

  /** BT 容器激活态（containerId → 已进入过；激活后帧钩子才开始工作） */
  const btActive = new Set<string>();
  /** BT 容器重跑计时（containerId → 秒；interval > 0 时周期性重跑成员） */
  const btTimer = new Map<string, number>();

  /**
   * 按模式执行成员：
   * - sequence（顺序，默认）：按纵向顺序全部执行一遍；
   * - selector（选择）：条件口布尔源与成员按纵向顺序一一配对，执行第一个
   *   为真的条件所配对的成员（全假/无条件源不执行）；
   * - parallel（并行）：全部成员执行一遍，且激活期间每帧重跑全部成员链
   *   （驱动器由帧钩子步进，成员链放轻量卡片）。
   */
  function btRun(k: GraphKernel, node: GNode): void {
    const children = k.containerChildren(node.id);
    if (!children.length) {
      k.warnOnce(
        `bt-no-children:${node.id}`,
        `[graph] 行为树容器 (${node.id}) 内没有归属子节点，进入后不执行任何行为——把行为节点拖入容器框内即归属`,
      );
    }
    const mode = k.strP(node, "mode", "sequence") || "sequence";
    if (mode === "selector") {
      const conds = k.graph.edges
        .filter((e) => e.dstNode === node.id && e.dstPort === "condition")
        .map((e) => k.nodeOf(e.srcNode))
        .filter((s) => s && !s.unresolved)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      let picked = -1;
      for (let i = 0; i < conds.length && i < children.length; i++) {
        if (k.evalOutput(conds[i].id, "result") === true) {
          picked = i;
          break;
        }
      }
      if (children[picked]) k.cascade(children[picked].id, { seen: new Set(), viaSrcPort: "next", viaDstPort: "exec" });
      k.log(
        `bt-enter:${node.id}`,
        `[graph] 行为树容器 (${node.id}) 进入（选择）：${conds.length} 个条件源，命中第 ${picked + 1} 个成员`,
        3,
      );
      return;
    }
    for (const child of children) {
      if (!k.nodeActive(child)) continue;
      k.cascade(child.id, { seen: new Set(), viaSrcPort: "next", viaDstPort: "exec" });
    }
    k.log(`bt-enter:${node.id}`, `[graph] 行为树容器 (${node.id}) 进入：模式 ${mode}，按纵向顺序执行 ${children.length} 个归属节点`, 3);
  }

  /** 进入 BT 容器：按模式执行归属节点链，完成级联 next 下游；激活后帧钩子接管持续行为。
   *  「退出」口（dstPort exit）：停摆——帧驱动停止、成员驱动器冻结在当前位姿，再「进入」恢复 */
  const bt: ContainerBehavior = {
    enter(k, node, ec) {
      if (ec.viaDstPort === "exit") {
        const was = btActive.delete(node.id);
        btTimer.delete(node.id);
        if (was) {
          k.log(`bt-exit:${node.id}`, `[graph] 行为树容器 (${node.id}) 退出：帧驱动停摆（成员驱动器冻结，再「进入」恢复）`, 3);
        }
        return;
      }
      btActive.add(node.id);
      btTimer.set(node.id, 0);
      btRun(k, node);
      for (const t of k.execTargetsOf(node.id, "next")) {
        k.cascade(t.id, { seen: new Set(), viaSrcPort: "next", viaDstPort: t.dstPort, eventName: "" });
      }
    },
    frame(k, node, dt) {
      if (!btActive.has(node.id)) return;
      const mode = k.strP(node, "mode", "sequence") || "sequence";
      const children = k.containerChildren(node.id);
      // 激活后步进框内驱动器（与状态机容器同款；已被全局帧循环步进的跳过；
      // 成员在父链上不激活（如嵌套在状态机的非当前状态）不步进）
      for (const child of children) {
        if (k.inFrameLoop(child.id) || !k.nodeActive(child)) continue;
        const targets = k.resolveTargets(child.id);
        if (!targets.length) continue;
        k.stepDriver(child, dt, targets);
        if (child.type === CHASE_TYPE) for (const tt of targets) chaseTargetsNow.add(tt.id);
      }
      // parallel：每帧重跑全部成员链（激活期间的持续 tick 语义）
      if (mode === "parallel") {
        for (const child of children) {
          if (!k.nodeActive(child)) continue;
          k.cascade(child.id, { seen: new Set(), viaSrcPort: "next", viaDstPort: "exec" });
        }
        return;
      }
      // sequence / selector：按「重跑间隔」周期性重跑（0 = 仅进入时一次）
      const interval = k.numP(node, "interval", 0);
      if (interval > 0) {
        const t = (btTimer.get(node.id) ?? 0) + dt;
        if (t >= interval) {
          btTimer.set(node.id, t - interval);
          btRun(k, node);
        } else {
          btTimer.set(node.id, t);
        }
      }
    },
  };

  return {
    id: "core-containers",
    containers: {
      "fsm.container": fsm,
      "bt.container": bt,
    },
  };
}

/** 全部内置运行时模块（createGraphBehaviors 装配时按序合并） */
export function createCoreGraphModules(): GraphRuntimeModule[] {
  return [
    createCoreEntityModule(),
    createCoreOpsModule(),
    createCoreDriversModule(),
    createCoreDataModule(),
    createCoreExecModule(),
    createCoreContainersModule(),
  ];
}
