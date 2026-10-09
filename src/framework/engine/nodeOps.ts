// ---------------------------------------------------------------------------
// 节点操作族（模块编排 · 数据 → 场景图）：addXxx 创建族（含脚本节点表
// SCRIPT_NODE_BASE）、删除/换父（UI 锚点补偿）、重命名、变换提交、相机对齐、
// 整节点补丁、prefab 实例化/序列化/复制、隐式父级解析。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import type { EditorNodeType } from "../factory/NodeFactory";
import type { Node } from "../prototype/Node";
import { isAudioAssetRel } from "../audio";
import { instantiatePrefabTree, serializePrefabTree } from "../prototype/prefab";
import {
  AudioNode,
  BtRunnerNode,
  CameraNode,
  FogNode,
  FsmRunnerNode,
  LightNode,
  MeshNode,
  NavAgentNode,
  NavAreaNode,
  ParticleSystemNode,
  SkyboxNode,
  TerrainNode,
  UIButtonNode,
  UICanvasNode,
  UIImageNode,
  UILayoutNode,
  UITextNode,
  UIWidgetNode,
  type FogKind,
  type GeometryKind,
  type SkyboxKind,
  type UIScaleMode,
} from "../prototype/derived/Primitives";
import { radToDeg, type JsonRecord, type Vec3 } from "../prototype/types";
import { clampCameraParam } from "../camera";
import { cloneTerrainSettings, type TerrainSettings } from "../terrain";
import { nextId } from "../../platform_abstraction/id";
import { applyLightSpawn, isImplicitContainer, snapshotTransform } from "./modules/utils";
import { uiParentRectInOwnSpace } from "./modules/ui";
import {
  uiAnchorFieldsForRect,
  type UIRect,
  type Vec2,
} from "../prototype/nodes/ui-shared";
import { logger } from "../../platform_abstraction/logger";
import { findFogNode } from "./fogEnv";
import { findSkyboxNode } from "./skyEnv";
import { isInCanvasSubtree, isUIPositionManaged } from "./viewportQuery";
import type { TransformSnapshot } from "../scene/SceneClient";

/**
 * 脚本节点类型声明（脚本类 `@nodeType({ kind })`）→ 基础节点创建。
 * 用 Record<EditorNodeType,…> 声明：新增可创建节点类型时**漏登记会直接编译报错**——
 * 此前是字符串 switch，未登记的 kind 会落到 default 被静默建成空组。
 */
const SCRIPT_NODE_BASE: Record<
  EditorNodeType,
  (engine: EditorEngine, parentId?: string) => Node
> = {
  node: (e, p) => addEmptyGroup(e, p),
  meshNode: (e, p) => addMesh(e, "box", p),
  lightNode: (e, p) => addLight(e, "point", p),
  cameraNode: (e, p) => addCamera(e, p),
  skyboxNode: (e, p) => addSkybox(e, "procedural", p),
  audioNode: (e, p) => addAudio(e, p),
  particleSystemNode: (e, p) => addParticleSystem(e, p),
  terrainNode: (e, p) => addTerrain(e, p),
  navAreaNode: (e, p) => addNavArea(e, p),
  navAgentNode: (e, p) => addNavAgent(e, p),
  fsmRunnerNode: (e, p) => addFsmRunner(e, p),
  btRunnerNode: (e, p) => addBtRunner(e, p),
  fogNode: (e, p) => addFog(e, "linear", p),
  uiCanvasNode: (e, p) => addUICanvas(e, p),
  uiImageNode: (e, p) => addUIImage(e, p),
  uiTextNode: (e, p) => addUIText(e, p),
  uiButtonNode: (e, p) => addUIButton(e, p),
  uiLayoutNode: (e, p) => addUILayout(e, p),
};

/** Vec2 近似相等（换父补偿的同值判定，容差远小于任何可视偏移） */
function vec2Near(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4;
}

