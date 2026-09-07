import { logger } from "../../platform_abstraction/logger";
import { EventBus } from "../../platform_abstraction/eventBus";
import * as THREE from "three";
import { createNodeFactory, NodeFactory } from "../factory/NodeFactory";
import { createDefaultRegistry } from "../prototype/PrototypeRegistry";
import {
  SceneClient,
  type HistoryView,
  type SceneChange,
  type SceneTransport,
  type TransformSnapshot,
} from "../scene/SceneClient";
import type { Node } from "../prototype/Node";
import {
  CameraNode,
  LightNode,
  MeshNode,
  SkyboxNode,
  type GeometryKind,
  type SkyboxKind,
} from "../prototype/derived/Primitives";
import { degToRad, radToDeg, type JsonRecord } from "../prototype/types";
import { nextId } from "../../platform_abstraction/id";
import { RendererManager, type RendererBackend, EDITOR_BACKGROUND_COLOR, type CameraClearState } from "./modules/RendererManager";
import { HelperSystem } from "./modules/HelperSystem";
export type { GizmoMode } from "./modules/GizmoController";
import { GizmoController, type GizmoMode } from "./modules/GizmoController";
import { SceneSynchronizer } from "./modules/SceneSynchronizer";
import { applyLightSpawn, applySpawnOffset, snapshotTransform } from "./modules/utils";
import {
  buildProceduralSkyTexture,
  buildBandSkyTexture,
  fetchTexCubeDoc,
  loadTexCubeTexture,
} from "./modules/skyboxTextures";
import { MaterialManager } from "../material/MaterialManager";
import { ModelManager, type ModelFileAccess } from "../mesh";
import { AnimationSystem } from "../animation";

export interface EditorEvents extends Record<string, unknown> {
  "graph:changed": SceneChange;
  "select:changed": { nodeId: string | null };
  "gizmo:state": { mode: GizmoMode; space: "local" | "world" };
  /** 材质资产参数变更（保存/刷新后广播；rel 为空串表示全部） */
  "material:changed": { rel: string };
  /** 模型资产解析状态变更（加载完成/失败/失效后广播；rel 为空串表示全部） */
  "model:changed": { rel: string };
  /** 节点动画运行时变化（播放/暂停/图状态切换/参数写入） */
  "animation:changed": { nodeId: string };
}

export class EditorEngine {
  readonly factory: NodeFactory;
  /** 场景镜像（权威状态在后端；读接口与旧 SceneGraph 同构） */
  readonly graph: SceneClient;
  readonly events = new EventBus<EditorEvents>();

  readonly renderer = new RendererManager();
  readonly synchronizer: SceneSynchronizer;
  readonly helperSystem: HelperSystem;
  /** 材质资产参数缓存/解析（网格按引用取参数渲染；应用层注入文件读取器） */
  readonly materials = new MaterialManager();
  /** 模型资产缓存/实例化（模型网格按引用克隆渲染；应用层注入文件读取器） */
  readonly models = new ModelManager();
  /** 动画系统（模型网格的剪辑播放/骨骼动画/动画图状态机；渲染循环推进） */
  readonly animation = new AnimationSystem();
  /** 动画推进时钟（渲染回调里取帧间隔） */
  private clock = new THREE.Clock();
  /** 贴图 URL 解析器（相对路径 → asset:// 协议 URL；应用层注入） */
  private textureUrlResolver: ((rel: string) => string | null) | null = null;
  /** 贴图加载缓存（key = "srgb?c|n|rel" → Texture 或 null） */
  private textureCache = new Map<string, Promise<THREE.Texture | null>>();
  /** 贴图加载器（asset:// 协议 URL → Image 解码；colorSpace 按通道设置） */
  private textureLoader = new THREE.TextureLoader();
  /** TextureCube（.texcube）加载缓存（key = "version|rel"；invalidateTexCube 换版本） */
  private texCubeCache = new Map<string, Promise<THREE.Texture | null>>();
  /** TextureCube 内容版本（外部改写 .texcube 后 bump，签名随之失效触发重载） */
  private texCubeVersions = new Map<string, number>();
  gizmo!: GizmoController;

  /**
   * 项目设计分辨率（取自 project.config.json 的 designResolution）。
   * 相机取景宽高比（视锥辅助线/正交预览）优先使用它；null = 未设置（回退视口宽高比）。
   * 应用层在项目打开/设置保存后写入，辅助线每帧读取即时同步。
   */
  private designResolutionValue: { width: number; height: number } | null = null;
  get designResolution(): { width: number; height: number } | null {
    return this.designResolutionValue;
  }
  set designResolution(v: { width: number; height: number } | null) {
    this.designResolutionValue = v;
    // 取景宽高比变化 → 正交预览相机的左右范围立即重算（透视由渲染器 aspect 处理）
    this.syncOrthoPreviewFrustum();
  }

