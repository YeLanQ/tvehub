import * as THREE from "three";
import type { Node } from "../../prototype/Node";
import { isLightComponent } from "../../prototype/Node";
import type { GraphLike, SceneChange } from "../../scene/SceneClient";
import {
  AudioNode,
  MeshNode,
  LightNode,
  PointLightNode,
  DirectionalLightNode,
  SpotLightNode,
  CameraNode,
} from "../../prototype/derived/Primitives";
import {
  SHADOW_MAP_SIZE_PLANE,
  shadowMapSizeOf,
  parseLightShadow,
  type LightShadowConfig,
} from "../../lighting/shadow";
import type { LightComponentSettings } from "../../lighting/types";
import { clampLayerIndex, parseCullingMask } from "../../layers";
import { degToRad } from "../../prototype/types";
import { disposeObject3D } from "./utils";
import { buildGeometry } from "../../mesh";
import { createIconSprite, type SpriteIconKind } from "./helpers/spriteIcon";
import { DEFAULT_MATERIAL_PARAMS, type MaterialParams } from "../../material/types";
import {
  DEFAULT_MATERIAL_TYPE,
  materialTypeRegistry,
  type MaterialTypeDef,
} from "../../material/factory";
import type { CustomShaderProgram, ShaderPropertyDef } from "../../material/shader";

/** 材质参数查询（EditorEngine 注入 MaterialManager） */
export interface MaterialParamsLookup {
  paramsFor(rel: string): MaterialParams;
  /** 材质类型查询（注册表 key；未注入回退默认类型 physical） */
  typeFor?(rel: string): string;
  /** 异步加载贴图资产（rel → Texture；srgb=true 表示颜色贴图）。引擎注入，未注入则无贴图 */
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
  /** 材质挂载的着色器引用查询（自定义着色器取程序用；未注入/旧格式返回空串） */
  shaderFor?(rel: string): string;
  /** 着色器程序查询（EditorEngine 注入 ShaderManager；未解析/非自定义返回 null → 占位程序） */
  shaderProgramFor?(shaderRel: string): CustomShaderProgram | null;
  /** 着色器属性表查询（自定义着色器参数取值/默认值用） */
  shaderPropertiesFor?(shaderRel: string): ShaderPropertyDef[];
  /** 实例化模型资产（rel → 模型克隆；未就绪返回 null，调用方渲染占位体）。引擎注入 ModelManager */
  instantiateModel?(rel: string): THREE.Object3D | null;
  /** 模型是否已解析就绪（引擎注入 ModelManager；实例复用判断用） */
  modelReady?(rel: string): boolean;
  /** 模型实例挂载完成回调（引擎接 AnimationSystem 绑定动画） */
  onModelInstance?(node: MeshNode, modelRoot: THREE.Object3D): void;
  /** 音源节点运行时状态查询（引擎注入 AudioSystem；音源图标状态着色用） */
  audioStateFor?(nodeId: string): { ready: boolean; error: string | null } | null;
}

const defaultLookup: MaterialParamsLookup = {
  paramsFor: () => ({ ...DEFAULT_MATERIAL_PARAMS }),
};

/** 灯光组件设置（扁平字段）→ 阴影配置（组件模式与灯光节点同一阴影语义） */
function componentShadowConfig(s: LightComponentSettings): LightShadowConfig {
  return {
    strength: s.shadowStrength,
    bias: s.shadowBias,
    normalBias: s.shadowNormalBias,
    near: s.shadowNear,
    radius: s.shadowRadius ?? 4,
    resolution: s.shadowResolution ?? 0,
  };
}

/** 网格轮廓体子网格名（同步器按名查找/回收；不进入 objectMap） */
const OUTLINE_CHILD_NAME = "__matOutline";
/** 模型实例子对象名（source=model 的网格容器下；回收/换源时按名清理） */
const MODEL_CHILD_NAME = "__modelRoot";
/** 模型加载中/失败的占位体子网格名 */
const MODEL_PENDING_NAME = "__modelPending";
/** 音源节点图标着色（就绪态；加载中黄/失败红/未绑定灰见 refreshAudio） */
const AUDIO_ICON_COLOR = 0x7ed49a;
/** 灯光组件子对象名（灯光组件单实例；挂任意节点下，随组件增删/启停/改参重建） */
const COMP_LIGHT_NAME = "__compLight";

/** 灯光组件类型 → 图标精灵种类（与灯光节点同一套图标） */
function compLightIconKind(kind: string): SpriteIconKind {
  switch (kind) {
    case "directional":
      return "light-directional";
    case "spot":
      return "light-spot";
    case "ambient":
      return "light-ambient";
    default:
      return "light-point";
  }
}

/**
 * 拷贝几何并沿顶点外扩 offset（对象空间单位），用作轮廓体的独立几何，避免污染主网格几何。
 * 外扩方向为“焊接平均法线”：同一位置的顶点（硬边/角点处属于多个面的重复顶点）先按位置
 * 合并、累加各面法线取平均再归一化，避免每面沿自身面法线外扩时在棱角撕开缝隙导致轮廓
 * 连接处断开。无法线属性时返回未外扩的克隆。
 */