function resolveParent(engine: EditorEngine, preferred?: string): Node | undefined {
  if (preferred) return engine.graph.get(preferred);
  // 未显式指定父级：仅容器型选中节点（空组/UI 容器）作为隐式父级，
  // 实体节点（mesh/灯光/相机等）不收子 → 挂根（见 isImplicitContainer 注释）
  if (engine.selectedId) {
    const sel = engine.graph.get(engine.selectedId);
    if (sel && isImplicitContainer(sel)) return sel;
  }
  return engine.graph.root;
}

export function addMesh(engine: EditorEngine, geometry: GeometryKind, parentId?: string, position?: Vec3): MeshNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createMesh(geometry, { parentId: parent?.id ?? null, position });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加数据化网格节点（source=data；载荷经检查器「Data Mesh」卡导入） */
export function addDataMesh(engine: EditorEngine, parentId?: string, position?: Vec3): MeshNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createDataMesh({ parentId: parent?.id ?? null, position });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加模型网格（source=model）：模型资产经 ModelManager 异步解析，
 * 入图先渲染占位体，加载完成后自动刷新为实例并绑定动画。
 * position：出生位置（拖放落位）；缺省原点。
 */
export function addModel(engine: EditorEngine, rel: string, parentId?: string, position?: Vec3): MeshNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createModel(rel, { parentId: parent?.id ?? null, position });
  engine.graph.add(node);
  engine.select(node.id);
  // 预取触发 models.onChanged → refreshModelNodes 自动刷新（含广播）
  if (!engine.models.has(rel)) void engine.models.preload([rel]);
  return node;
}

/**
 * 添加音源节点（场景中的声音发射器：2D 全局 / 3D 位置音源）。
 * source 传音频资产相对路径时直接绑定（非音频扩展名抛错）；
 * autoplay 节点在音频解锁后自动起播。
 */
export function addAudio(engine: EditorEngine, parentId?: string, source = ""): AudioNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createAudio({ parentId: parent?.id ?? null });
  if (source) {
    if (!isAudioAssetRel(source)) {
      throw new Error(`非音频资产: ${source}（支持 mp3/wav/ogg/m4a/aac/flac）`);
    }
    node.audio.source = source;
  }
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

export function addLight(engine: EditorEngine, kind: LightNode["lightKind"], parentId?: string): LightNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createLight(kind, { parentId: parent?.id ?? null });
  applyLightSpawn(node);
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加粒子系统节点（默认循环发射的叠加混合圆锥火花；入图即开始模拟，
 * 参数经检查器调整实时生效）。
 */
