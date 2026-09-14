// ---------------------------------------------------------------------------
// 地形绘制/雕刻控制器（编辑器视口交互）：
// - 激活后接管视口左键：射线拾取活动地形的 chunk 网格 → 世界命中点 → 按会话
//   类型盖章（拖拽沿线插值防断触）；轨道相机的左键旋转被临时禁用（右键平移/
//   滚轮缩放保留），视口点选亦被引擎抑制；
// - 两种会话：
//   · paint（绘制材质层）：对 splatmap 工作缓冲盖章，落盘走应用层写 PNG 资产；
//   · sculpt（雕刻地形）：对高度偏移层盖章（抬升/压低/压平/平滑），落盘走
//     引擎 patchNode（节点 sculpt 字段，可撤销）；
// - "辅助笔刷"光标：贴地的圆环指示笔刷半径与命中位置（命中点 + 面法线偏移，
//   随面朝向倾斜）；
// - 落盘节流：绘制中每 100ms（rAF 调度）/ 抬笔时提交一次。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { TerrainNode } from "../../prototype/nodes/TerrainNode";
import {
  stampSplat,
  stampSplatLine,
  type SplatBuffer,
  type SplatBrush,
} from "../../terrain/paint";
import {
  stampSculpt,
  stampSculptLine,
  type SculptBrush,
  type SculptMode,
} from "../../terrain/sculpt";

/** 工具笔刷（应用层 UI 状态；两种工具共用半径/强度） */
export interface TerrainToolBrush {
  tool: "paint" | "sculpt";
  /** paint：目标材质层 0..3 */
  layer: number;
  radius: number;
  strength: number;
  /** paint：擦除该层 */
  erase: boolean;
  /** sculpt：雕刻模式 */
  sculptMode: SculptMode;
}

/** 绘制会话（begin 时建立；kind 决定盖章与提交路径） */
export type TerrainPaintSession =
  | {
      kind: "paint";
      node: TerrainNode;
      terrainObj: THREE.Object3D;
      buffer: SplatBuffer;
      splatRel: string;
    }
  | {
      kind: "sculpt";
      node: TerrainNode;
      terrainObj: THREE.Object3D;
      /** 程序化基准高度（不含雕刻） */
      base: Float32Array;
      /** 雕刻偏移工作副本 */
      offsets: Float32Array;
      gridN: number;
    };

export interface TerrainPaintDeps {
  dom: HTMLElement;
  scene: THREE.Scene;
  orbit: OrbitControls;
  /** 活动渲染相机（预览/相机节点激活时可能不是编辑器轨道相机） */
  getCamera(): THREE.Camera | null;
  /** 工具笔刷参数（应用层 UI 状态） */
  getBrush(): TerrainToolBrush;
  /** paint 会话节流落盘（应用层编码 PNG 写资产 + 失效缓存重载） */
  onCommitSplat(buffer: SplatBuffer, splatRel: string): void;
  /** sculpt 会话节流提交（引擎写节点 sculpt 字段并 patch） */
  onCommitSculpt(): void;
}

/** 笔画中两次提交的最小间隔（ms）；配合 rAF 调度，降低延迟且不阻塞主线程 */
const COMMIT_INTERVAL_MS = 100;

const CURSOR_COLOR = 0xffa040;
const CURSOR_LIFT = 0.15;

export class TerrainPaintController {
  /** 绘制模式开关（引擎 begin/end 维护；UI 读取） */
  active = false;

  private deps: TerrainPaintDeps;
  private session: TerrainPaintSession | null = null;
  private stroking = false;
  private lastLocal: { x: number; z: number } | null = null;
  /** flatten 模式的目标高度（笔画起点处的地形本地高度） */
  private strokeTargetY = 0;
  private lastCommit = 0;
  /** rAF 调度提交（避免在 pointermove 同步执行重建重活阻塞主线程） */
  private commitRafId = 0;
  private commitScheduled = false;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmpV = new THREE.Vector3();

  /** 贴地圆环光标（辅助笔刷可视化；挂场景，激活时可见） */
  private cursor: THREE.LineLoop;
  private savedMouseButtons: OrbitControls["mouseButtons"] | null = null;

  constructor(deps: TerrainPaintDeps) {
    this.deps = deps;
    this.cursor = this.buildCursor();
    this.cursor.visible = false;
    deps.scene.add(this.cursor);
    this.bind();
  }

  /** 地形材质层色（RGBA hex 数字，UI 层色按钮用） */
  static layerColorsOf(node: TerrainNode): number[] {
    const ms = node.materialSettings;
    return ms ? ms.layers.map((l) => l.color) : [];
  }

  /** 当前会话（引擎雕刻提交时读取工作副本） */
  getSession(): TerrainPaintSession | null {
    return this.session;
  }