function outlineGeometryFrom(
  base: THREE.BufferGeometry,
  offset: number,
): THREE.BufferGeometry {
  const pos = base.getAttribute("position");
  const nor = base.getAttribute("normal");
  const out = base.clone();
  if (!pos || !nor || pos.count !== nor.count) return out;
  const pa = pos.array as Float32Array;
  const na = nor.array as Float32Array;
  const count = pos.count;
  // —— 第一遍：按位置焊接顶点，累加同位置各面法线 ——
  const slotOf = new Map<string, number>();
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pa[i * 3] * 1e4)}_${Math.round(pa[i * 3 + 1] * 1e4)}_${
      Math.round(pa[i * 3 + 2] * 1e4)
    }`;
    let s = slotOf.get(key);
    if (s === undefined) {
      s = ax.length;
      slotOf.set(key, s);
      ax.push(na[i * 3]);
      ay.push(na[i * 3 + 1]);
      az.push(na[i * 3 + 2]);
    } else {
      ax[s] += na[i * 3];
      ay[s] += na[i * 3 + 1];
      az[s] += na[i * 3 + 2];
    }
  }
  // —— 第二遍：按焊接平均法线外扩（平均法线退化时原地不动，避免撕裂/NaN） ——
  const moved = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pa[i * 3] * 1e4)}_${Math.round(pa[i * 3 + 1] * 1e4)}_${
      Math.round(pa[i * 3 + 2] * 1e4)
    }`;
    const s = slotOf.get(key) as number;
    const len = Math.hypot(ax[s], ay[s], az[s]);
    const oi = i * 3;
    if (len < 1e-6) {
      moved[oi] = pa[oi];
      moved[oi + 1] = pa[oi + 1];
      moved[oi + 2] = pa[oi + 2];
    } else {
      const nx = ax[s] / len;
      const ny = ay[s] / len;
      const nz = az[s] / len;
      moved[oi] = pa[oi] + nx * offset;
      moved[oi + 1] = pa[oi + 1] + ny * offset;
      moved[oi + 2] = pa[oi + 2] + nz * offset;
    }
  }
  out.setAttribute("position", new THREE.BufferAttribute(moved, 3));
  out.computeBoundingSphere();
  return out;
}

// —— 阴影（点光/平行光/聚光灯，Unity Shadows 语义）——
/** 法线偏移自动档（单位为阴影贴图纹素）：范围越大纹素越粗，固定偏移会变麻点/飘影 */
const SHADOW_NORMAL_BIAS_TEXELS = 1.2;
/** 阴影相机重算节拍（帧）：场景随时在变，写死的范围会把阴影裁掉，按节拍惰性贴合 */
const SHADOW_REFIT_INTERVAL = 20;
/** 有阴影能力的 three 灯光（点光=立方体贴图 / 平行光=正交 / 聚光灯=透视） */
type ShadowCastingLight = THREE.PointLight | THREE.DirectionalLight | THREE.SpotLight;
// 阴影相机重算的复用临时对象（帧循环调用，避免每帧分配）
const _shadowBox = new THREE.Box3();
const _shadowTmpBox = new THREE.Box3();
const _shadowCenter = new THREE.Vector3();
const _shadowSize = new THREE.Vector3();
const _shadowOrigin = new THREE.Vector3();
const _shadowTarget = new THREE.Vector3();
const _shadowAxis = new THREE.Vector3();
const _shadowToCenter = new THREE.Vector3();
const _shadowCorner = new THREE.Vector3();

export class SceneSynchronizer {
  private objectMap = new Map<string, THREE.Object3D>();
  private scene: THREE.Scene;
  private lookup: MaterialParamsLookup;
  /** 阴影相机待重算（灯光刷新、场景增删后置位；帧循环消费） */
  private shadowCamerasDirty = true;
  /** 阴影相机重算的帧节拍计数 */
  private shadowCameraFrame = 0;

  constructor(scene: THREE.Scene, lookup: MaterialParamsLookup = defaultLookup) {
    this.scene = scene;
    this.lookup = lookup;
  }

  getObjectMap(): Map<string, THREE.Object3D> {
    return this.objectMap;
  }

  rebuildAll(graph: GraphLike): void {
    this.objectMap.forEach((o: THREE.Object3D) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
    graph.all().forEach((n: Node) => this.createObjectOnly(n));
    graph.all().forEach((n: Node) => this.attachParent(n));
    graph.all().forEach((n: Node) => this.refreshNode(n));
    this.shadowCamerasDirty = true;
  }

  onGraphChange(c: SceneChange, graph: GraphLike): void {
    const node = graph.get(c.nodeId);
    switch (c.kind) {
      case "add":
        if (node) this.syncRecursively(node, graph);
        break;
      case "remove":
        this.disposeMapped(c.nodeId, graph);
        break;
      case "reparent":
        if (node) this.remount(node);
        break;
      case "transform":
        if (node) this.applyTransform(node);
        break;
      case "rename":
        if (node) this.renameObject(node);
        break;
      case "properties":
        if (node) this.refreshNode(node);
        break;
    }
  }

  private createObjectOnly(node: Node): THREE.Object3D {
    let obj: THREE.Object3D;
    if (node instanceof MeshNode) obj = new THREE.Mesh();
    else if (node instanceof LightNode) obj = new THREE.Group();
    else if (node instanceof CameraNode) obj = new THREE.Group();
    else obj = new THREE.Group();
    obj.name = node.name;
    obj.userData.nodeId = node.id;
    obj.userData.nodeKind = node.typeKey;
    this.objectMap.set(node.id, obj);
    return obj;
  }

  private ensureObject(node: Node): void {
    if (!this.objectMap.has(node.id)) this.createObjectOnly(node);
  }

  private syncRecursively(node: Node, graph: GraphLike): void {
    this.ensureObject(node);
    this.attachParent(node);
    node.childIds.forEach((cid) => {
      const child = graph.get(cid);
      if (child) this.syncRecursively(child, graph);
    });
    this.refreshNode(node);
  }

  private attachParent(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    const newParent = node.parentId ? this.objectMap.get(node.parentId) : undefined;
    const host = newParent ?? this.scene;
    if (obj.parent !== host) host.add(obj);
  }

  private disposeMapped(id: string, _graph: GraphLike): void {
    const rootObj = this.objectMap.get(id);
    if (!rootObj) return;
    // 物体被删除同样改变投影范围
    this.shadowCamerasDirty = true;
    // 不依赖 graph 遍历：SceneGraph.remove 在 emit "remove" 前已把节点从图中删除，
    // 若按 graph 找子树会拿到空集合，导致 Three 对象残留。改为按 objectMap 中的
    // Three 子树收集映射到的场景节点 id，逐一摘除并释放。
    const ids: string[] = [];
    rootObj.traverse((o) => {
      const nid = (o as THREE.Object3D).userData?.nodeId as string | undefined;
      if (nid && this.objectMap.has(nid)) ids.push(nid);
    });
    ids.forEach((sid) => {
      const obj = this.objectMap.get(sid);
      if (obj) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
        this.objectMap.delete(sid);
      }
    });
  }