export function addParticleSystem(engine: EditorEngine, parentId?: string): ParticleSystemNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createParticleSystem({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加地形节点（程序化高度场地形；入图即按设置烘焙几何，
 * 参数经检查器调整实时重建）。地形面积大，不做出生点偏移，原地生成。
 * init：资产绑定初始化（资产面板「添加到场景」携带 .terrain 引用与快照设置）。
 */
export function addTerrain(engine: EditorEngine, parentId?: string, init?: { asset?: string; terrain?: TerrainSettings }): TerrainNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createTerrain({ parentId: parent?.id ?? null });
  if (init?.asset) node.asset = init.asset;
  if (init?.terrain) node.terrain = cloneTerrainSettings(init.terrain);
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

export function addCamera(engine: EditorEngine, parentId?: string): CameraNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createCamera({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加导航区域节点（场景级烘焙载体：覆盖范围自动取所采样地形，
 * 入图即按场景内容烘焙可行走网格 + SDF 距离场）。
 */
export function addNavArea(engine: EditorEngine, parentId?: string): NavAreaNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createNavArea({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加导航代理节点（寻路移动体；目标点经检查器设置或脚本下发） */
export function addNavAgent(engine: EditorEngine, parentId?: string): NavAgentNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createNavAgent({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加状态机运行器节点（.fsm 资产的场景载体；资产经检查器绑定） */
export function addFsmRunner(engine: EditorEngine, parentId?: string): FsmRunnerNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createFsmRunner({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加行为树运行器节点（.bt 资产的场景载体；资产经检查器绑定） */
export function addBtRunner(engine: EditorEngine, parentId?: string): BtRunnerNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createBtRunner({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加雾节点（场景环境级：线性雾 / 指数雾，与天空盒同语义）。
 * 场景里第一个 启用且可见 的雾节点决定渲染雾（见 applyFogFromGraph）。
 */
export function addFog(engine: EditorEngine, kind: FogKind, parentId?: string): FogNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createFog(kind, { parentId: parent?.id ?? null });
  // 场景只应用第一个 启用且可见 的雾节点；已有生效雾时给出提示避免困惑
  if (findFogNode(engine)) {
    console.info("[fog] 场景中已有生效的雾节点，新增雾不会替换当前雾效（可停用/删除前者）");
  }
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加 UI 画布（Canvas-Widget 的 Canvas；Widget 挂其下，屏幕叠加渲染）。
 *  defaults：项目设置默认值（设计分辨率/缩放模式），缺省 1280×720 / fixedauto */
export function addUICanvas(engine: EditorEngine, parentId?: string, defaults?: { designWidth: number; designHeight: number; scaleMode?: UIScaleMode }): UICanvasNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createUICanvas({ parentId: parent?.id ?? null }, defaults);
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加 UI 图片 Widget（挂画布下参与叠加；画布外仅作普通面片显示） */
export function addUIImage(engine: EditorEngine, parentId?: string): UIImageNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createUIImage({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加 UI 文本 Widget（2D 画布光栅化多行文本） */
export function addUIText(engine: EditorEngine, parentId?: string): UITextNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createUIText({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加 UI 按钮 Widget（运行时可点击；脚本经 engine.ui.onClick 订阅） */
export function addUIButton(engine: EditorEngine, parentId?: string): UIButtonNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createUIButton({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/** 添加 UI 布局容器（横向/竖向/网格排列直接子 UI 节点；自身经锚点定位） */
export function addUILayout(engine: EditorEngine, parentId?: string): UILayoutNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createUILayout({ parentId: parent?.id ?? null });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

export function addEmptyGroup(engine: EditorEngine, parentId?: string): Node {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.create("node", { parentId: parent?.id ?? null, name: "Group" });
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加天空盒节点（场景环境级：程序化天空 / 默认立方体天空盒）。
 * 场景里第一个 启用且可见 的天空盒节点决定渲染背景（见 applySkyFromGraph）。
 */
export function addSkybox(engine: EditorEngine, kind: SkyboxKind, parentId?: string): SkyboxNode {
  const parent = resolveParent(engine, parentId);
  const node = engine.factory.createSkybox(kind, { parentId: parent?.id ?? null });
  // 场景只应用第一个 启用且可见 的天空盒节点；已有生效天空时给出提示避免困惑
  if (findSkyboxNode(engine)) {
    console.info("[sky] 场景中已有生效的天空盒节点，新增天空盒不会替换背景（可停用/删除前者）");
  }
  engine.graph.add(node);
  engine.select(node.id);
  return node;
}

/**
 * 添加脚本节点类型（脚本类经 `static nodeType` 声明）：按声明的 kind 创建
 * 基础节点，并自动挂载对应脚本组件（带脚本声明的默认属性）。一个可撤销操作。
 * @param scriptRel 脚本源路径（src/**.ts，须声明了 static nodeType）
 * @param nodeType  脚本类声明的节点类型元数据（kind/label）
 */
export function addScriptNode(engine: EditorEngine, scriptRel: string, nodeType: { kind: string; label?: string }, parentId?: string): Node {
  const parent = resolveParent(engine, parentId);
  // 基础节点按声明 kind 查表创建；表用 Record<ScriptNodeKind,…> 声明 ——
  // 新增节点类型漏登记会直接编译报错（字符串 switch 的 default 会静默退化成空组）
  const base: Node = (SCRIPT_NODE_BASE[nodeType.kind as EditorNodeType] ?? SCRIPT_NODE_BASE.node)(
    engine,
    parent?.id ?? undefined,
  );
  // 命名：优先节点类型 label，其次脚本类名
  base.name = nodeType.label?.trim() || scriptRel.replace(/\.ts$/, "").split("/").pop() || "Node";
  // 自动挂脚本组件（随节点写入；一步 undo）
  const before = base.toJSON() as JsonRecord;
  base.components = [
    ...base.components,
    {
      id: nextId("comp"),
      type: "script",
      script: scriptRel,
      enabled: true,
      executionOrder: 0,
      props: {},
    },
  ];
  const after = base.toJSON() as JsonRecord;
  patchNode(engine, base.id, before, after, "添加脚本节点");
  engine.select(base.id);
  return base;
}

export function deleteNodes(engine: EditorEngine, ids: string[]): void {
  const targets = ids.filter((id) => {
    if (!id) return false;
    if (engine.graph.root?.id === id) return false;
    return engine.graph.has(id);
  });
  if (!targets.length) return;
  engine.graph.removeNodes(targets);
  engine.setSelection(engine.selectedIds.filter((s) => engine.graph.has(s)));
}

export function reparentNodes(engine: EditorEngine, moves: { id: string; newParentId: string | null; newIndex: number }[]): void {
  const valid = moves.filter((m) => m.id && engine.graph.has(m.id));
  if (!valid.length) return;
  // UI 节点换父位置补偿依赖「旧世界位置 + 解析矩形标注」，必须在 reparent 生效前计算
  const adjusts = computeReparentAnchorAdjust(engine, valid);
  engine.graph.reparentNodes(valid);
  if (!adjusts.length) return;
  // 补偿字段以整节点 JSON 补丁落地（快照在 reparent 之后取，层级字段为最新值，
  // 不会回写父级；与 reparent 各成一个撤销单元，按序 undo 净效果正确）
  const items: { id: string; before: JsonRecord; after: JsonRecord }[] = [];
  for (const a of adjusts) {
    const node = engine.graph.get(a.id);
    if (!node) continue;
    const before = node.toJSON() as JsonRecord;
    const w = node as unknown as {
      anchoredPosition: Vec2;
      offsetMin: Vec2;
      offsetMax: Vec2;
    };
    if (a.anchoredPosition) w.anchoredPosition = a.anchoredPosition;
    if (a.offsetMin) w.offsetMin = a.offsetMin;
    if (a.offsetMax) w.offsetMax = a.offsetMax;
    if (a.position) node.transform.setPosition(a.position.x, a.position.y, a.position.z);
    items.push({ id: a.id, before, after: node.toJSON() as JsonRecord });
  }
  if (items.length) engine.patchNodes(items, "移动节点（保持视觉位置）");
}

/**
 * 换父位置补偿计算（UI 节点换父保持视觉位置/尺寸，Unity/Cocos 层级拖拽同语义）：
 * - 画布内 UI 托管节点 → 画布内：由旧世界中心在新父局部空间的投影 + 新父矩形
 *   （自身空间表示，uiParentRectInOwnSpace）反解锚点字段；新父为布局容器
 *   （mode≠none）时跳过——位置由布局接管，与 Unity Layout Group 同语义；
 * - 跨 UI 边界（画布 ↔ 场景）或画布内普通节点：改用 transform.position 补偿
 *   （世界位置不变）；
 * - 同值/画布外常规 3D 移动：不产生补偿。
 */
function computeReparentAnchorAdjust(
  engine: EditorEngine,
  moves: { id: string; newParentId: string | null }[],
): {
  id: string;
  anchoredPosition?: Vec2;
  offsetMin?: Vec2;
  offsetMax?: Vec2;
  position?: { x: number; y: number; z: number };
}[] {
  const out: {
    id: string;
    anchoredPosition?: Vec2;
    offsetMin?: Vec2;
    offsetMax?: Vec2;
    position?: { x: number; y: number; z: number };
  }[] = [];
  const objMap = engine.synchronizer.getObjectMap();
  for (const m of moves) {
    const node = engine.graph.get(m.id);
    const obj = objMap.get(m.id);
    if (!node || !obj) continue;
    const newParentObj = m.newParentId ? objMap.get(m.newParentId) : engine.synchronizer.getSceneRoot();
    if (!newParentObj) continue;
    const oldManaged = isUIPositionManaged(engine, m.id);
    const newManaged = isInCanvasSubtree(newParentObj);
    if (!oldManaged && !newManaged) continue;

    // 节点视觉中心 = 对象原点（UI 托管对象的位置即解析矩形中心）
    const center = obj.getWorldPosition(new THREE.Vector3());

    if (node instanceof UIWidgetNode && oldManaged && newManaged) {
      const pu = newParentObj.userData as Record<string, unknown> | undefined;
      if (
        pu?.nodeKind === "uiLayoutNode" &&
        (pu.uiLayoutMode as string | undefined) !== "none"
      ) {
        continue; // 新父为生效布局容器：位置由布局接管
      }
      const parentRect = uiParentRectInOwnSpace(newParentObj);
      const oldRect = obj.userData?.uiRect as UIRect | undefined;
      if (!parentRect || !oldRect) continue;
      newParentObj.updateWorldMatrix(true, false);
      const local = newParentObj.worldToLocal(center.clone());
      const w = node as unknown as {
        anchorMin: Vec2;
        anchorMax: Vec2;
        pivot: Vec2;
        anchoredPosition: Vec2;
        offsetMin: Vec2;
        offsetMax: Vec2;
        size: Vec2;
      };
      const fields = uiAnchorFieldsForRect(
        parentRect,
        {
          anchorMin: w.anchorMin,
          anchorMax: w.anchorMax,
          pivot: w.pivot,
          anchoredPosition: w.anchoredPosition,
          offsetMin: w.offsetMin,
          offsetMax: w.offsetMax,
          size: w.size,
        },
        local.x,
        local.y,
        oldRect.w,
        oldRect.h,
      );
      if (
        vec2Near(fields.anchoredPosition, w.anchoredPosition) &&
        vec2Near(fields.offsetMin, w.offsetMin) &&
        vec2Near(fields.offsetMax, w.offsetMax)
      ) {
        continue; // 上下文未变，无需补偿
      }
      out.push({
        id: m.id,
        anchoredPosition: fields.anchoredPosition,
        offsetMin: fields.offsetMin,
        offsetMax: fields.offsetMax,
      });
      continue;
    }

    // 跨 UI 边界 / 画布内普通节点：transform.position 补偿（世界位置不变）
    newParentObj.updateWorldMatrix(true, false);
    const local = newParentObj.worldToLocal(center.clone());
    const cur = node.transform.position;
    if (
      Math.abs(local.x - cur.x) < 1e-6 &&
      Math.abs(local.y - cur.y) < 1e-6 &&
      Math.abs(local.z - cur.z) < 1e-6
    ) {
      continue;
    }
    out.push({ id: m.id, position: { x: local.x, y: local.y, z: local.z } });
  }
  return out;
}

export function setTransform(engine: EditorEngine, nodeId: string, snap: TransformSnapshot): void {
  const node = engine.graph.get(nodeId);
  if (!node) return;
  const before = snapshotTransform(node);
  engine.graph.commitTransform(nodeId, before, snap);
}

/**
 * 把相机节点对齐到当前编辑器视口（Align With View）：
 * 取自由轨道相机（透视）的世界位姿，经所在父对象的世界矩阵换算为节点局部位姿
 * （旋转写度制欧拉角 XYZ，与编辑器变换语义一致）；透视相机同步 fov，
 * 正交相机按「视口竖直视场 × 轨道注视距离」折算正交半高（与当前取景范围一致）。
 * 位姿与取景参数一次节点补丁（一次撤销）。目标非相机节点返回 false。
 */
export function alignCameraToViewport(engine: EditorEngine, nodeId: string): boolean {
  const node = engine.graph.get(nodeId);
  if (!(node instanceof CameraNode)) return false;
  const cam = engine.renderer.camera;
  // 世界位姿（缩放分量固定取 1：节点 scale 保持原值，不随对齐改写）
  const world = new THREE.Matrix4().compose(
    cam.position,
    cam.quaternion,
    new THREE.Vector3(1, 1, 1),
  );
  // 世界 → 局部：local = parentWorld⁻¹ · world（根直挂/对象未同步时按世界原样写入）
  let local = world;
  const obj = engine.synchronizer.getObjectMap().get(nodeId);
  if (obj?.parent) {
    obj.parent.updateWorldMatrix(true, false);
    local = world.clone().premultiply(obj.parent.matrixWorld.clone().invert());
  }
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  local.decompose(pos, quat, scl);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const rotationDeg = radToDeg({ x: euler.x, y: euler.y, z: euler.z });
  const before = node.toJSON() as JsonRecord;
  const tf = before.transform as JsonRecord;
  const after: JsonRecord = {
    ...before,
    transform: {
      ...tf,
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { ...rotationDeg },
    },
  };
  // 取景参数：轨道相机 fov 为竖直视场；正交半高 = tan(竖直视场/2) × 到注视点距离
  const target = engine.renderer.orbitControls.target;
  const distance = Math.max(0.01, cam.position.distanceTo(target));
  if (node.cameraType === "orthographic") {
    after.orthoSize = clampCameraParam(
      "orthoSize",
      Math.tan(((cam.fov * Math.PI) / 180) / 2) * distance,
    );
  } else {
    after.fov = clampCameraParam("fov", cam.fov);
  }
  patchNode(engine, nodeId, before, after, "相机对齐当前视口");
  return true;
}

export function patchNode(engine: EditorEngine, nodeId: string, before: JsonRecord, after: JsonRecord, label?: string): void {
  engine.graph.commitPatch(nodeId, before, after, label);
}

/** 批量整节点属性补丁（多选批量编辑；一次撤销） */
export function patchNodes(engine: EditorEngine, items: { id: string; before: JsonRecord; after: JsonRecord }[], label?: string): void {
  engine.graph.commitPatches(items, label);
}

/**
 * 实例化嵌套节点树（prefab 实例化；一次撤销）：
 * 文档 → 全新节点树（id/组件 id 重生成）→ 挂到目标父节点并选中实例根。
 * prefabRel 写在实例根节点上（来源引用，供「更新预制体」与检查器展示）。
 */
export function instantiateTree(
  engine: EditorEngine,
  doc: JsonRecord,
  prefabRel: string,
  parentId?: string,
  label?: string,
  /** 实例根节点出生位置（拖放落位）；缺省保持预制体文档变换 */
  position?: Vec3,
): Node | null {
  const parent = resolveParent(engine, parentId);
  if (!parent && engine.graph.root) {
    logger.warn("[scene] 实例化子树缺少目标父节点");
    return null;
  }
  const { root, nodes } = instantiatePrefabTree(doc, engine.factory);
  root.prefab = prefabRel;
  root.name = root.name || "Prefab";
  if (position) root.transform.setPosition(position.x, position.y, position.z);
  engine.graph.addTree(
    root,
    nodes,
    parent?.id ?? null,
    label ?? `实例化 ${prefabRel.split("/").pop() ?? "Prefab"}`,
  );
  engine.select(root.id);
  return root;
}

/** 节点子树 → 嵌套 prefab 文档（存储为预制体/更新预制体用） */
export function serializeSubtree(engine: EditorEngine, nodeId: string): JsonRecord | null {
  const node = engine.graph.get(nodeId);
  if (!node) return null;
  return serializePrefabTree(node, (id) => engine.graph.childrenOf(id));
}

/**
 * 复制节点子树（一次撤销）：序列化原子树 → 实例化全新节点树 → 挂到原节点父级下
 * 作为兄弟节点。新根节点名加 " Copy" 后缀；prefab 实例复制后仍保留来源引用。
 * 根场景节点不可复制。返回新根节点 id（失败返回 null）。
 */
export function duplicateNode(engine: EditorEngine, nodeId: string): string | null {
  const node = engine.graph.get(nodeId);
  if (!node || node.isRoot) return null;
  const doc = serializePrefabTree(
    node,
    (id) => engine.graph.childrenOf(id),
    { forAsset: false },
  );
  const { root, nodes } = instantiatePrefabTree(doc, engine.factory);
  root.name = `${node.name} Copy`;
  engine.graph.addTree(root, nodes, node.parentId, `复制 ${node.name}`);
  engine.select(root.id);
  return root.id;
}