  /**
   * 开始绘制会话（引擎校验通过后调用）：terrainObj 用于射线拾取与世界→地形
   * 本地换算（减去对象世界 XZ 原点，轴对齐假设与高度场采样一致）。
   */
  begin(session: TerrainPaintSession): void {
    this.session = session;
    this.active = true;
    this.stroking = false;
    this.lastCommit = 0;
    // 左键旋转让位给绘制；右键平移 / 滚轮缩放保留
    const orbit = this.deps.orbit;
    this.savedMouseButtons = orbit.mouseButtons;
    orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN } as OrbitControls["mouseButtons"];
  }

  /** 结束绘制（冲刷未落盘的笔画 + 恢复轨道相机） */
  end(): void {
    if (!this.active) return;
    this.cancelCommitRaf();
    if (this.stroking) this.commit();
    this.active = false;
    this.stroking = false;
    this.cursor.visible = false;
    if (this.savedMouseButtons) this.deps.orbit.mouseButtons = this.savedMouseButtons;
    this.savedMouseButtons = null;
    this.session = null;
    this.lastLocal = null;
  }

  dispose(): void {
    this.end();
    this.cancelCommitRaf();
    this.deps.scene.remove(this.cursor);
    (this.cursor.material as THREE.Material).dispose();
    this.cursor.geometry.dispose();
  }

  // —— 输入 ——

  private bind(): void {
    this.deps.dom.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.active || e.button !== 0) return;
    const hit = this.raycastTerrain(e);
    if (!hit) return;
    e.stopPropagation();
    this.stroking = true;
    // flatten 的目标高度 = 笔画起点处的地形本地高度
    this.strokeTargetY = hit.local.y;
    this.lastLocal = { x: hit.local.x, z: hit.local.z };
    this.stampAt(hit.local.x, hit.local.z);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.active) return;
    const hit = this.raycastTerrain(e);
    this.updateCursor(hit);
    if (!this.stroking || !hit) return;
    const from = this.lastLocal ?? hit.local;
    this.stampLine(from.x, from.z, hit.local.x, hit.local.z);
    this.lastLocal = { x: hit.local.x, z: hit.local.z };
    this.commitThrottled();
  };

  private onPointerUp = (): void => {
    if (!this.active || !this.stroking) return;
    this.stroking = false;
    this.lastLocal = null;
    this.cancelCommitRaf();
    this.commit();
  };

  // —— 拾取与盖章 ——

  private sessionTerrainSize(): number {
    return this.session?.node.terrain.size ?? 0;
  }

  private raycastTerrain(e: PointerEvent): { local: { x: number; y: number; z: number }; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const session = this.session;
    if (!session) return null;
    const camera = this.deps.getCamera();
    if (!camera) return null;
    const rect = this.deps.dom.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    const chunks = session.terrainObj.children.find((c) => c.name === "__terrainMesh");
    if (!chunks) return null;
    const hits = this.raycaster.intersectObject(chunks, true);
    const hit = hits[0];
    if (!hit) return null;
    // 世界 → 地形本地（XZ；轴对齐假设与高度场采样一致）
    session.terrainObj.updateMatrixWorld(true);
    const origin = session.terrainObj.getWorldPosition(this.tmpV);
    const local = { x: hit.point.x - origin.x, y: hit.point.y - origin.y, z: hit.point.z - origin.z };
    const size = this.sessionTerrainSize();
    const half = size / 2;
    if (Math.abs(local.x) > half || Math.abs(local.z) > half) return null;
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    return { local, point: hit.point, normal };
  }

  private stampAt(wx: number, wz: number): void {
    const s = this.session;
    if (!s) return;
    const b = this.deps.getBrush();
    if (s.kind === "paint") {
      const brush: SplatBrush = { layer: b.layer, radius: b.radius, strength: b.strength, erase: b.erase };
      stampSplat(s.buffer, this.sessionTerrainSize(), wx, wz, brush);
    } else {
      const brush: SculptBrush = { mode: b.sculptMode, radius: b.radius, strength: b.strength };
      stampSculpt(s.offsets, s.base, s.gridN, this.sessionTerrainSize(), wx, wz, brush, this.strokeTargetY);
    }
    this.commitThrottled();
  }

  private stampLine(x0: number, z0: number, x1: number, z1: number): void {
    const s = this.session;
    if (!s) return;
    const b = this.deps.getBrush();
    if (s.kind === "paint") {
      const brush: SplatBrush = { layer: b.layer, radius: b.radius, strength: b.strength, erase: b.erase };
      stampSplatLine(s.buffer, this.sessionTerrainSize(), x0, z0, x1, z1, brush);
    } else {
      const brush: SculptBrush = { mode: b.sculptMode, radius: b.radius, strength: b.strength };
      stampSculptLine(s.offsets, s.base, s.gridN, this.sessionTerrainSize(), x0, z0, x1, z1, brush, this.strokeTargetY);
    }
  }

  private commitThrottled(): void {
    if (this.commitScheduled) return;
    const now = performance.now();
    if (now - this.lastCommit < COMMIT_INTERVAL_MS) return;
    // 提交（重建/落盘）放到下一帧 rAF，避免在 pointermove 同步执行阻塞主线程
    this.commitScheduled = true;
    this.commitRafId = requestAnimationFrame(this.commitRun);
  }

  private commitRun = (): void => {
    this.commitScheduled = false;
    this.commitRafId = 0;
    this.commit();
  };

  private cancelCommitRaf(): void {
    if (this.commitRafId) cancelAnimationFrame(this.commitRafId);
    this.commitRafId = 0;
    this.commitScheduled = false;
  }

  private commit(): void {
    const s = this.session;
    if (!s) return;
    this.lastCommit = performance.now();
    if (s.kind === "paint") this.deps.onCommitSplat(s.buffer, s.splatRel);
    else this.deps.onCommitSculpt();
  }

  // —— 辅助光标 ——

  private buildCursor(): THREE.LineLoop {
    const segs = 64;
    const pts: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(Math.cos(a), 0, Math.sin(a));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color: CURSOR_COLOR, transparent: true, opacity: 0.9, depthWrite: false });
    const loop = new THREE.LineLoop(geo, mat);
    loop.name = "__terrainPaintCursor";
    loop.renderOrder = 10;
    return loop;
  }

  private updateCursor(hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null): void {
    if (!hit) {
      this.cursor.visible = false;
      return;
    }
    const r = this.deps.getBrush().radius;
    this.cursor.visible = true;
    this.cursor.position.copy(hit.point).addScaledVector(hit.normal, CURSOR_LIFT);
    this.cursor.scale.set(r, 1, r);
    // 圆环贴合命中面朝向（默认平铺 XZ 平面）
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.normal);
  }
}