  private remount(node: Node): void {
    this.attachParent(node);
    this.renameObject(node);
  }

  private renameObject(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (obj) obj.name = node.name;
  }

  applyTransform(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    obj.position.set(node.transform.position.x, node.transform.position.y, node.transform.position.z);
    const rotRad = degToRad(node.transform.rotation);
    obj.rotation.set(rotRad.x, rotRad.y, rotRad.z);
    obj.scale.set(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z);
  }

  private refreshNode(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    obj.visible = node.visible && node.active;
    this.applyNodeLayer(node, obj);
    if (node instanceof MeshNode) this.refreshMesh(node, obj as THREE.Mesh);
    else if (node instanceof LightNode) this.refreshLight(node, obj);
    else if (node instanceof CameraNode) this.refreshCamera(node, obj);
    else if (node instanceof AudioNode) this.refreshAudio(node, obj);
    // 组件模式：灯光组件挂任意节点（含网格/空组），与节点类型原生能力并存
    this.refreshComponentLights(node, obj);
    this.applyTransform(node);
  }

  /**
   * 节点渲染层级落位（Unity Layer 语义）：
   * - 节点根对象设为节点层（three 的 object.layers）；
   * - 渲染内容子对象跟随（卡通描边壳/模型实例/占位体）——它们与根对象是同一
   *   渲染体，不跟随会在相机 Culling Mask 排除该层时只剩"半个物体"；
   * - 编辑器装饰子对象（图标精灵/灯光容器/方向目标点）保持层 0：预览渲染本就
   *   隐藏辅助物，自由视角恒全层可见，无需跟随；真实灯光对象的层 = 灯光自身的
   *   cullingMask（见 refreshLight / refreshComponentLights），不能被覆盖。
   */
  private applyNodeLayer(node: Node, obj: THREE.Object3D): void {
    const layer = clampLayerIndex(node.layer);
    obj.layers.set(layer);
    obj.userData.nodeLayer = layer;
    obj.children.forEach((c) => {
      if (c.name === OUTLINE_CHILD_NAME) {
        c.layers.set(layer);
      } else if (c.name === MODEL_CHILD_NAME || c.name === MODEL_PENDING_NAME) {
        c.traverse((d) => d.layers.set(layer));
      }
    });
  }

  /**
   * 灯光组件刷新（组件模式）：
   * - 节点挂启用中的灯光组件 → 在节点对象下挂 __compLight 子组（真实 three 灯光 +
   *   类型图标 + 方向目标点，光照语义与灯光节点一致）；
   * - 组件被移除/停用 → 整组摘除释放（停用即场景中消失，与节点失活同表现）；
   * - 参数变化按签名整组重建（与灯光节点的重建式刷新同策略；图标纹理有缓存）。
   */
  private refreshComponentLights(node: Node, obj: THREE.Object3D): void {
    const comp = node.components.find(isLightComponent);
    let wrapper = obj.children.find((c) => c.name === COMP_LIGHT_NAME) ?? null;
    if (!comp || !comp.enabled) {
      if (wrapper) {
        obj.remove(wrapper);
        disposeObject3D(wrapper);
      }
      return;
    }
    const s = comp.light;
    const sig = [
      s.kind,
      s.lightColor,
      s.intensity,
      s.cullingMask,
      s.distance,
      s.decay,
      s.angle,
      s.penumbra,
      s.castShadow,
      s.shadowStrength,
      s.shadowBias,
      s.shadowNormalBias,
      s.shadowNear,
      s.shadowRadius,
      s.shadowResolution,
    ].join("|");
    if (wrapper && (wrapper.userData as { lightSig?: string }).lightSig === sig) return;
    if (wrapper) {
      obj.remove(wrapper);
      disposeObject3D(wrapper);
    }

    wrapper = new THREE.Group();
    wrapper.name = COMP_LIGHT_NAME;
    (wrapper.userData as { lightSig?: string }).lightSig = sig;
    // 平行光/聚光灯有方向语义：目标点挂在组件组内随节点变换（本地 -Z，同灯光节点）
    let dirTarget: THREE.Object3D | null = null;
    if (s.kind === "directional" || s.kind === "spot") {
      dirTarget = new THREE.Object3D();
      dirTarget.position.set(0, 0, -1);
      wrapper.add(dirTarget);
    }
    let light: THREE.Light;
    // 灯光 Culling Mask（与灯光节点同语义）：真实灯光对象的 layers = 掩码
    const lightMask = parseCullingMask(s.cullingMask);
    switch (s.kind) {
      case "directional": {
        const dl = new THREE.DirectionalLight(s.lightColor, s.intensity);
        // 平行光位置归零（three 默认 (0,1,0)），与灯光节点同一方向语义（本地 -Z）
        dl.position.set(0, 0, 0);
        dl.castShadow = s.castShadow;
        dl.layers.mask = lightMask;
        this.configureShadowLight(dl, componentShadowConfig(s));
        if (dirTarget) dl.target = dirTarget;
        light = dl;
        break;
      }
      case "spot": {
        const sl = new THREE.SpotLight(
          s.lightColor,
          s.intensity,
          s.distance,
          (s.angle * Math.PI) / 180,
          s.penumbra,
          s.decay,
        );
        // 聚光灯位置归零（three 默认 (0,1,0)），与灯光节点同方向语义（本地 -Z）
        sl.position.set(0, 0, 0);
        sl.castShadow = s.castShadow;
        sl.layers.mask = lightMask;
        this.configureShadowLight(sl, componentShadowConfig(s));
        if (dirTarget) sl.target = dirTarget;
        light = sl;
        break;
      }
      case "ambient": {
        const al = new THREE.AmbientLight(s.lightColor, s.intensity);
        al.layers.mask = lightMask;
        light = al;
        break;
      }
      default: {
        const pl = new THREE.PointLight(s.lightColor, s.intensity, s.distance, s.decay);
        pl.castShadow = s.castShadow;
        pl.layers.mask = lightMask;
        this.configureShadowLight(pl, componentShadowConfig(s));
        light = pl;
        break;
      }
    }
    wrapper.add(light);
    const icon = createIconSprite(compLightIconKind(s.kind), s.lightColor, 0.8);
    icon.name = "__lightIcon";
    wrapper.add(icon);
    obj.add(wrapper);
  }