  selectedId: string | null = null;
  private selectedIds: string[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // —— gizmo 拖动“独占”期间的全局输入拦截（避免左键/键位串扰变换）——
  private onCapturePointerDown = (e: PointerEvent): void => {
    if (this.gizmo && this.gizmo.isDragging()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private onCaptureKeyDown = (e: KeyboardEvent): void => {
    if (this.gizmo && this.gizmo.isDragging()) {
      // 拖动中屏蔽 W/E/R、Delete、Ctrl+Z、Shift/空格 等键位，避免干扰变换
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  /** 场景真实渲染相机（预览用，透视）：与编辑器自由轨道相机相互独立 */
  private readonly previewCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  /** 场景真实渲染相机（预览用，正交）：按相机节点 orthoSize 取景（宽高比同视锥辅助线规则） */
  private readonly previewOrthoCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 2000);
  /** 当前预览正交取景半高（来自相机节点 orthoSize；视口/设计分辨率比例变化时重算范围） */
  private previewOrthoSize = 5;
  /** 天空盒背景当前生效状态（签名 + 背景纹理）：变更/移除/销毁时据此释放 */
  private skyApplied: { sig: string; texture: THREE.Texture } | null = null;
  /** 已销毁标记：mount 期间被 dispose 后终止后续初始化；dispose 幂等 */
  private disposed = false;
  /** 后端 scene:changed 事件订阅取消函数 */
  private sceneUnlisten: (() => void) | null = null;
  /** 天空盒激活时注入的半球环境光（天空色照亮网格材质；无天空盒时移除） */
  private skyLight: THREE.HemisphereLight | null = null;
  /**
   * 正交预览的天空背景面：three.js 的纹理背景（立方体路径）只支持透视相机
   * （按贴在相机位置的 1×1×1 反转盒绘制，正交取景远大于盒子，只剩中间一小块）。
   * 正交预览（清除标志=skybox）时改由该全屏三角形渲染天空：逐像素由逆投影
   * 求光线方向后采样天空纹理——等距柱状纹理按 equirectUv 采样，TextureCube
   * 六面纹理按光线方向 cube 采样（uIsCube 分支），正交/透视光线方向都精确。
   */
  private orthoSkyQuad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  /** 是否处于预览渲染（用场景中的 CameraNode 渲染） */
  private previewMode = false;
  /** 预览渲染当前生效的相机节点（null = 无可用相机，按默认视角回退） */
  private previewNode: CameraNode | null = null;
  /** 清除状态共享色（纯色/底色背景复用同一实例，避免每帧新建对象） */
  private clearScratchColor = new THREE.Color();
  /** 编辑器辅助物（网格/相机盒体/灯球/gizmo/选择框）是否显示 */
  private overlayVisible = true;
  /** 无场景相机时的回退提示是否已输出过（避免每次图事件刷屏） */
  private previewFallbackLogged = false;

  constructor() {
    this.factory = createNodeFactory(createDefaultRegistry());
    this.graph = new SceneClient(this.factory);
    // 骨骼辅助线需挂在无变换的场景根下（挂在节点容器上会叠加两次节点变换）
    this.animation.setSceneRoot(this.renderer.scene);
    this.synchronizer = new SceneSynchronizer(this.renderer.scene, {
      paramsFor: (rel) => this.materials.paramsFor(rel),
      typeFor: (rel) => this.materials.typeFor(rel),
      loadTexture: (rel, srgb) => this.loadTexture(rel, srgb),
      instantiateModel: (rel) => this.models.instantiate(rel),
      modelReady: (rel) => this.models.has(rel),
      onModelInstance: (node, root) => this.bindNodeAnimation(node, root),
    });
    // 材质库缓存更新（编辑保存等）→ 刷新引用该材质的所有网格外观
    this.materials.onChanged((rel) => this.refreshMaterialNodes(rel));
    // 模型库缓存更新（加载完成/失效）→ 刷新引用该模型的所有网格
    this.models.onChanged((rel) => {
      this.refreshModelNodes(rel);
      this.events.emit("model:changed", { rel });
    });
    // 动画运行时变化（播放/图状态/参数）→ 广播给面板刷新
    this.animation.onChange((nodeId) => this.events.emit("animation:changed", { nodeId }));
    this.helperSystem = new HelperSystem(this.renderer.scene, {
      getAspect: () => this.renderer.aspect,
      getDesignSize: () => this.designResolution,
      getEditorDistanceTo: (p) => {
        const cam = this.renderer.camera;
        return cam ? cam.position.distanceTo(p) : 1;
      },
    });
    this.renderer.registerCamera(this.previewCamera);
    // 正交预览相机：视口宽高比变化时按半高重算左右/上下范围（而非写 aspect）
    this.renderer.registerCamera(this.previewOrthoCamera, () => this.syncOrthoPreviewFrustum());
    // 清除标志：渲染循环每帧按活动相机取清除状态（预览相机节点决定清屏方式）
    this.renderer.setClearProvider((cam) => this.resolveClearState(cam));
  }

  /** 历史状态视图（后端权威；UI 读取面与旧 CommandStack 同构） */
  get history(): HistoryView {
    return this.graph.history;
  }

  /** 注入后端场景写通道（应用层项目打开时接线；null = 断开持久化） */
  setSceneTransport(t: SceneTransport | null): void {
    this.graph.setTransport(t);
  }

  /**
   * 订阅后端 scene:changed 事件（快照回灌镜像 → 经 SceneClient 再广播给
   * 同步器/面板）。返回的取消函数由 dispose 自动调用。
   */
  async bindSceneEvents(
    subscribe: (fn: (e: import("../scene/SceneClient").SceneChangedEvent) => void) => Promise<() => void>,
  ): Promise<void> {
    this.unbindSceneEvents();
    this.sceneUnlisten = await subscribe((e) => {
      if (!this.disposed) this.graph.applyEvent(e);
    });
  }

  private unbindSceneEvents(): void {
    this.sceneUnlisten?.();
    this.sceneUnlisten = null;
  }

  private initGizmo(): void {
    this.gizmo = new GizmoController(this.renderer.camera, this.renderer.domElement);
    this.gizmo.setCallbacks({
      onDraggingChanged: (val) => {
        this.renderer.orbitControls.enabled = !val;
      },
      onGizmoObjectChange: () => {
        this.gizmo.updateSelectionBox();
        // 拖动中把 three 对象的当前变换实时回写数据节点并广播，
        // 属性面板的 Transform 数值与视口 gizmo 同步变化（松手才写历史）
        if (this.gizmo.isDragging()) this.syncGizmoTransformToNode();
      },
    });
    this.gizmo.onCommitTransform = (id, after, before) => {
      // 拖动期间镜像已实时生效；此处携带 before/after 一次性提交后端（一个拖动 = 一条历史）
      this.graph.commitTransform(id, before, after);
    };
    this.gizmo.attachToScene(this.renderer.scene);
    // 关键：把 OrbitControls 的监听器摘掉后重新挂到 gizmo 之后——
    // 指针按下时 gizmo 先进入拖拽并（经 dragging-changed）禁用轨道相机，
    // OrbitControls 随后收到同一个按下事件时因 enabled=false 直接忽略，
    // 避免“拖动变换的同时相机也在旋转”。
    {
      const oc = this.renderer.orbitControls as unknown as {
        disconnect?: () => void;
        connect?: (el: HTMLElement) => void;
      };
      oc.disconnect?.();
      oc.connect?.(this.renderer.domElement);
    }
  }

  /**
   * gizmo 拖动中调用：把当前被拖 three 对象的变换实时写回数据节点
   * （不产生历史命令，undo 仍以拖动起点/终点为准），并广播 transform 变化，
   * 让属性面板数值与 gizmo 同步。
   */
  private syncGizmoTransformToNode(): void {
    const id = this.selectedId;
    if (!id) return;
    const node = this.graph.get(id);
    const obj = id ? this.synchronizer.getObjectMap().get(id) : undefined;
    if (!node || !obj) return;
    const rot = radToDeg({ x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z });
    node.transform.setPosition(obj.position.x, obj.position.y, obj.position.z);
    node.transform.setRotation(rot.x, rot.y, rot.z);
    node.transform.setScale(obj.scale.x, obj.scale.y, obj.scale.z);
    this.graph.notifyTransformChanged(node.id);
  }

  // ===================== 生命周期 =====================

  async mount(
    container: HTMLElement,
    options?: {
      renderer?: RendererBackend;
      antialias?: number;
      hdrMode?: "hdr" | "ldr";
    },
  ): Promise<void> {
    this.disposed = false;
    await this.renderer.mount(container, options);
    // 挂载期间（渲染器异步初始化）可能已被 dispose（如用户在就绪前点了“关闭”）：
    // 此时渲染器已释放，直接终止后续初始化，避免在已销毁的引擎上补建 gizmo/监听。
    if (this.disposed) return;
    this.initGizmo();
    this.renderer.setRenderCb(() => {
      // 动画推进（剪辑/骨骼/动画图状态机）与渲染同帧
      this.animation.update(this.clock.getDelta());
      this.gizmo.updateSelectionBox();
      // 每帧贴合辅助线世界变换（gizmo 拖拽时实时跟随）
      this.helperSystem.tick(this.synchronizer.getObjectMap());
      // 正交预览的天空背景面跟随（渲染前更新 uniforms）
      this.updateOrthoSkyQuad();
    });
    this.graph.onChange((c) => this.onGraphChange(c));
    this.events.on("select:changed", () => this.onSelectionChanged());
    this.setupViewportClickHandler();
    // gizmo 拖动期间：捕获阶段拦截其它鼠标按下与键位输入（独占变换操作）
    window.addEventListener("pointerdown", this.onCapturePointerDown, true);
    window.addEventListener("keydown", this.onCaptureKeyDown, true);
    logger.info("EditorEngine mounted");
  }

  dispose(): void {
    // 幂等且容错：允许在引擎尚未 mount（或挂载中）时被销毁，不抛错
    if (this.disposed) return;
    this.disposed = true;
    this.unbindSceneEvents();
    this.graph.setTransport(null);
    window.removeEventListener("pointerdown", this.onCapturePointerDown, true);
    window.removeEventListener("keydown", this.onCaptureKeyDown, true);
    if (this.skyApplied) {
      this.skyApplied.texture.dispose();
      this.skyApplied = null;
    }
    if (this.orthoSkyQuad) {
      this.orthoSkyQuad.geometry.dispose();
      this.orthoSkyQuad.material.dispose();
      this.orthoSkyQuad.parent?.remove(this.orthoSkyQuad);
      this.orthoSkyQuad = null;
    }
    this.removeSkyEnvLight();
    this.textureCache.clear();
    this.texCubeCache.clear();
    this.textureUrlResolver = null;
    this.renderer?.dispose();
    this.gizmo?.dispose();
    this.helperSystem?.dispose();
    this.synchronizer?.dispose();
    this.animation?.dispose();
    this.materials?.clear();
    this.models?.clear();
    this.removeViewportClickHandler();
  }

  /** gizmo 是否正在拖动（变换过程中）——其它交互可用此状态判断是否需要忽略 */
  get isGizmoDragging(): boolean {
    return this.gizmo ? this.gizmo.isDragging() : false;
  }

  /** 引擎是否已销毁（mount 流程与 store 层用它判断是否中止后续初始化/装载） */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ===================== 贴图加载（纹理支持） =====================

  /** 注入贴图 URL 解析器（相对路径 → asset:// 协议 URL；应用层按项目根封装） */
  setTextureResolver(fn: ((rel: string) => string | null) | null): void {
    this.textureUrlResolver = fn;
    this.textureCache.clear();
    // 项目根变化后旧 URL 全部失效：天空贴图缓存一并清除（签名含版本号自动重载）
    this.texCubeCache.clear();
    this.applySkyFromGraph();
  }

  // ===================== 模型加载（mesh 模块接入） =====================

  /** 注入模型文件访问器（模型二进制 + 同目录清单；应用层按项目根目录封装） */
  setModelAccess(access: ModelFileAccess | null): void {
    this.models.setAccess(access);
    this.models.clear();
  }

  /** 模型实例挂载后把节点动画数据交给动画系统绑定（mixer/图状态机） */
  private bindNodeAnimation(node: MeshNode, modelRoot: THREE.Object3D): void {
    const clips = node.model ? this.models.animationsFor(node.model) : [];
    this.animation.syncNode(node, modelRoot, clips);
    this.animation.setSelected(this.selectedId);
  }

  /**
   * 按相对路径异步加载贴图（带缓存，经 asset:// 协议由浏览器直接解码图片）。
   * srgb=true 表示颜色贴图（Base/Emissive），false 表示数据贴图（Metallic/Roughness/Normal）。
   */
  loadTexture(rel: string, srgb: boolean): Promise<THREE.Texture | null> {
    const key = `${srgb ? "c" : "n"}|${rel}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;
    const task = (async (): Promise<THREE.Texture | null> => {
      const resolver = this.textureUrlResolver;
      if (!resolver || !rel) return null;
      const url = resolver(rel);
      if (!url) return null;
      return await new Promise((resolve) => {
        this.textureLoader.load(
          url,
          (tex) => {
            tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            resolve(tex);
          },
          undefined,
          () => resolve(null),
        );
      });
    })().catch(() => null);
    this.textureCache.set(key, task);
    return task;
  }

  // ===================== 操作 API（乐观应用 → 后端提交） =====================

  undo(): void {
    this.graph.undo();
  }

  redo(): void {
    this.graph.redo();
  }

  addMesh(geometry: GeometryKind, parentId?: string): MeshNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createMesh(geometry, { parentId: parent?.id ?? null });
    applySpawnOffset(node);
    this.graph.add(node);
    this.select(node.id);
    return node;
  }

  /**
   * 添加模型网格（source=model）：模型资产经 ModelManager 异步解析，
   * 入图先渲染占位体，加载完成后自动刷新为实例并绑定动画。
   */
  addModel(rel: string, parentId?: string): MeshNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createModel(rel, { parentId: parent?.id ?? null });
    this.graph.add(node);
    this.select(node.id);
    // 预取触发 models.onChanged → refreshModelNodes 自动刷新（含广播）
    if (!this.models.has(rel)) void this.models.preload([rel]);
    return node;
  }

  addLight(kind: LightNode["lightKind"], parentId?: string): LightNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createLight(kind, { parentId: parent?.id ?? null });
    applyLightSpawn(node);
    this.graph.add(node);
    this.select(node.id);
    return node;
  }

  addCamera(parentId?: string): CameraNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createCamera({ parentId: parent?.id ?? null });
    this.graph.add(node);
    this.select(node.id);
    return node;
  }

  addEmptyGroup(parentId?: string): Node {
    const parent = this.resolveParent(parentId);
    const node = this.factory.create("node", { parentId: parent?.id ?? null, name: "Group" });
    this.graph.add(node);
    this.select(node.id);
    return node;
  }

  /**
   * 添加天空盒节点（场景环境级：程序化天空 / 默认立方体天空盒）。
   * 场景里第一个 启用且可见 的天空盒节点决定渲染背景（见 applySkyFromGraph）。
   */
  addSkybox(kind: SkyboxKind, parentId?: string): SkyboxNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createSkybox(kind, { parentId: parent?.id ?? null });
    // 场景只应用第一个 启用且可见 的天空盒节点；已有生效天空时给出提示避免困惑
    if (this.findSkyboxNode()) {
      console.info("[sky] 场景中已有生效的天空盒节点，新增天空盒不会替换背景（可停用/删除前者）");
    }
    this.graph.add(node);
    this.select(node.id);
    return node;
  }

  /**
   * 添加脚本节点类型（脚本类经 `static nodeType` 声明）：按声明的 kind 创建
   * 基础节点，并自动挂载对应脚本组件（带脚本声明的默认属性）。一个可撤销操作。
   * @param scriptRel 脚本源路径（src/**.ts，须声明了 static nodeType）
   * @param nodeType  脚本类声明的节点类型元数据（kind/label）
   */
  addScriptNode(scriptRel: string, nodeType: { kind: string; label?: string }, parentId?: string): Node {
    const parent = this.resolveParent(parentId);
    let base: Node;
    switch (nodeType.kind) {
      case "meshNode":
        base = this.addMesh("box", parent?.id ?? undefined);
        break;
      case "cameraNode":
        base = this.addCamera(parent?.id ?? undefined);
        break;
      case "lightNode":
        base = this.addLight("point", parent?.id ?? undefined);
        break;
      case "skyboxNode":
        base = this.addSkybox("procedural", parent?.id ?? undefined);
        break;
      default:
        base = this.addEmptyGroup(parent?.id ?? undefined);
    }
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
        props: {},
      },
    ];
    const after = base.toJSON() as JsonRecord;
    this.patchNode(base.id, before, after, "添加脚本节点");
    this.select(base.id);
    return base;
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    this.deleteNodes([this.selectedId]);
  }

  deleteNodes(ids: string[]): void {
    const targets = ids.filter((id) => {
      if (!id) return false;
      if (this.graph.root?.id === id) return false;
      return this.graph.has(id);
    });
    if (!targets.length) return;
    this.graph.removeNodes(targets);
    this.setSelection(this.selectedIds.filter((s) => this.graph.has(s)));
  }

  reparentNodes(moves: { id: string; newParentId: string | null; newIndex: number }[]): void {
    const valid = moves.filter((m) => m.id && this.graph.has(m.id));
    if (!valid.length) return;
    this.graph.reparentNodes(valid);
  }

  renameSelected(name: string): void {
    if (this.selectedId) this.graph.rename(this.selectedId, name);
  }

  reparentSelected(newParentId: string | null): void {
    if (!this.selectedId) return;
    this.graph.reparentNodes([{ id: this.selectedId, newParentId, newIndex: -1 }]);
  }

  setTransform(nodeId: string, snap: TransformSnapshot): void {
    const node = this.graph.get(nodeId);
    if (!node) return;
    const before = snapshotTransform(node);
    this.graph.commitTransform(nodeId, before, snap);
  }

  patchNode(nodeId: string, before: JsonRecord, after: JsonRecord, label?: string): void {
    this.graph.commitPatch(nodeId, before, after, label);
  }

  /**
   * 材质资产参数保存后：刷新引用该材质的所有网格外观并广播 material:changed。
   * rel 为空时刷新全部网格材质（装载/迁移后兜底用）。
   */
  refreshMaterialNodes(rel?: string | null): void {
    for (const node of this.graph.all()) {
      if (node instanceof MeshNode && (rel == null || node.material === rel)) {
        this.synchronizer.refreshMeshMaterial(node);
      }
    }
    this.events.emit("material:changed", { rel: rel ?? "" });
  }

  /**
   * 模型资产解析完成后：刷新引用该模型的所有网格（实例替换 + 动画重绑）
   * 并广播 model:changed。rel 为空时刷新全部模型网格。
   */
  refreshModelNodes(rel?: string | null): void {
    for (const node of this.graph.all()) {
      if (
        node instanceof MeshNode &&
        node.source === "model" &&
        (rel == null || node.model === rel)
      ) {
        this.synchronizer.refreshMeshNode(node);
      }
    }
    this.animation.setSelected(this.selectedId);
    this.events.emit("model:changed", { rel: rel ?? "" });
  }

  private resolveParent(preferred?: string): Node | undefined {
    if (preferred) return this.graph.get(preferred);
    if (this.selectedId) {
      const sel = this.graph.get(this.selectedId);
      if (sel) return sel;
    }
    return this.graph.root;
  }

  // ===================== 选择 =====================

  get selectionIds(): string[] {
    return [...this.selectedIds];
  }

  select(id: string | null): void {
    this.selectedIds = id ? [id] : [];
    this.selectedId = id;
    this.gizmo.select(id, this.synchronizer.getObjectMap());
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  addToSelection(id: string): void {
    if (!id || this.selectedIds.includes(id)) return;
    if (this.selectedIds.length === 0) this.selectedId = id;
    this.selectedIds.push(id);
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  toggleSelection(id: string): void {
    if (!id) return;
    if (this.selectedIds.includes(id)) {
      this.selectedIds = this.selectedIds.filter((s) => s !== id);
      this.selectedId = this.selectedIds[this.selectedIds.length - 1] ?? null;
    } else {
      this.selectedIds.push(id);
      this.selectedId = id;
    }
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  setSelection(ids: string[]): void {
    this.selectedIds = [...ids];
    this.selectedId = ids[ids.length - 1] ?? null;
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  clearSelection(): void {
    this.select(null);
  }

  private syncGizmo(): void {
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap());
  }

  getTransform(id: string): TransformSnapshot | null {
    const node = this.graph.get(id);
    return node ? snapshotTransform(node) : null;
  }

  getSelectedNode(): Node | undefined {
    return this.selectedId ? this.graph.get(this.selectedId) : undefined;
  }

  // ===================== 数据 → Three 同步 =====================

  private onGraphChange(c: SceneChange): void {
    this.synchronizer.onGraphChange(c, this.graph);
    this.helperSystem.onGraphChange(c, this.graph, this.synchronizer.getObjectMap());
    // 节点子树移除 → 其动画绑定（mixer/骨骼辅助线）一并解除
    if (c.kind === "remove") this.animation.unbind(c.nodeId);
    this.events.emit("graph:changed", c);
    this.syncPreviewView();
    // 场景结构/属性变化（增删/重挂/属性/整体替换）→ 天空背景可能变化；纯变换/改名不重算
    if (
      c.kind === "add" ||
      c.kind === "remove" ||
      c.kind === "reparent" ||
      c.kind === "properties" ||
      c.kind === "replace" ||
      c.kind === "clear"
    ) {
      this.applySkyFromGraph();
    }
    // 新入图/属性变更引用了尚未解析的材质资产（如撤销/重做改回引用）→ 异步预取后刷新
    const n = this.graph.get(c.nodeId);
    if (n instanceof MeshNode && !this.materials.has(n.material)) {
      const rel = n.material;
      void this.materials.preload([rel]).then(() => this.refreshMaterialNodes(rel));
    }
    // 同理：尚未解析的模型资产 → 预取后经 models.onChanged 自动刷新网格与动画
    if (
      n instanceof MeshNode &&
      n.source === "model" &&
      n.model &&
      !this.models.has(n.model)
    ) {
      void this.models.preload([n.model]);
    }
  }

  rebuildAll(): void {
    // 场景整体重建：先解除全部动画绑定（mixer 指向旧实例），重建时经
    // onModelInstance 逐节点重新绑定
    this.animation.unbindAll();
    this.synchronizer.rebuildAll(this.graph);
    this.helperSystem.rebuildAll(this.graph, this.synchronizer.getObjectMap());
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap());
    this.animation.setSelected(this.selectedId);
    this.applySkyFromGraph();
  }

  /**
   * 依据场景图应用/移除天空背景：
   * 场景中第一个 启用且可见 的天空盒节点决定 scene.background（程序化渐变 /
   * 三段色带 / TextureCube 贴图），节点增删、属性修改、启停切换都会触发重算；
   * 无天空盒时回退编辑器默认纯色背景。
   * 立方体天空盒的 TextureCube（.texcube）为异步加载：先用三段色带兜底，
   * 加载完成后热替换背景；引用缺失/加载失败保持色带（与旧版表现一致）。
   */
  private applySkyFromGraph(): void {
    const scene = this.renderer.scene;
    const release = (): void => {
      if (this.skyApplied) {
        this.skyApplied.texture.dispose();
        this.skyApplied = null;
      }
    };
    const sky = this.findSkyboxNode();
    if (!sky) {
      if (this.skyApplied) {
        release();
        scene.background = new THREE.Color(EDITOR_BACKGROUND_COLOR);
      }
      this.removeSkyEnvLight();
      return;
    }
    // 签名含贴图引用与其内容版本：检查器改写 .texcube 后版本 bump 触发重载
    const cubeVer =
      sky.skyKind === "cube" ? (this.texCubeVersions.get(sky.cubeMap) ?? 0) : -1;
    const sig = [
      sky.id,
      sky.skyKind,
      sky.cubeMap,
      cubeVer,
      sky.topColor,
      sky.horizonColor,
      sky.groundColor,
      sky.sunDisk,
      sky.sunColor,
      sky.sunSize,
      sky.sunGlow,
      sky.sunAzimuth,
      sky.sunElevation,
    ].join("|");
    if (this.skyApplied?.sig === sig) return;
    release();
    try {
      // 立方体：三段色带先兜底（未绑定/加载中/失败均保持可看）；贴图到位后热替换
      const tex =
        sky.skyKind === "procedural"
          ? buildProceduralSkyTexture(sky)
          : buildBandSkyTexture(sky);
      scene.background = tex;
      this.skyApplied = { sig, texture: tex };
      if (sky.skyKind === "cube" && sky.cubeMap) {
        const rel = sky.cubeMap;
        void this.loadTexCubeTexture(rel).then((loaded) => {
          // 异步返回时签名可能已变（节点切换/再次修改）：过期结果直接丢弃
          const applied = this.skyApplied;
          if (!applied || applied.sig !== sig || !loaded) return;
          applied.texture.dispose();
          applied.texture = loaded;
          scene.background = loaded;
        });
      }
    } catch (e) {
      console.warn(`[sky] 天空盒背景生成失败: ${String(e)}`);
      scene.background = new THREE.Color(EDITOR_BACKGROUND_COLOR);
    }
    // 天空作为环境光照参与网格材质：半球光（天空色/地面色）随天空变化
    this.applySkyEnvLight(sky);
  }

  /**
   * 加载 TextureCube（.texcube）资产为天空纹理（带缓存与内容版本；
   * 解析/加载失败返回 null，调用方保持色带兜底）。
   */
  private loadTexCubeTexture(rel: string): Promise<THREE.Texture | null> {
    const key = `${this.texCubeVersions.get(rel) ?? 0}|${rel}`;
    const cached = this.texCubeCache.get(key);
    if (cached) return cached;
    const resolver = this.textureUrlResolver;
    const task = (async (): Promise<THREE.Texture | null> => {
      if (!resolver || !rel) return null;
      const url = resolver(rel);
      if (!url) return null;
      const doc = await fetchTexCubeDoc(url);
      if (!doc) return null;
      const res = await loadTexCubeTexture(doc, resolver);
      return res?.texture ?? null;
    })().catch((e) => {
      console.warn(`[sky] TextureCube 加载失败 '${rel}': ${String(e)}`);
      return null;
    });
    this.texCubeCache.set(key, task);
    return task;
  }

  /**
   * 外部（检查器写盘等）通知某 .texcube 内容已更新：bump 版本使缓存与
   * 天空签名失效并立即重算背景；贴图未变化时无副作用。
   */
  invalidateTexCube(rel: string): void {
    if (!rel) return;
    this.texCubeVersions.set(rel, (this.texCubeVersions.get(rel) ?? 0) + 1);
    for (const key of [...this.texCubeCache.keys()]) {
      if (key.endsWith(`|${rel}`)) this.texCubeCache.delete(key);
    }
    this.applySkyFromGraph();
  }

  /**
   * 天空环境光：天空盒激活时向场景注入一盏与天空配色一致的半球光，
   * 使网格材质的明暗/环境色随天空颜色变化（天空顶/地平线混色为天空光，
   * 下方色为地面反射光）。无天空盒/被停用时移除。
   */
  private applySkyEnvLight(sky: SkyboxNode): void {
    if (!this.skyLight) {
      this.skyLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.55);
      this.skyLight.name = "__skyEnvLight";
      this.renderer.scene.add(this.skyLight);
    }
    this.skyLight.color.setHex(mixHexColor(sky.topColor, sky.horizonColor, 0.5));
    this.skyLight.groundColor.setHex(sky.groundColor & 0xffffff);
  }

  private removeSkyEnvLight(): void {
    if (this.skyLight) {
      this.skyLight.parent?.remove(this.skyLight);
      this.skyLight = null;
    }
  }

  /**
   * 正交预览的天空背景面（每帧调用）：仅 预览模式 + 正交活动相机 + 天空盒
   * 清除标志 + 有天空 时启用；uniforms 随活动相机与全局天空纹理更新。
   */
  private updateOrthoSkyQuad(): void {
    const ocam = this.renderer.getActiveCamera() as THREE.OrthographicCamera | null;
    const node = this.previewMode ? this.previewNode : null;
    if (
      !ocam ||
      ocam.isOrthographicCamera !== true ||
      !node ||
      node.clearFlags !== "skybox" ||
      !this.skyApplied
    ) {
      if (this.orthoSkyQuad?.visible) this.orthoSkyQuad.visible = false;
      return;
    }
    const quad = this.ensureOrthoSkyQuad();
    const u = quad.material.uniforms;
    // 天空纹理两种形态：等距柱状 2D（按光线方向采样 equirectUv）与
    // TextureCube 六面（CubeTexture，直接按光线方向 cube 采样）
    const tex = this.skyApplied.texture;
    const isCube = (tex as THREE.Texture & { isCubeTexture?: boolean }).isCubeTexture === true;
    u.uIsCube.value = isCube ? 1 : 0;
    u.tSky.value = isCube ? null : tex;
    u.tSkyCube.value = isCube ? tex : null;
    // 相机不在场景图内（预览相机）或本帧渲染尚未推进 matrixWorld 时需手动刷新，
    // 否则采到上一帧的姿态（拖动/动画移动相机时天空滞后一帧）
    ocam.updateMatrixWorld();
    (u.projInverse.value as THREE.Matrix4).copy(ocam.projectionMatrixInverse);
    (u.camWorld.value as THREE.Matrix4).copy(ocam.matrixWorld);
    quad.visible = true;
  }

  /** 惰性创建全屏天空背景面（三角形铺满 NDC；最先绘制、不读写深度） */
  private ensureOrthoSkyQuad(): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    if (!this.orthoSkyQuad) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
      );
      const material = new THREE.ShaderMaterial({
        uniforms: {
          tSky: { value: null },
          tSkyCube: { value: null },
          uIsCube: { value: 0 },
          projInverse: { value: new THREE.Matrix4() },
          camWorld: { value: new THREE.Matrix4() },
        },
        vertexShader: /* glsl */ `
          varying vec2 vNdc;
          void main() {
            vNdc = position.xy;
            gl_Position = vec4( position.xy, 1.0, 1.0 );
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tSky;
          uniform samplerCube tSkyCube;
          uniform float uIsCube;
          uniform mat4 projInverse;
          uniform mat4 camWorld;
          varying vec2 vNdc;
          #include <common>
          void main() {
            vec4 nearP = projInverse * vec4( vNdc, -1.0, 1.0 );
            vec4 farP = projInverse * vec4( vNdc, 1.0, 1.0 );
            vec3 dir = normalize(
              ( camWorld * vec4( farP.xyz / farP.w, 1.0 ) ).xyz -
              ( camWorld * vec4( nearP.xyz / nearP.w, 1.0 ) ).xyz
            );
            vec3 col = uIsCube > 0.5
              ? textureCube( tSkyCube, dir ).rgb
              : texture2D( tSky, equirectUv( dir ) ).rgb;
            gl_FragColor = vec4( col, 1.0 );
            #include <colorspace_fragment>
          }
        `,
        depthTest: false,
        depthWrite: false,
        fog: false,
      });
      const quad = new THREE.Mesh(geometry, material);
      quad.name = "__orthoSkyQuad";
      quad.renderOrder = -1000000; // 最先绘制，被其后绘制的场景物体覆盖
      quad.frustumCulled = false;
      quad.visible = false;
      this.renderer.scene.add(quad);
      this.orthoSkyQuad = quad;
    }
    return this.orthoSkyQuad;
  }

  /** 深度优先查找第一个 启用且可见 的天空盒节点（场景树的文档序） */
  private findSkyboxNode(): SkyboxNode | null {
    const root = this.graph.root;
    if (!root) return null;
    const stack: Node[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n instanceof SkyboxNode && n.active && n.visible) return n;
      const ids = n.childIds;
      for (let i = ids.length - 1; i >= 0; i--) {
        const c = this.graph.get(ids[i]);
        if (c) stack.push(c);
      }
    }
    return null;
  }

  /** 用后端装载结果中的嵌套文档根重建镜像与渲染（scene_open / scene_load_doc 装载用） */
  applySceneDocRoot(rootJson: JsonRecord | null): void {
    this.graph.replaceFromDocRoot(rootJson);
    this.selectedId = null;
    this.rebuildAll();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
    this.events.emit("gizmo:state", { mode, space: this.gizmo.getSpace() });
  }

  setGizmoSpace(space: "local" | "world"): void {
    this.gizmo.setSpace(space);
    this.events.emit("gizmo:state", { mode: this.gizmo.getMode(), space });
  }

  get gizmoMode(): GizmoMode {
    return this.gizmo.getMode();
  }

  get gizmoSpace(): "local" | "world" {
    return this.gizmo.getSpace();
  }

  // ===================== 视图模式 / 预览渲染相机 =====================

  /**
   * 切换视图渲染：
   * - "scene"（编辑视口）：使用独立自由轨道相机，显示编辑器辅助物，可交互；
   * - "preview"（预览渲染）：使用场景中的 CameraNode（真实渲染相机）渲染，
   *   隐藏编辑器辅助物，与编辑视口相机完全独立。
   */
  setViewMode(mode: "scene" | "preview"): void {
    const want = mode === "preview";
    if (want === this.previewMode) return;
    this.previewMode = want;
    if (want) this.previewFallbackLogged = false;
    this.syncPreviewView();
  }

  /**
   * 控制编辑器后台渲染循环：
   * - active=true（场景编辑）→ 恢复 rAF 渲染；
   * - active=false（预览/脚本由中央区域独立面板接管）→ 暂停后台渲染，避免空转。
   */
  setRenderingActive(active: boolean): void {
    this.renderer.setPaused(!active);
  }

  private onSelectionChanged(): void {
    // 骨骼辅助线跟随选中（仅选中节点的模型显示）
    this.animation.setSelected(this.selectedId);
    if (!this.previewMode) return;
    this.syncPreviewView();
  }

  /** 预览相机选择：优先当前选中的 CameraNode，其次第一个非编辑器相机 */
  private resolvePreviewCameraNode(): CameraNode | null {
    const sel = this.selectedId ? this.graph.get(this.selectedId) : undefined;
    if (sel instanceof CameraNode) return sel;
    const cams = this.graph.all().filter((n): n is CameraNode => n instanceof CameraNode);
    if (!cams.length) return null;
    return cams.find((c) => !c.isEditorCamera) ?? cams[0];
  }

  /** 相机节点对应的三维预览相机实例（按 cameraType 选择透视/正交） */
  private previewCameraFor(node: CameraNode): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return node.cameraType === "orthographic" ? this.previewOrthoCamera : this.previewCamera;
  }

  /** 相机取景宽高比：优先项目设计分辨率，未配置回退视口宽高比（与视锥辅助线一致） */
  private cameraViewAspect(): number {
    const d = this.designResolution;
    if (d && d.width > 0 && d.height > 0) return d.width / d.height;
    return this.renderer.aspect;
  }

  /** 正交预览相机取景范围：半高 = orthoSize，半宽 = orthoSize × 取景宽高比 */
  private syncOrthoPreviewFrustum(): void {
    const cam = this.previewOrthoCamera;
    const aspect = this.cameraViewAspect();
    const halfH = Math.max(0.01, this.previewOrthoSize);
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.updateProjectionMatrix();
  }

  /** 把预览相机对齐到相机节点的世界变换与取景参数（按类型应用 fov 或正交范围） */
  private syncPreviewCameraTo(node: CameraNode): void {
    const cam = this.previewCameraFor(node);
    // 模型层保证 near ≥ 0.01、far ≥ 1；真实相机还需要 far > near，这里兜底
    const near = Math.max(0.01, node.near);
    const far = Math.max(node.far, near + 1e-4);
    cam.near = near;
    cam.far = far;
    if (node.cameraType === "orthographic") {
      this.previewOrthoSize = node.orthoSize;
      this.syncOrthoPreviewFrustum();
    } else {
      (cam as THREE.PerspectiveCamera).fov = node.fov;
      cam.updateProjectionMatrix();
    }
    const obj = this.synchronizer.getObjectMap().get(node.id);
    if (obj) {
      obj.getWorldPosition(cam.position);
      obj.getWorldQuaternion(cam.quaternion);
    } else {
      cam.position.set(node.transform.position.x, node.transform.position.y, node.transform.position.z);
      const rot = degToRad(node.transform.rotation);
      cam.quaternion.setFromEuler(new THREE.Euler(rot.x, rot.y, rot.z, "XYZ"));
    }
  }

  /**
   * 预览相机的清除状态（每帧渲染前调用；返回 null = 默认全清 + 全局背景）。
   * 编辑器相机与"无相机节点回退"都保持既有行为（全局天空/底色背景）；
   * 有相机节点时按节点清除标志决定清屏方式与背景内容。
   */
  private resolveClearState(cam?: THREE.Camera): CameraClearState | null {
    const node = this.previewMode ? this.previewNode : null;
    if (!node) return null;
    switch (node.clearFlags) {
      case "solidColor":
        this.clearScratchColor.setHex(node.clearColor & 0xffffff);
        return { background: this.clearScratchColor, clearColor: true, clearDepth: true };
      case "depthOnly":
        // 不清颜色：保留上一帧画面（背景不绘制，颜色缓冲原样保留）
        return { background: null, clearColor: false, clearDepth: true };
      case "colorOnly":
        // 不清深度：保留上一帧深度（背景照常清除重画）
        return { background: null, clearColor: true, clearDepth: false };
      case "skybox":
      default:
        // 正交相机：three.js 的纹理背景只支持透视相机（立方体路径按贴相机盒子
        // 绘制，正交取景远大于盒子），天空改由全屏背景面渲染（updateOrthoSkyQuad），
        // 这里只清屏、不绘制背景
        if (this.skyApplied && (cam as THREE.OrthographicCamera).isOrthographicCamera === true) {
          return { background: null, clearColor: true, clearDepth: true };
        }
        // 天空盒：全局天空纹理；无天空盒节点回退编辑器底色（与场景背景规则一致）
        if (this.skyApplied) {
          return { background: this.skyApplied.texture, clearColor: true, clearDepth: true };
        }
        this.clearScratchColor.setHex(EDITOR_BACKGROUND_COLOR);
        return { background: this.clearScratchColor, clearColor: true, clearDepth: true };
    }
  }

  /**
   * 依据当前 previewMode 应用一致的状态：
   * 有可用相机节点 → 用该节点渲染预览；
   * 无相机节点 → 用默认取景视角渲染（隐藏编辑器辅助物、禁用轨道）。
   */
  private syncPreviewView(): void {
    if (!this.previewMode) {
      this.previewNode = null;
      this.overlayVisible = true;
      this.renderer.setActiveCamera(this.renderer.camera);
      this.renderer.orbitControls.enabled = true;
      this.applyOverlayVisibility();
      return;
    }
    const node = this.resolvePreviewCameraNode();
    if (!node) {
      if (!this.previewFallbackLogged) {
        logger.info("场景中没有 CameraNode，预览使用默认相机视角");
        this.previewFallbackLogged = true;
      }
      this.previewNode = null;
      this.applyDefaultPreviewPose();
      this.overlayVisible = false;
      this.renderer.setActiveCamera(this.previewCamera);
      this.renderer.orbitControls.enabled = false;
      this.applyOverlayVisibility();
      return;
    }
    this.previewNode = node;
    this.overlayVisible = false;
    this.syncPreviewCameraTo(node);
    this.renderer.setActiveCamera(this.previewCameraFor(node));
    this.renderer.orbitControls.enabled = false;
    this.applyOverlayVisibility();
  }

  /** 无场景相机时的预览取景：从斜上方望向场景中心 */
  private applyDefaultPreviewPose(): void {
    const cam = this.previewCamera;
    cam.fov = 50;
    cam.near = 0.1;
    cam.far = 2000;
    cam.position.set(7, 5, 8);
    cam.lookAt(0, 0.6, 0);
    cam.updateProjectionMatrix();
  }

  /**
   * 编辑器辅助物显隐（与真实渲染无关的装饰）：
   * 网格、相机体、灯光的辅助球/框、gizmo、选择框。
   */
  private applyOverlayVisibility(): void {
    const vis = this.overlayVisible;
    this.renderer.scene.traverse((o) => {
      if (o.name === "__grid" || o.name === "__camBody" || o.name === "__camIcon") {
        o.visible = vis;
        return;
      }
      const ud = o.userData as { lamp?: boolean };
      if (ud.lamp) {
        // 保留真实灯光对象，仅隐藏装饰 mesh
        o.children.forEach((c) => {
          if (!(c as THREE.Light).isLight) c.visible = vis;
        });
      }
    });
    this.gizmo.setEditorEnabled(vis);
    this.helperSystem.setVisible(vis);
    this.animation.setOverlayVisible(vis);
  }

  // ===================== 视口点击选择 =====================

  private setupViewportClickHandler(): void {
    const dom = this.renderer.domElement;
    const handler = (e: MouseEvent) => this.onViewportMouseDown(e);
    this._viewportClickHandler = handler;
    dom.addEventListener("mousedown", handler);
  }

  private removeViewportClickHandler(): void {
    if (!this._viewportClickHandler) return;
    this.renderer.domElement.removeEventListener("mousedown", this._viewportClickHandler);
    this._viewportClickHandler = null;
  }

  _viewportClickHandler: ((e: MouseEvent) => void) | null = null;

  private onViewportMouseDown(e: MouseEvent): void {
    // Only handle left-click (button 0) and only when not dragging in orbit/gizmo
    if (e.button !== 0) return;
    if (this.gizmo.isDragging()) return;
    // 预览渲染无编辑器选择语义
    if (this.previewMode) return;

    // Calculate mouse position in normalized device coordinates (-1 to +1)
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Set up raycasting from camera through mouse position
    this.raycaster.setFromCamera(this.mouse, this.renderer.camera);

    // Get all mapped scene objects
    const objectMap = this.synchronizer.getObjectMap();
    const objects = Array.from(objectMap.values());

    // Find intersections with scene objects
    const intersects = this.raycaster.intersectObjects(objects, true);
    if (intersects.length === 0) {
      // Clicked empty space — clear selection (unless shift is held for multi-select)
      if (!e.shiftKey && !e.ctrlKey) {
        this.clearSelection();
      }
      return;
    }

    // Find the first intersection that maps to a selectable node.
    // 场景根节点只能从层级面板选中，不允许通过视口点击选中：
    // 命中对象的最近映射节点若解析到根节点，跳过该项（视为点击空白）。
    const rootId = this.graph.root?.id ?? null;
    let pickedId: string | null = null;
    for (const hit of intersects) {
      let obj: THREE.Object3D | null = hit.object as THREE.Object3D;
      while (obj) {
        const nodeId = (obj.userData as { nodeId?: string }).nodeId ?? null;
        if (nodeId && objectMap.has(nodeId)) {
          if (nodeId !== rootId) {
            pickedId = nodeId;
          }
          obj = null; // 已找到最近映射节点（根节点不可从视口选中 → 不采纳）
          break;
        }
        obj = obj.parent;
      }
      if (pickedId) break;
    }
    if (!pickedId) {
      // Clicked empty space (or only resolved to the scene root) — clear selection
      // (unless shift is held for multi-select)
      if (!e.shiftKey && !e.ctrlKey) {
        this.clearSelection();
      }
      return;
    }
    if (e.shiftKey || e.ctrlKey) {
      this.toggleSelection(pickedId);
    } else {
      this.select(pickedId);
    }
  }
}

/** 混合两个 RGB hex 颜色（t=0 全 a，t=1 全 b） */
function mixHexColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}
