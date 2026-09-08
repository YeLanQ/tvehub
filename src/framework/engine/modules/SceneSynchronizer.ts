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

/** 材质参数查询（EditorEngine 注入 MaterialManager） */
export interface MaterialParamsLookup {
  paramsFor(rel: string): MaterialParams;
  /** 材质类型查询（注册表 key；未注入回退默认类型 physical） */
  typeFor?(rel: string): string;
  /** 异步加载贴图资产（rel → Texture；srgb=true 表示颜色贴图）。引擎注入，未注入则无贴图 */
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
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

export class SceneSynchronizer {
  private objectMap = new Map<string, THREE.Object3D>();
  private scene: THREE.Scene;
  private lookup: MaterialParamsLookup;

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
    if (node instanceof MeshNode) this.refreshMesh(node, obj as THREE.Mesh);
    else if (node instanceof LightNode) this.refreshLight(node, obj);
    else if (node instanceof CameraNode) this.refreshCamera(node, obj);
    else if (node instanceof AudioNode) this.refreshAudio(node, obj);
    // 组件模式：灯光组件挂任意节点（含网格/空组），与节点类型原生能力并存
    this.refreshComponentLights(node, obj);
    this.applyTransform(node);
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
      s.distance,
      s.decay,
      s.angle,
      s.penumbra,
      s.castShadow,
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
    switch (s.kind) {
      case "directional": {
        const dl = new THREE.DirectionalLight(s.lightColor, s.intensity);
        dl.castShadow = s.castShadow;
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
        sl.castShadow = s.castShadow;
        if (dirTarget) sl.target = dirTarget;
        light = sl;
        break;
      }
      case "ambient":
        light = new THREE.AmbientLight(s.lightColor, s.intensity);
        break;
      default:
        light = new THREE.PointLight(s.lightColor, s.intensity, s.distance, s.decay);
        break;
    }
    wrapper.add(light);
    const icon = createIconSprite(compLightIconKind(s.kind), s.lightColor, 0.8);
    icon.name = "__lightIcon";
    wrapper.add(icon);
    obj.add(wrapper);
  }

  /** 网格刷新入口：按来源分派（基元 = 几何工厂 + 材质资产；模型 = 实例化克隆） */
  private refreshMesh(mesh: MeshNode, obj: THREE.Mesh): void {
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
   * 类型经工厂注册表解析（.mat 的 materialType 字段），类型不符时重建材质实例，
   * 参数应用规则由类型定义提供（MaterialTypeDef.apply）。
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
    def.apply(mat, params, this.lookup);
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
    let iconKind: SpriteIconKind = "light-point";
    if (light instanceof PointLightNode) {
      lamp.add(new THREE.PointLight(light.lightColor, light.intensity, light.distance, light.decay));
      iconKind = "light-point";
    } else if (light instanceof DirectionalLightNode) {
      const dl = new THREE.DirectionalLight(light.lightColor, light.intensity);
      dl.castShadow = light.castShadow;
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
      sl.castShadow = light.castShadow;
      if (dirTarget) sl.target = dirTarget;
      lamp.add(sl);
      iconKind = "light-spot";
    } else {
      // AmbientLightNode
      lamp.add(new THREE.AmbientLight(light.lightColor, light.intensity));
      iconKind = "light-ambient";
    }

    // 灯光类型对应的图标（点光灯泡 / 平行光太阳 / 环境光球体 / 聚光灯束）
    const icon = createIconSprite(iconKind, light.lightColor, 0.8);
    icon.name = "__lightIcon";
    lamp.add(icon);
    obj.add(lamp);
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