  /** 网格刷新入口：按来源分派（基元 = 几何工厂 + 材质资产；模型 = 实例化克隆） */
  private refreshMesh(mesh: MeshNode, obj: THREE.Mesh): void {
    // 网格默认参与阴影：投射（被平行光/聚光灯照到时投影）与接收（接住其它物体的投影）。
    // 模型实例的子网格由 ModelManager 自行置位（同样为 true），此处只管基元容器。
    obj.castShadow = true;
    obj.receiveShadow = true;
    if (mesh.source === "model") {
      this.refreshModelMesh(mesh, obj);
      return;
    }
    // 基元网格：清理可能的模型残留（实例共享模板资源只摘除；占位体/轮廓体释放）
    this.removeModelChild(obj);
    this.removeNamedChild(obj, MODEL_PENDING_NAME);
    const geom = buildGeometry(mesh.geometry, mesh.size);
    obj.geometry.dispose();
    obj.geometry = geom;
    this.updateMeshMaterial(mesh, obj);
    // 物体尺寸/位置变化都会改变投影范围 → 让阴影相机重算一次
    this.shadowCamerasDirty = true;
  }

  /**
   * 模型网格刷新：
   - 容器本身不渲染（空几何），模型克隆挂载为 __modelRoot 子对象；
   - 引用与就绪状态未变时复用已有实例（属性补丁不重置动画播放），
     仅回放 onModelInstance 让动画系统应用设置差异；
   - 模型未就绪（异步加载中/失败）时以线框占位体示意，加载完成由引擎
     经 refreshModelNodes 重刷替换；
   - 实例与缓存模板共享几何/材质（userData.sharedResources 标记，
     回收时只摘除不释放）。
   */
  private refreshModelMesh(mesh: MeshNode, obj: THREE.Mesh): void {
    // 实例复用：同一模型引用且已就绪 → 保留克隆（动画状态连续）
    const existing = obj.children.find((c) => c.name === MODEL_CHILD_NAME);
    if (
      existing &&
      (existing.userData as { modelRel?: string }).modelRel === mesh.model &&
      !!mesh.model &&
      (this.lookup.modelReady?.(mesh.model) ?? false)
    ) {
      this.lookup.onModelInstance?.(mesh, existing);
      return;
    }
    // 模型实例与模板共享资源：摘除即可（dispose 由模板统一管理，不逐实例释放）
    if (existing) obj.remove(existing);
    this.removeNamedChild(obj, MODEL_PENDING_NAME);
    this.removeNamedChild(obj, OUTLINE_CHILD_NAME);
    // 容器几何置空：基元几何/材质不参与模型渲染（材质由模型内嵌）
    if (obj.geometry) obj.geometry.dispose();
    obj.geometry = new THREE.BufferGeometry();

    const inst = mesh.model ? (this.lookup.instantiateModel?.(mesh.model) ?? null) : null;
    if (inst) {
      inst.name = MODEL_CHILD_NAME;
      inst.userData.modelRel = mesh.model;
      inst.userData.sharedResources = true;
      // 模型克隆子树整体跟随节点层（蒙皮网格/子网格等都是节点的渲染内容）
      inst.traverse((d) => d.layers.set(mesh.layer));
      obj.add(inst);
      this.lookup.onModelInstance?.(mesh, inst);
      return;
    }
    // 占位体：待加载/失败共用（失败原因经引擎日志输出）
    const pending = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x8a7a3a, wireframe: true }),
    );
    pending.name = MODEL_PENDING_NAME;
    pending.layers.set(mesh.layer);
    obj.add(pending);
  }

  /** 按名移除并释放子对象（占位体/轮廓体等自有资源的子对象回收） */
  private removeNamedChild(obj: THREE.Object3D, name: string): void {
    const child = obj.children.find((c) => c.name === name);
    if (!child) return;
    obj.remove(child);
    disposeObject3D(child);
  }

  /** 摘除模型实例（与模板共享几何/材质，不释放资源） */
  private removeModelChild(obj: THREE.Object3D): void {
    const child = obj.children.find((c) => c.name === MODEL_CHILD_NAME);
    if (child) obj.remove(child);
  }

  /**
   * 只刷新网格材质（几何/变换不动）：
   * 材质资产参数被修改保存后调用（避免重建几何）。
   */
  refreshMeshMaterial(mesh: MeshNode): void {
    const obj = this.objectMap.get(mesh.id);
    if (!obj) return;
    this.updateMeshMaterial(mesh, obj as THREE.Mesh);
  }

  /**
   * 整卡刷新单个网格（几何/材质/模型实例 + 动画重绑）：
   * 模型加载完成、网格来源/引用切换后由引擎调用。
   */
  refreshMeshNode(mesh: MeshNode): void {
    const obj = this.objectMap.get(mesh.id);
    if (!obj) return;
    this.refreshMesh(mesh, obj as THREE.Mesh);
    this.applyTransform(mesh);
  }

  /** 音源节点图标刷新（音频绑定状态变化后由引擎调用；数据/变换不动） */
  refreshAudioNodeIcon(node: AudioNode): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    this.refreshAudio(node, obj);
  }

  /**
   * 按材质引用路径把 three 材质对齐到资产（类型 + 参数）：
   * 类型经工厂注册表解析（.mat 的 shader 引用解析结果），类型不符时重建材质实例，
   * 参数应用规则由类型定义提供（MaterialTypeDef.apply）；
   * 自定义着色器（custom）额外传入组装好的程序与属性表（ShaderManager 缓存）。
   */
  private updateMeshMaterial(mesh: MeshNode, obj: THREE.Mesh): void {
    const rel = mesh.material;
    const typeKey = this.lookup.typeFor?.(rel) ?? DEFAULT_MATERIAL_TYPE;
    const def = materialTypeRegistry.getOrDefault(typeKey);
    const params = this.lookup.paramsFor(rel);
    let mat: THREE.Material | undefined = obj.material as THREE.Material | undefined;
    if (!mat || !def.matches(mat)) {
      mat?.dispose();
      mat = def.create();
      obj.material = mat;
    }
    const shaderRel = this.lookup.shaderFor?.(rel) ?? "";
    const ctx = {
      program: shaderRel ? (this.lookup.shaderProgramFor?.(shaderRel) ?? null) : null,
      properties: shaderRel ? (this.lookup.shaderPropertiesFor?.(shaderRel) ?? []) : [],
    };
    def.apply(mat, params, this.lookup, ctx);
    this.syncOutlineMesh(obj, def, params);
  }

  /**
   * 网格轮廓体（法线外扩描边，仅类型定义提供 outlineFor 时可用，如 toon）：
   * 启用时给网格挂一个沿法线外扩、只渲染背面（BackSide）的纯色子网格；关闭或
   * 类型不支持时移除。宽度按对象包围半径相对化（跟随缩放保持比例），几何为主
   * 网格的独立外扩副本，主几何/尺寸变化时重建。
   */
  private syncOutlineMesh(obj: THREE.Mesh, def: MaterialTypeDef, params: MaterialParams): void {
    const want = def.outlineFor?.(params) ?? null;
    let outline = obj.children.find((c) => c.name === OUTLINE_CHILD_NAME) as
      | THREE.Mesh
      | undefined;
    if (!want) {
      if (outline) {
        obj.remove(outline);
        (outline.geometry as THREE.BufferGeometry | undefined)?.dispose();
        (outline.material as THREE.Material | undefined)?.dispose();
      }
      return;
    }
    if (!outline) {
      outline = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
      );
      outline.name = OUTLINE_CHILD_NAME;
      // 描边壳是主网格的渲染内容：跟随节点层（相机 Culling Mask 排除时一同排除）
      outline.layers.mask = obj.layers.mask;
      obj.add(outline);
    }
    const base = obj.geometry as THREE.BufferGeometry | undefined;
    if (!base) return;
    // 外扩量 = 参数宽度 × 对象包围半径：宽度语义相对对象大小，缩放时粗细基本不变
    if (!base.boundingSphere) base.computeBoundingSphere();
    const radius = base.boundingSphere?.radius ?? 1;
    const sig = `${want.width}:${radius}`;
    const meta = outline.userData as Record<string, unknown>;
    if (meta.outlineSrc !== base || meta.outlineSig !== sig) {
      if (outline.geometry) outline.geometry.dispose();
      outline.geometry = outlineGeometryFrom(base, want.width * radius);
      meta.outlineSrc = base;
      meta.outlineSig = sig;
    }
    (outline.material as THREE.MeshBasicMaterial).color.setHex(want.color & 0xffffff);
  }

  // ---------------------------------------------------------------------------
  // 阴影（点光/平行光/聚光灯，各灯自带 Unity Shadows 语义的参数组）
  //
  // three 的灯光阴影相机默认范围很小（平行光为正交 ±5、聚光灯/点光远平面 500 或
  // 取 distance）：场景一旦超出这个盒子，阴影就会"整块消失"或只留下半边 —— 这正是
  // "开了投射阴影却看不到影子"的常见成因。这里不写死范围，把阴影相机贴合到**场景
  // 实时包围盒**；用户的 near/bias/normalBias/ strength 参数经 configureShadowLight
  // 写到灯光对象上（userData.shadowCfg 留档供贴合时读取），场景在编辑中随时变化，
  // 所以按帧节拍惰性重算。
  // ---------------------------------------------------------------------------

  /**
   * 灯光建出时置位阴影基础参数（贴图分辨率/浓度/偏移/近裁剪面）。
   * 必须在**灯光对象刚建出来**时调用 —— three 仅在首次渲染（shadow.map === null）
   * 前按 mapSize 分配阴影贴图，之后再改 mapSize 不会重新分配；本文件每次刷新都
   * 重建灯光对象，因此这里置位即生效。
   */
  private configureShadowLight(
    light: ShadowCastingLight,
    raw?: Partial<LightShadowConfig>,
  ): void {
    // 入口统一 parse 兜底（缺字段回默认），调用方传部分配置也不会把 undefined 写进 three
    const cfg = parseLightShadow(raw);
    light.userData.shadowCfg = { ...cfg };
    // 阴影相机的层随灯光层掩码同步（Unity 语义：灯的 Culling Mask 同时决定哪些层
    // 的对象投影进它的阴影贴图）。three 的阴影通道按 shadowCamera.layers 过滤物体，
    // 默认只收层 0 —— 不同步会让非 0 层的对象"有光无影"。
    light.shadow.camera.layers.mask = light.layers.mask;
    if (!light.castShadow) return;
    const isPoint = (light as THREE.PointLight).isPointLight === true;
    const size = shadowMapSizeOf(cfg.resolution, isPoint);
    light.shadow.mapSize.set(size, size);
    light.shadow.intensity = cfg.strength;
    light.shadow.bias = cfg.bias;
    light.shadow.radius = cfg.radius;
    // normalBias ≤ 0 = 自动：留给 refitShadowCameras 按纹素相对化（需要贴合后的范围）
    if (cfg.normalBias > 0) light.shadow.normalBias = cfg.normalBias;
    // 点光/聚光灯的阴影相机放在灯光位置上，near 就是用户的近裁剪面
    // （平行光的相机要按场景包围盒后推，near 在贴合时合成）
    if (!isPoint && (light as THREE.DirectionalLight).isDirectionalLight === true) return;
    light.shadow.camera.near = cfg.near;
    light.shadow.camera.updateProjectionMatrix();
  }

  /**
   * 帧循环调用：把启用阴影的灯光阴影相机贴合到场景包围盒。
   * @param force 忽略节拍立即重算（加载完成等需要立刻正确的时机）
   */
  refitShadowCameras(force = false): void {
    if (!force && !this.shadowCamerasDirty) {
      if (++this.shadowCameraFrame < SHADOW_REFIT_INTERVAL) return;
      this.shadowCameraFrame = 0;
    }
    this.shadowCamerasDirty = false;
    const lights: ShadowCastingLight[] = [];
    this.objectMap.forEach((obj) => {
      obj.traverse((o) => {
        const l = o as THREE.Light;
        // three 的类型里 isXxxLight 各只在自身类型上声明，按具体类型取标记
        const isDir = (l as THREE.DirectionalLight).isDirectionalLight === true;
        const isSpot = (l as THREE.SpotLight).isSpotLight === true;
        const isPoint = (l as THREE.PointLight).isPointLight === true;
        if ((isDir || isSpot || isPoint) && l.castShadow) lights.push(l as ShadowCastingLight);
      });
    });
    if (lights.length === 0) return;
    // 世界矩阵先推进到当前编辑状态：包围盒与灯光视轴都按它取值
    // （本函数可能在任何时刻被调用，不能依赖渲染帧刚写完矩阵）
    this.scene.updateMatrixWorld(true);
    const bounds = this.sceneShadowBounds(_shadowBox);
    if (!bounds) return;
    for (const l of lights) this.fitShadowCamera(l, bounds);
  }

  /** 阴影相机贴合单个灯光（bounds 为所有投影光共用的场景包围盒） */
  private fitShadowCamera(light: ShadowCastingLight, bounds: THREE.Box3): void {
    const cfg = parseLightShadow((light.userData as { shadowCfg?: unknown }).shadowCfg);
    const center = bounds.getCenter(_shadowCenter);
    const radius = Math.max(bounds.getSize(_shadowSize).length() / 2, 0.05);
    const isDir = (light as THREE.DirectionalLight).isDirectionalLight === true;
    const isPoint = (light as THREE.PointLight).isPointLight === true;
    const shadow = light.shadow;
    let autoBiasExtent: number;

    if (isPoint) {
      // 点光：立方体阴影相机挂在灯光位置（六个 90° 面），near = 用户近裁剪面；
      // 远平面取「灯光到场景包围盒最远角落」（distance>0 时光照在该距离截止，直接用）。
      _shadowOrigin.setFromMatrixPosition(light.matrixWorld);
      const far =
        (light as THREE.PointLight).distance > 0
          ? (light as THREE.PointLight).distance
          : Math.max(
              ...[
                [bounds.min.x, bounds.min.y, bounds.min.z],
                [bounds.max.x, bounds.min.y, bounds.min.z],
                [bounds.min.x, bounds.max.y, bounds.min.z],
                [bounds.max.x, bounds.max.y, bounds.min.z],
                [bounds.min.x, bounds.min.y, bounds.max.z],
                [bounds.max.x, bounds.min.y, bounds.max.z],
                [bounds.min.x, bounds.max.y, bounds.max.z],
                [bounds.max.x, bounds.max.y, bounds.max.z],
              ].map((c) =>
                _shadowCorner.set(c[0], c[1], c[2]).distanceTo(_shadowOrigin),
              ),
              1,
            );
      shadow.camera.near = cfg.near;
      shadow.camera.far = far;
      shadow.camera.updateProjectionMatrix();
      autoBiasExtent = far; // 90° 面在深度 d 处的世界宽度 ≈ 2d
    } else if (!isDir) {
      // 聚光灯：视锥由 angle 决定，只需 near = 用户近裁剪面 + 远平面推够远
      // （distance>0 时 three 以 distance 截止光照，阴影相机 far 取两者中较小即可）
      _shadowOrigin.setFromMatrixPosition(light.matrixWorld);
      _shadowTarget.setFromMatrixPosition((light as THREE.SpotLight).target.matrixWorld);
      _shadowAxis.copy(_shadowTarget).sub(_shadowOrigin);
      if (_shadowAxis.lengthSq() < 1e-8) _shadowAxis.set(0, -1, 0);
      _shadowAxis.normalize();
      const along = _shadowToCenter.copy(center).sub(_shadowOrigin).dot(_shadowAxis);
      const perpSq = Math.max(_shadowToCenter.lengthSq() - along * along, 0);
      const reach = radius + Math.sqrt(perpSq);
      const fitFar = Math.max(along + reach, 1);
      const dist = (light as THREE.SpotLight).distance;
      shadow.camera.near = cfg.near;
      shadow.camera.far = dist > 0 ? Math.min(dist, fitFar) : fitFar;
      shadow.camera.updateProjectionMatrix();
      // 视锥在远平面处的世界宽度（tan(halfAngle)×far×2）决定纹素粗细
      const halfAngle = Math.max((light as THREE.SpotLight).angle, 0.01);
      autoBiasExtent = 2 * Math.tan(halfAngle) * shadow.camera.far;
    } else {
      // 平行光：把阴影相机沿视轴后推，保证**整个场景都在相机前方**。
      // three 把阴影相机放在灯光世界位置上，而定向光的"位置"只影响阴影相机
      // （着色只用方向，即 position − target），所以在节点本地沿 +Z 后退是安全的：
      // 灯本身"站"在场景里时（很常见），近平面会把近侧物体的阴影整片裁掉。
      _shadowOrigin.setFromMatrixPosition(light.matrixWorld);
      _shadowTarget.setFromMatrixPosition(
        (light as THREE.DirectionalLight).target.matrixWorld,
      );
      _shadowAxis.copy(_shadowTarget).sub(_shadowOrigin);
      if (_shadowAxis.lengthSq() < 1e-8) _shadowAxis.set(0, -1, 0);
      _shadowAxis.normalize();
      const along = _shadowToCenter.copy(center).sub(_shadowOrigin).dot(_shadowAxis);
      const perpSq = Math.max(_shadowToCenter.lengthSq() - along * along, 0);
      const reach = radius + Math.sqrt(perpSq);
      // 平行光：把阴影相机沿视轴后推，保证**整个场景都在相机前方**。
      // three 把阴影相机放在灯光世界位置上，而定向光的"位置"只影响阴影相机
      // （着色只用方向，即 position − target），所以在节点本地沿 +Z 后退是安全的：
      // 灯本身"站"在场景里时（很常见），近平面会把近侧物体的阴影整片裁掉。
      // 只补缺口（增量单调）：重复 refit 不来回挪灯，也不破坏已经推好的位置
      const deficit = reach + 0.05 - along;
      if (deficit > 1e-4) {
        light.position.z += deficit;
        light.updateWorldMatrix(true, false);
      }
      // 后退后的最终 along（移动精确落在光照轴上：along_after = along + deficit）
      const alongFinal = deficit > 1e-4 ? reach + 0.05 : along;
      const cam = shadow.camera as THREE.OrthographicCamera;
      // near = 场景起点（alongFinal − reach）+ 用户近裁剪面（Near Plane：比这更近的物体不参与投影）
      cam.near = Math.max(alongFinal - reach + cfg.near, 0.01);
      cam.far = Math.max(alongFinal + reach, cam.near + 0.1);
      cam.left = -reach;
      cam.right = reach;
      cam.top = reach;
      cam.bottom = -reach;
      // three 的平行光阴影矩阵不会自动重建投影矩阵（参数变了必须显式更新）
      cam.updateProjectionMatrix();
      autoBiasExtent = reach * 2;
    }

    // 法线偏移自动档（用户未设时）：按阴影贴图纹素相对化 —— 范围越大纹素越粗，
    // 固定偏移会变成麻点或飘影（peter-panning）
    if (cfg.normalBias <= 0) {
      const mapSize = shadow.mapSize.width || SHADOW_MAP_SIZE_PLANE;
      const texel = autoBiasExtent / mapSize;
      shadow.normalBias = Math.min(
        Math.max(texel * SHADOW_NORMAL_BIAS_TEXELS, 0.0005),
        Math.max(radius * 0.1, 0.001),
      );
    }
  }

  /**
   * 场景投影包围盒（渲染类节点的世界包围盒并集）：
   * 只统计 objectMap 里的场景节点，编辑器辅助物（网格/图标/gizmo）不参与，
   * 空几何容器（模型节点容器、灯光/相机的空组）与隐藏子树跳过。
   * 世界矩阵取渲染帧写入的值（最多滞后一帧，对阴影范围无影响）。
   */
  private sceneShadowBounds(out: THREE.Box3): THREE.Box3 | null {
    out.makeEmpty();
    this.objectMap.forEach((obj) => {
      if (!obj.visible) return;
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh !== true || !mesh.geometry) return;
        const pos = (mesh.geometry as THREE.BufferGeometry).getAttribute?.("position");
        if (!pos || pos.count === 0) return;
        const geom = mesh.geometry as THREE.BufferGeometry;
        if (!geom.boundingBox) geom.computeBoundingBox();
        if (!geom.boundingBox) return;
        _shadowTmpBox.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
        out.union(_shadowTmpBox);
      });
    });
    return out.isEmpty() ? null : out;
  }

  private refreshLight(light: LightNode, obj: THREE.Object3D): void {
    obj.children
      .slice()
      .filter((c) => (c.userData as { lamp?: boolean }).lamp)
      .forEach((c) => {
        obj.remove(c);
        disposeObject3D(c);
      });

    // 平行光/聚光灯有方向语义：指向节点本地 -Z 的目标点对象随节点一起旋转
    const isTargeted =
      light instanceof DirectionalLightNode || light instanceof SpotLightNode;
    let dirTarget = obj.children.find((c) => c.name === "__dirTarget") as THREE.Object3D | null;
    if (!isTargeted) {
      if (dirTarget) {
        obj.remove(dirTarget);
        dirTarget = null;
      }
    } else if (!dirTarget) {
      dirTarget = new THREE.Object3D();
      dirTarget.name = "__dirTarget";
      dirTarget.position.set(0, 0, -1);
      obj.add(dirTarget);
    }

    const lamp = new THREE.Group();
    lamp.userData.lamp = true;
    // 灯光 Culling Mask（Unity 语义）：写到真实 three 灯光对象的 layers 上，
    // 渲染时按"灯层 vs 相机层"收集判定 + 分层多 pass 实现"只照亮所选层"
    const lightMask = parseCullingMask(light.cullingMask);
    let iconKind: SpriteIconKind = "light-point";
    if (light instanceof PointLightNode) {
      const pl = new THREE.PointLight(light.lightColor, light.intensity, light.distance, light.decay);
      pl.castShadow = light.castShadow;
      pl.layers.mask = lightMask;
      this.configureShadowLight(pl, light.shadow);
      lamp.add(pl);
      iconKind = "light-point";
    } else if (light instanceof DirectionalLightNode) {
      const dl = new THREE.DirectionalLight(light.lightColor, light.intensity);
      // three 的平行光默认位置 (0,1,0)（DEFAULT_UP）会让实际光照方向偏离"节点本地 -Z"
      // 的项目语义，也让阴影相机沿轴后推的位移不精确 —— 归零到本地原点（目标点在 -Z，
      // 方向恰为 -Z），后推阴影相机时位移即精确落在光照轴上
      dl.position.set(0, 0, 0);
      dl.castShadow = light.castShadow;
      dl.layers.mask = lightMask;
      this.configureShadowLight(dl, light.shadow);
      if (dirTarget) dl.target = dirTarget;
      lamp.add(dl);
      iconKind = "light-directional";
    } else if (light instanceof SpotLightNode) {
      const angleRad = (light.angle * Math.PI) / 180;
      const sl = new THREE.SpotLight(
        light.lightColor,
        light.intensity,
        light.distance,
        angleRad,
        light.penumbra,
        light.decay,
      );
      // three 的 SpotLight 默认位置同样是 (0,1,0)：不归零会让实际光照方向
      // 偏离节点 -Z 约 45°（(0,0,-1)-(0,1,0)），辅助线光锥也随之对不上
      sl.position.set(0, 0, 0);
      sl.castShadow = light.castShadow;
      sl.layers.mask = lightMask;
      this.configureShadowLight(sl, light.shadow);
      if (dirTarget) sl.target = dirTarget;
      lamp.add(sl);
      iconKind = "light-spot";
    } else {
      // AmbientLightNode
      const al = new THREE.AmbientLight(light.lightColor, light.intensity);
      al.layers.mask = lightMask;
      lamp.add(al);
      iconKind = "light-ambient";
    }

    // 灯光类型对应的图标（点光灯泡 / 平行光太阳 / 环境光球体 / 聚光灯束）
    const icon = createIconSprite(iconKind, light.lightColor, 0.8);
    icon.name = "__lightIcon";
    lamp.add(icon);
    obj.add(lamp);
    // 投射阴影的灯光：阴影相机随场景包围盒重算（新增/移动物体后范围自动跟上）
    if (light instanceof PointLightNode || light instanceof DirectionalLightNode || light instanceof SpotLightNode) {
      if (light.castShadow) this.shadowCamerasDirty = true;
    }
  }

  private refreshCamera(node: CameraNode, obj: THREE.Object3D): void {
    // 相机节点用图标精灵表示（真实渲染时相机本身无实体几何）
    let icon = obj.children.find((c) => c.name === "__camIcon") as THREE.Sprite | null;
    if (!icon) {
      icon = createIconSprite("camera", node.isEditorCamera ? 0x66aaff : 0x9ad7ff, 1.15);
      icon.name = "__camIcon";
      obj.add(icon);
    }
    (icon.material as THREE.SpriteMaterial).color.setHex(
      node.isEditorCamera ? 0x66aaff : 0x9ad7ff,
    );
  }

  /**
   * 音源节点刷新：扬声器图标精灵表示声源位置（不渲染实体几何）。
   * 图标名 __audioIcon（编辑器辅助物；真实音频对象由 AudioSystem 另行挂载）。
   */
  private refreshAudio(node: AudioNode, obj: THREE.Object3D): void {
    let icon = obj.children.find((c) => c.name === "__audioIcon") as THREE.Sprite | null;
    if (!icon) {
      icon = createIconSprite("audio", AUDIO_ICON_COLOR, 1.0);
      icon.name = "__audioIcon";
      obj.add(icon);
    }
    // 绑定状态着色：就绪绿 / 加载中黄 / 失败红 / 未绑定灰
    const state = this.lookup.audioStateFor?.(node.id) ?? null;
    const color = !node.audio.source
      ? 0x8a8f98
      : state?.error
        ? 0xe06c5a
        : state?.ready
          ? AUDIO_ICON_COLOR
          : 0xd7b45a;
    (icon.material as THREE.SpriteMaterial).color.setHex(color);
  }

  dispose(): void {
    this.objectMap.forEach((o) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
  }
}