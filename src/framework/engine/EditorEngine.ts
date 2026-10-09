// ---------------------------------------------------------------------------
// EditorEngine —— 编辑器引擎门面。
//
// 本文件只保留三类内容（按「挂载 / 模块编排 / 事件」拆分后的聚合点）：
// 1. 字段声明与构造器：12 个子系统的实例化与互相接线（模块编排的源头）；
// 2. 选择簿记与小委托（undo/redo、gizmo 模式、视图开关等一行转发）；
// 3. 公共 API 的薄委托——实现体在 engine/ 下的关切模块：
//    mount.ts（挂载/卸载）、events.ts（事件反应路由）、nodeOps.ts（节点操作）、
//    assetRefresh.ts（资产刷新/预取）、skyEnv.ts / fogEnv.ts（场景环境）、
//    previewView.ts / pipView.ts（预览与画中画）、navSources.ts（导航烘焙输入）、
//    terrainPaint.ts（地形绘制会话）、viewportQuery.ts / layoutNav.ts（视口查询
//    与布局导航）。跨模块共享的内部字段不带 private（engine/ 内部接线面）。
// ---------------------------------------------------------------------------
import { EventBus } from "../../platform_abstraction/eventBus";
import * as THREE from "three";
import { createNodeFactory, NodeFactory } from "../factory/NodeFactory";
import { createDefaultRegistry } from "../prototype/PrototypeRegistry";
import {
  SceneClient,
  type HistoryView,
  type SceneTransport,
  type TransformSnapshot,
} from "../scene/SceneClient";
import type { Node } from "../prototype/Node";
import { JsonRecord, type Vec3 } from "../prototype/types";
import { ensureHeightFogChunk } from "../fog";
import { RendererManager, type RendererBackend } from "./modules/RendererManager";
import { HelperSystem } from "./modules/HelperSystem";
import { TerrainPaintController, type TerrainToolBrush } from "./modules/TerrainPaintController";
export type { GizmoMode } from "./modules/GizmoController";
import { GizmoController, type GizmoMode } from "./modules/GizmoController";
import { SceneSynchronizer } from "./modules/SceneSynchronizer";
import { hookDataOf } from "../material/shaderHooks";
import { MaterialManager } from "../material/MaterialManager";
import { ShaderManager } from "../material/ShaderManager";
import { ModelManager, type ModelFileAccess } from "../mesh";
import { AnimationSystem } from "../animation";
import { AudioSystem } from "../audio";
import { ParticleSystem } from "../particles";
import { PhysicsSystem } from "../physics";
import {
  NavSystem,
  type NavHeightField,
  type NavObstacle,
} from "../navigation";
import { LogicSystem } from "../logic";
import { UISystem } from "./modules/ui";
import { snapshotTransform } from "./modules/utils";
import {
  AudioNode,
  BtRunnerNode,
  CameraNode,
  FogKind,
  FsmRunnerNode,
  GeometryKind,
  LightNode,
  MeshNode,
  NavAgentNode,
  NavAreaNode,
  ParticleSystemNode,
  SkyboxKind,
  TerrainNode,
  UIButtonNode,
  UICanvasNode,
  UIImageNode,
  UILayoutNode,
  UITextNode,
  UIScaleMode,
} from "../prototype/derived/Primitives";
import type { SplatBuffer } from "../terrain/paint";
import type { TerrainSettings } from "../terrain";
import type { SkyMatParams } from "./modules/skyboxTextures";
import { mountEditorEngine, disposeEditorEngine } from "./mount";
import {
  onCaptureKeyDown,
  onCapturePointerDown,
  onSelectionChanged,
  syncAudioComponents,
  syncPhysicsNode,
} from "./events";
import {
  addAudio,
  addBtRunner,
  addCamera,
  addDataMesh,
  addEmptyGroup,
  addFog,
  addFsmRunner,
  addLight,
  addMesh,
  addModel,
  addNavAgent,
  addNavArea,
  addParticleSystem,
  addScriptNode,
  addSkybox,
  addTerrain,
  addUIButton,
  addUICanvas,
  addUIImage,
  addUILayout,
  addUIText,
  alignCameraToViewport,
  deleteNodes as deleteNodesOp,
  duplicateNode,
  instantiateTree,
  patchNode as patchNodeOp,
  patchNodes as patchNodesOp,
  reparentNodes as reparentNodesOp,
  serializeSubtree,
  setTransform as setTransformOp,
} from "./nodeOps";
import {
  invalidateTexture as invalidateTextureOp,
  loadTexture as loadTextureOp,
  preloadMaterials as preloadMaterialsOp,
  preloadTextures as preloadTexturesOp,
  refreshAudioNodeIcon as refreshAudioNodeIconOp,
  refreshMaterialNodes as refreshMaterialNodesOp,
  refreshModelNodes as refreshModelNodesOp,
  refreshShaderNodes as refreshShaderNodesOp,
} from "./assetRefresh";
import {
  applySkyFromGraph,
  invalidateSkyMaterial as invalidateSkyMaterialOp,
  invalidateTexCube as invalidateTexCubeOp,
  removeSkyEnvLight as removeSkyEnvLightOp,
} from "./skyEnv";
import { applyFogFromGraph } from "./fogEnv";
import { resolveClearState, syncOrthoPreviewFrustum, syncPreviewView } from "./previewView";
import { emitPiPState } from "./pipView";
import {
  navBoundsFor,
  navHeightFieldFor,
  navObstaclesFor,
  navTargetOf,
} from "./navSources";
import {
  beginTerrainPaint as beginTerrainPaintOp,
  commitTerrainSculpt as commitTerrainSculptOp,
  invalidateTerrainSplatmap as invalidateTerrainSplatmapOp,
  invalidateTerrainSplatmapCache as invalidateTerrainSplatmapCacheOp,
  setTerrainPaintCommitHandler as setTerrainPaintCommitHandlerOp,
} from "./terrainPaint";
import { focusOnNode as focusOnNodeOp, isSelectableInViewport, screenToWorldPoint as screenToWorldPointOp } from "./viewportQuery";
import type { LayoutNavState } from "./layoutNav";
import type { SceneChangedEvent } from "../scene/SceneClient";

export interface EditorEvents extends Record<string, unknown> {
  "graph:changed": import("../scene/SceneClient").SceneChange;
  "select:changed": { nodeId: string | null };
  "gizmo:state": { mode: GizmoMode; space: "local" | "world" };
  /** 材质资产参数变更（保存/刷新后广播；rel 为空串表示全部） */
  "material:changed": { rel: string };
  /** 着色器程序变更（首次加载/源码保存后广播；rel 为空串表示全部） */
  "shader:changed": { rel: string };
  /** 着色器编译失败（three 的程序编译报错；message 为可读摘要） */
  "shader:error": { message: string };
  /** 模型资产解析状态变更（加载完成/失败/失效后广播；rel 为空串表示全部） */
  "model:changed": { rel: string };
  /** 节点动画运行时变化（播放/暂停/图状态切换/参数写入） */
  "animation:changed": { nodeId: string };
  /** 音源节点运行时变化（绑定/加载完成/播放控制/数据写入） */
  "audio:changed": { nodeId: string };
  /** 物理运行时变化（绑定/世界就绪/模拟启停/数据写入） */
  "physics:changed": { nodeId: string };
  /** 粒子系统运行时变化（播放/暂停/停止/重启控制后广播） */
  "particles:changed": { nodeId: string };
  /** 逻辑运行器运行时变化（绑定/资产就绪/状态切换/黑板写入） */
  "logic:changed": { nodeId: string };
  /** 画中画浮层状态（选中相机节点时编辑视口右下角取景渲染；DOM 浮层按此显隐定位） */
  "pip:state": { active: boolean; width: number; height: number; label: string | null };
}

export class EditorEngine {
  readonly factory: NodeFactory;
  /** 场景镜像（权威状态在后端；读接口与旧 SceneGraph 同构） */
  readonly graph: SceneClient;
  readonly events = new EventBus<EditorEvents>();

  readonly renderer = new RendererManager();
  readonly synchronizer: SceneSynchronizer;
  readonly helperSystem: HelperSystem;
  /** 地形绘制控制器（视口左键 → splatmap 笔刷；mount 时初始化，begin/end 由命令切换） */
  terrainPaint!: TerrainPaintController;
  /** 材质资产参数缓存/解析（网格按引用取参数渲染；应用层注入文件读取器） */
  readonly materials = new MaterialManager();
  /** 着色器文档缓存（渲染分支 + 钩子 + 属性表按引用取；应用层注入文件读取器） */
  readonly shaders = new ShaderManager();
  /** 模型资产缓存/实例化（模型网格按引用克隆渲染；应用层注入文件读取器） */
  readonly models = new ModelManager();
  /** 动画系统（模型网格的剪辑播放/骨骼动画/动画图状态机；渲染循环推进） */
  readonly animation = new AnimationSystem();
  /** 音频系统（音源节点的 2D/3D Web Audio 播放；渲染循环推进监听器与可见性） */
  readonly audio = new AudioSystem();
  /** 音源组件绑定登记（节点 id → 该节点上已绑定音源组件的组件 id 集；移除时集中解绑） */
  audioCompBindings = new Map<string, Set<string>>();
  /** 物理系统（刚体/碰撞体节点模拟；固定步长推进，动力学体回写渲染变换） */
  readonly physics = new PhysicsSystem();
  /** 粒子系统（粒子节点的 CPU 模拟 + Points 渲染；渲染循环推进） */
  readonly particles = new ParticleSystem();
  /** 导航系统（导航区域烘焙：可行走网格 + SDF 距离场；代理寻路移动） */
  readonly nav = new NavSystem();
  /** 逻辑系统（状态机/行为树运行器绑定 .fsm/.bt 资产并推进；渲染循环 tick） */
  readonly logic = new LogicSystem();
  /** 导航多源合并高度场缓存（areaId → {签名键, 场}；源未变不重光栅） */
  readonly navFieldCache = new Map<string, { key: string; field: NavHeightField & { sig: string } }>();
  /** 导航网格源 XZ 范围缓存（nodeId → {签名, AABB}；几何遍历只在签名变化时做） */
  readonly navMeshBoundsCache = new Map<string, { sig: string; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null }>();
  /** 导航障碍缓存（场景级；候选 + 签名比对后按需重收集，AABB 计算不重复做） */
  navObstacleCache: { sig: string; items: { id: string; box: NavObstacle }[] } | null = null;
  /** UI 系统（Canvas-Widget 相机叠加；渲染循环把画布根贴合活动相机并合成渲染序） */
  readonly uiSystem = new UISystem();
  /** 帧间隔计时器（渲染回调里取帧间隔；THREE.Clock 已在 r183 弃用 → Timer） */
  timer = new THREE.Timer();
  /** 扩展着色器时间（秒；按帧间隔累加，供 _Time uniform 使用） */
  shaderTime = 0;
  /** 贴图 URL 解析器（相对路径 → asset:// 协议 URL；应用层注入） */
  textureUrlResolver: ((rel: string) => string | null) | null = null;
  /** 贴图加载缓存（key = "srgb?c|n|rel" → Texture 或 null） */
  textureCache = new Map<string, Promise<THREE.Texture | null>>();
  /** 贴图加载器（asset:// 协议 URL → Image 解码；colorSpace 按通道设置） */
  textureLoader = new THREE.TextureLoader();
  /** TextureCube（.texcube）加载缓存（key = "version|rel"；invalidateTexCube 换版本） */
  texCubeCache = new Map<string, Promise<THREE.Texture | null>>();
  /** TextureCube 内容版本（外部改写 .texcube 后 bump，签名随之失效触发重载） */
  texCubeVersions = new Map<string, number>();
  /** 天空盒材质参数缓存（key = "version|rel"；invalidateSkyMaterial 换版本） */
  skyMatCache = new Map<string, Promise<SkyMatParams | null>>();
  /** 天空盒材质内容版本（检查器改写 .mat 后 bump） */
  skyMatVersions = new Map<string, number>();
  /** 当前生效的天空背景属性（旋转/强度/模糊；procedural/兜底时为中性值） */
  skyBgProps: { rotation: number; intensity: number; blurriness: number } = {
    rotation: 0,
    intensity: 1,
    blurriness: 0,
  };
  /** 天空重算纪元：任何贴图/材质失效时 bump，使天空签名失效 */
  skyEpoch = 0;
  gizmo!: GizmoController;
  /** UI 锚点托管节点拖拽起点快照（整节点 JSON；提交走 commitPatch 一次撤销） */
  uiDragBeforeJSON: JsonRecord | null = null;
  /** 布局视口 2D 导航控制器状态（installLayoutNavigation 装配/拆除） */
  layoutNav: LayoutNavState | null = null;
  /** 视口点选监听（mount 装配/ dispose 拆除；handler 体在 events.ts） */
  _viewportClickHandler: ((e: MouseEvent) => void) | null = null;

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
    syncOrthoPreviewFrustum(this);
  }

  selectedId: string | null = null;
  selectedIds: string[] = [];
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  /** 选中范围谓词（动画聚焦编辑用：非 null 时仅允许其返回 true 的节点被选中；
   *  设置为 null 恢复全场景可选）。谓词由 app 层闭包提供，引擎不感知编辑模式。 */
  private _selectionFilter: ((id: string | null) => boolean) | null = null;

  setSelectionFilter(fn: ((id: string | null) => boolean) | null): void {
    this._selectionFilter = fn;
  }

  /** 选中目标是否被当前范围允许（无过滤器 = 一律允许） */
  private allowedToSelect(id: string | null): boolean {
    return this._selectionFilter ? this._selectionFilter(id) : true;
  }

  // —— gizmo 拖动“独占”期间的全局输入拦截（避免左键/键位串扰变换）——
  readonly onCapturePointerDown = (e: PointerEvent): void => onCapturePointerDown(this, e);

  readonly onCaptureKeyDown = (e: KeyboardEvent): void => onCaptureKeyDown(this, e);

  /** 场景真实渲染相机（预览用，透视）：与编辑器自由轨道相机相互独立 */
  readonly previewCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  /** 场景真实渲染相机（预览用，正交）：按相机节点 orthoSize 取景（宽高比同视锥辅助线规则） */
  readonly previewOrthoCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 2000);
  /** 当前预览正交取景半高（来自相机节点 orthoSize；视口/设计分辨率比例变化时重算范围） */
  previewOrthoSize = 5;
  /** 天空盒背景当前生效状态（签名 + 背景纹理）：变更/移除/销毁时据此释放 */
  skyApplied: { sig: string; texture: THREE.Texture } | null = null;
  /** 当前生效雾的签名（fogNode id/kind/参数；无生效雾为 null）——脏检查避免每帧重建 */
  fogAppliedSig: string | null = null;
  /** 已销毁标记：mount 期间被 dispose 后终止后续初始化；dispose 幂等 */
  disposed = false;
  /** 后端 scene:changed 事件订阅取消函数 */
  sceneUnlisten: (() => void) | null = null;
  /** 天空盒激活时注入的半球环境光（天空色照亮网格材质；无天空盒时移除） */
  skyLight: THREE.HemisphereLight | null = null;
  /**
   * 正交预览的天空背景面：three.js 的纹理背景（立方体路径）只支持透视相机
   * （按贴在相机位置的 1×1×1 反转盒绘制，正交取景远大于盒子，只剩中间一小块）。
   * 正交预览（清除标志=skybox）时改由该全屏三角形渲染天空：逐像素由逆投影
   * 求光线方向后采样天空纹理——等距柱状纹理按 equirectUv 采样，TextureCube
   * 六面纹理按光线方向 cube 采样（uIsCube 分支），正交/透视光线方向都精确。
   */
  orthoSkyQuad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  /** 是否处于预览渲染（用场景中的 CameraNode 渲染） */
  previewMode = false;
  /** 预览渲染当前生效的相机节点（null = 无可用相机，按默认视角回退） */
  previewNode: CameraNode | null = null;
  /** 清除状态共享色（纯色/底色背景复用同一实例，避免每帧新建对象） */
  clearScratchColor = new THREE.Color();
  /** 编辑器辅助物（网格/相机盒体/灯球/gizmo/选择框）是否显示 */
  overlayVisible = true;
  /** 无场景相机时的回退提示是否已输出过（避免每次图事件刷屏） */
  previewFallbackLogged = false;
  /** 画中画相机（透视/正交）：选中相机节点时右下角取景渲染，独立于预览相机
   *  （不注册进渲染器相机表——取景宽高比逐帧按画中画矩形设置，不随视口比例走） */
  readonly pipPerspCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  readonly pipOrthoCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 2000);
  /** 画中画当前生效的相机节点（null = 未选中相机/预览中；清除状态按此给出） */
  pipNode: CameraNode | null = null;
  /** 画中画渲染期间被隐藏的辅助物（渲染后按记录复原，避免覆盖其它显隐逻辑） */
  pipHidden: THREE.Object3D[] = [];
  /** 画中画正交天空背景面是否处于启用态（endPiPPass 复原可见性用） */
  pipOrthoSkyActive = false;
  /** 上次上报 DOM 浮层的画中画状态（变化才发事件，避免 resize 逐帧刷屏） */
  pipEmitted: { w: number; h: number; label: string } | null = null;
  /** 当前工具笔刷参数（应用层经 setTerrainPaintBrush 注入 UI 状态） */
  paintBrush: TerrainToolBrush = {
    tool: "sculpt",
    layer: 0,
    radius: 8,
    strength: 0.6,
    erase: false,
    sculptMode: "raise",
  };
  /** 应用层注入的绘制落盘（编码 PNG → 写资产 → 调 invalidateTerrainSplatmap） */
  terrainPaintCommitHandler: ((buffer: SplatBuffer, rel: string) => void) | null = null;

  constructor() {
    // 高度雾 chunk patch：必须先于任何材质 program 编译（此时尚无渲染发生）
    ensureHeightFogChunk();
    // 接入页面可见性 API：窗口隐藏期间 delta 置零、恢复时重置，避免巨大补帧间隔
    // （浏览器外的冒烟环境无 document，跳过即可，Timer 照常工作）
    if (typeof document !== "undefined") this.timer.connect(document);
    this.factory = createNodeFactory(createDefaultRegistry());
    this.graph = new SceneClient(this.factory);
    // 骨骼辅助线需挂在无变换的场景根下（挂在节点容器上会叠加两次节点变换）
    this.animation.setSceneRoot(this.renderer.scene);
    // 骨骼绑定的目标解析：场景树按 userData.nodeId 查找（attach 频度低，遍历可接受）
    this.animation.setTargetResolver((nodeId) => {
      let hit: THREE.Object3D | null = null;
      this.renderer.scene.traverse((o) => {
        if (!hit && o.userData?.nodeId === nodeId) hit = o;
      });
      return hit;
    });
    this.synchronizer = new SceneSynchronizer(this.renderer.scene, {
      paramsFor: (rel) => this.materials.paramsFor(rel),
      typeFor: (rel) => this.materials.typeFor(rel),
      shaderFor: (rel) => this.materials.shaderFor(rel),
      shaderHooksFor: (shaderRel) => hookDataOf(this.shaders.docFor(shaderRel)),
      loadTexture: (rel, srgb) => this.loadTexture(rel, srgb),
      instantiateModel: (rel) => this.models.instantiate(rel),
      modelReady: (rel) => this.models.has(rel),
      onModelInstance: (node, root) => this.bindNodeAnimation(node, root),
      audioStateFor: (nodeId) => this.audio.stateFor(nodeId),
    });
    // 材质库缓存更新（编辑保存等）→ 刷新引用该材质的所有网格外观
    this.materials.onChanged((rel) => this.refreshMaterialNodes(rel));
    // 着色器文档更新（首次加载/源码保存）→ 刷新引用该着色器的材质所挂网格
    this.shaders.onChanged((rel) => {
      this.refreshShaderNodes(rel);
      this.events.emit("shader:changed", { rel });
    });
    // 模型库缓存更新（加载完成/失效）→ 刷新引用该模型的所有网格
    this.models.onChanged((rel) => {
      this.refreshModelNodes(rel);
      this.events.emit("model:changed", { rel });
    });
    // 动画运行时变化（播放/图状态/参数）→ 广播给面板刷新
    this.animation.onChange((nodeId) => this.events.emit("animation:changed", { nodeId }));
    // 音频运行时变化（绑定/加载/播放控制）→ 广播给面板与音源图标刷新
    this.audio.onChange((nodeId) => {
      this.refreshAudioNodeIcon(nodeId);
      this.events.emit("audio:changed", { nodeId });
    });
    // 物理运行时变化（绑定/世界就绪/模拟启停）→ 广播给面板与工具栏刷新
    this.physics.onChange((nodeId) => this.events.emit("physics:changed", { nodeId }));
    // 导航系统：烘焙输入来自场景（地形高度场 + 网格光栅化高度场 + 静态碰撞体
    // 投影）；烘焙产物写节点对象 userData 后回调同步器刷新可视化叠层。
    // 采样源 = settings.sourceIds（地形或网格，空 = 自动第一块地形），引擎侧带
    // 缓存（合并高度场 / 网格 AABB / 障碍列表按签名复用，避免每次签名比对重算）。
    this.nav.providers = {
      boundsFor: (area) => navBoundsFor(this, area),
      heightFieldFor: (area) => navHeightFieldFor(this, area),
      obstaclesFor: (area) => navObstaclesFor(this, area),
      targetFor: (nodeId) => navTargetOf(this, nodeId),
    };
    this.nav.onBakeUpdated = (nodeId) => {
      const n = this.graph.get(nodeId);
      if (n) this.synchronizer.refreshNodeFor(n);
    };
    // 粒子运行时变化（播放控制）→ 广播给检查器刷新状态文案
    this.particles.onChange((nodeId) => this.events.emit("particles:changed", { nodeId }));
    // 逻辑运行时变化（绑定/资产就绪/状态切换）→ 广播给检查器刷新状态视图
    this.logic.onChange = (nodeId) => this.events.emit("logic:changed", { nodeId });
    // 粒子贴图走与材质贴图同一套 rel → asset:// 加载缓存（颜色贴图 sRGB）
    this.particles.setTextureLoader((rel) => this.loadTexture(rel, true));
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
    this.renderer.registerCamera(this.previewOrthoCamera, () => syncOrthoPreviewFrustum(this));
    // 预览相机默认全层可见：只有激活相机节点时才应用该节点的 cullingMask
    //（syncPreviewCameraTo），回退默认视角/退出预览时恢复全层
    this.previewCamera.layers.enableAll();
    this.previewOrthoCamera.layers.enableAll();
    // 视口拾取射线不按层过滤（编辑器要能选中任意层的节点；渲染裁剪是另一回事）
    this.raycaster.layers.enableAll();
    // 清除标志：渲染循环每帧按活动相机取清除状态（预览相机节点决定清屏方式）
    this.renderer.setClearProvider((cam) => resolveClearState(this, cam));
  }

  // ===================== 生命周期（实现见 mount.ts） =====================

  async mount(
    container: HTMLElement,
    options?: {
      renderer?: RendererBackend;
      antialias?: number;
      hdrMode?: "hdr" | "ldr";
    },
  ): Promise<void> {
    await mountEditorEngine(this, container, options);
  }

  dispose(): void {
    disposeEditorEngine(this);
  }

  /** gizmo 是否正在拖动（变换过程中）——其它交互可用此状态判断是否需要忽略 */
  get isGizmoDragging(): boolean {
    return this.gizmo ? this.gizmo.isDragging() : false;
  }

  /** 引擎是否已销毁（mount 流程与 store 层用它判断是否中止后续初始化/装载） */
  isDisposed(): boolean {
    return this.disposed;
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
    subscribe: (fn: (e: SceneChangedEvent) => void) => Promise<() => void>,
  ): Promise<void> {
    this.unbindSceneEvents();
    this.sceneUnlisten = await subscribe((e) => {
      if (!this.disposed) this.graph.applyEvent(e);
    });
  }

  /** 后端事件订阅拆除（dispose 序列调用；实现留在门面因状态单一） */
  unbindSceneEvents(): void {
    this.sceneUnlisten?.();
    this.sceneUnlisten = null;
  }

  /** 选中变化反应（select:changed 挂载于 mount；实现见 events.ts） */
  onSelectionChanged(): void {
    onSelectionChanged(this);
  }

  // ===================== 贴图/模型接入（实现见 assetRefresh.ts / mesh） =====================

  /** 注入贴图 URL 解析器（相对路径 → asset:// 协议 URL；应用层按项目根封装） */
  setTextureResolver(fn: ((rel: string) => string | null) | null): void {
    this.textureUrlResolver = fn;
    this.textureCache.clear();
    // 项目根变化后旧 URL 全部失效：天空贴图缓存一并清除（签名含版本号自动重载）
    this.texCubeCache.clear();
    // 音频与贴图同一套 rel → URL 语义：解析器变化后旧缓冲失效并按新解析器重载
    this.audio.setUrlResolver(fn);
    // 粒子贴图同理：重装加载器让已绑定发射器按新解析器重取贴图
    this.particles.setTextureLoader((rel) => this.loadTexture(rel, true));
    this.applySkyFromGraph();
  }

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

  loadTexture(rel: string, srgb: boolean): Promise<THREE.Texture | null> {
    return loadTextureOp(this, rel, srgb);
  }

  invalidateTexture(rel: string): void {
    invalidateTextureOp(this, rel);
  }

  // ===================== 操作 API（实现见 nodeOps.ts） =====================

  undo(): void {
    this.graph.undo();
  }

  redo(): void {
    this.graph.redo();
  }

  addMesh(geometry: GeometryKind, parentId?: string, position?: Vec3): MeshNode {
    return addMesh(this, geometry, parentId, position);
  }

  addDataMesh(parentId?: string, position?: Vec3): MeshNode {
    return addDataMesh(this, parentId, position);
  }

  addModel(rel: string, parentId?: string, position?: Vec3): MeshNode {
    return addModel(this, rel, parentId, position);
  }

  addAudio(parentId?: string, source = ""): AudioNode {
    return addAudio(this, parentId, source);
  }

  addLight(kind: LightNode["lightKind"], parentId?: string): LightNode {
    return addLight(this, kind, parentId);
  }

  addParticleSystem(parentId?: string): ParticleSystemNode {
    return addParticleSystem(this, parentId);
  }

  addTerrain(parentId?: string, init?: { asset?: string; terrain?: TerrainSettings }): TerrainNode {
    return addTerrain(this, parentId, init);
  }

  addCamera(parentId?: string): CameraNode {
    return addCamera(this, parentId);
  }

  addNavArea(parentId?: string): NavAreaNode {
    return addNavArea(this, parentId);
  }

  addNavAgent(parentId?: string): NavAgentNode {
    return addNavAgent(this, parentId);
  }

  addFsmRunner(parentId?: string): FsmRunnerNode {
    return addFsmRunner(this, parentId);
  }

  addBtRunner(parentId?: string): BtRunnerNode {
    return addBtRunner(this, parentId);
  }

  addFog(kind: FogKind, parentId?: string): import("../prototype/derived/Primitives").FogNode {
    return addFog(this, kind, parentId);
  }

  addUICanvas(parentId?: string, defaults?: { designWidth: number; designHeight: number; scaleMode?: UIScaleMode }): UICanvasNode {
    return addUICanvas(this, parentId, defaults);
  }

  addUIImage(parentId?: string): UIImageNode {
    return addUIImage(this, parentId);
  }

  addUIText(parentId?: string): UITextNode {
    return addUIText(this, parentId);
  }

  addUIButton(parentId?: string): UIButtonNode {
    return addUIButton(this, parentId);
  }

  addUILayout(parentId?: string): UILayoutNode {
    return addUILayout(this, parentId);
  }

  addEmptyGroup(parentId?: string): Node {
    return addEmptyGroup(this, parentId);
  }

  addSkybox(kind: SkyboxKind, parentId?: string): import("../prototype/derived/Primitives").SkyboxNode {
    return addSkybox(this, kind, parentId);
  }

  addScriptNode(scriptRel: string, nodeType: { kind: string; label?: string }, parentId?: string): Node {
    return addScriptNode(this, scriptRel, nodeType, parentId);
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    this.deleteNodes([this.selectedId]);
  }

  deleteNodes(ids: string[]): void {
    deleteNodesOp(this, ids);
  }

  reparentNodes(moves: { id: string; newParentId: string | null; newIndex: number }[]): void {
    reparentNodesOp(this, moves);
  }

  renameSelected(name: string): void {
    if (this.selectedId) this.graph.rename(this.selectedId, name);
  }

  reparentSelected(newParentId: string | null): void {
    if (!this.selectedId) return;
    this.reparentNodes([{ id: this.selectedId, newParentId, newIndex: -1 }]);
  }

  setTransform(nodeId: string, snap: TransformSnapshot): void {
    setTransformOp(this, nodeId, snap);
  }

  alignCameraToViewport(nodeId: string): boolean {
    return alignCameraToViewport(this, nodeId);
  }

  patchNode(nodeId: string, before: JsonRecord, after: JsonRecord, label?: string): void {
    patchNodeOp(this, nodeId, before, after, label);
  }

  patchNodes(items: { id: string; before: JsonRecord; after: JsonRecord }[], label?: string): void {
    patchNodesOp(this, items, label);
  }

  instantiateTree(
    doc: JsonRecord,
    prefabRel: string,
    parentId?: string,
    label?: string,
    position?: Vec3,
  ): Node | null {
    return instantiateTree(this, doc, prefabRel, parentId, label, position);
  }

  serializeSubtree(nodeId: string): JsonRecord | null {
    return serializeSubtree(this, nodeId);
  }

  duplicateNode(nodeId: string): string | null {
    return duplicateNode(this, nodeId);
  }

  // ===================== 资产刷新/预取（实现见 assetRefresh.ts） =====================

  refreshMaterialNodes(rel?: string | null): void {
    refreshMaterialNodesOp(this, rel);
  }

  refreshShaderNodes(shaderRel?: string | null): void {
    refreshShaderNodesOp(this, shaderRel);
  }

  preloadTextures(rels: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    return preloadTexturesOp(this, rels, onProgress);
  }

  preloadMaterials(rels: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    return preloadMaterialsOp(this, rels, onProgress);
  }

  refreshModelNodes(rel?: string | null): void {
    refreshModelNodesOp(this, rel);
  }

  refreshAudioNodeIcon(nodeId: string): void {
    refreshAudioNodeIconOp(this, nodeId);
  }

  // ===================== 选择 =====================

  get selectionIds(): string[] {
    return [...this.selectedIds];
  }

  select(id: string | null): void {
    // 动画聚焦编辑中：仅允许范围树内的节点被选中（空点/范围外一律忽略）
    if (!this.allowedToSelect(id)) return;
    this.selectedIds = id ? [id] : [];
    this.selectedId = id;
    this.gizmo.select(id, this.synchronizer.getObjectMap());
    this.helperSystem.setSelectedIds(this.selectedIds);
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  addToSelection(id: string): void {
    if (!id || this.selectedIds.includes(id)) return;
    if (!this.allowedToSelect(id)) return;
    if (this.selectedIds.length === 0) this.selectedId = id;
    this.selectedIds.push(id);
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  toggleSelection(id: string): void {
    if (!id) return;
    if (!this.allowedToSelect(id)) return;
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
    // 范围选同样过选中过滤（动画聚焦/布局视口）：范围外 id 剔除；
    // 全部被拒时保持现状（避免一次越界操作误清已有选中）
    const next = ids.filter((id) => this.allowedToSelect(id));
    if (ids.length > 0 && next.length === 0) return;
    this.selectedIds = next;
    this.selectedId = next[next.length - 1] ?? null;
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  clearSelection(): void {
    this.select(null);
  }

  private syncGizmo(): void {
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap());
    this.helperSystem.setSelectedIds(this.selectedIds);
  }

  getTransform(id: string): TransformSnapshot | null {
    const node = this.graph.get(id);
    return node ? snapshotTransform(node) : null;
  }

  getSelectedNode(): Node | undefined {
    return this.selectedId ? this.graph.get(this.selectedId) : undefined;
  }

  // ===================== 整体重建（模块编排） =====================

  rebuildAll(): void {
    // 场景整体重建：先解除全部动画绑定（mixer 指向旧实例），重建时经
    // onModelInstance 逐节点重新绑定
    this.animation.unbindAll();
    // 音频绑定同样指向旧场景对象：整体重建后按新对象重绑
    this.audio.unbindAll();
    this.audioCompBindings.clear();
    // 物理绑定指向旧场景对象：模拟中一并停止（世界里的体按旧位姿建出）
    this.physics.unbindAll();
    // 粒子发射器挂在旧场景对象下：整体重建后按新对象重建
    this.particles.unbindAll();
    // 导航绑定同样指向旧场景对象（replace 事件阶段同步器不重建对象，打开
    // 项目时的绑定会落在旧/空对象表上）；烘焙输入缓存按内容/矩阵签名，跨
    // 场景节点 id 可能重复 → 一并清空，重建后按新对象重绑重烘焙
    this.nav.unbindAll();
    this.navFieldCache.clear();
    this.navMeshBoundsCache.clear();
    this.navObstacleCache = null;
    // 逻辑运行态同样指向旧场景对象：整体重建后按新对象重绑（运行开关随设置）
    this.logic.unbindAll();
    this.synchronizer.rebuildAll(this.graph);
    this.helperSystem.rebuildAll(this.graph, this.synchronizer.getObjectMap());
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap());
    this.animation.setSelected(this.selectedId);
    for (const node of this.graph.all()) {
      const obj = this.synchronizer.getObjectMap().get(node.id);
      if (obj) {
        if (node instanceof AudioNode) this.audio.syncNode(node, obj);
        if (node instanceof ParticleSystemNode) this.particles.syncNode(node, obj);
        // 导航区域/代理：按新对象重绑（区域按签名重烘焙，设置/源未变不重烤）
        if (node instanceof NavAreaNode) this.nav.syncArea(node, obj);
        else if (node instanceof NavAgentNode) this.nav.syncAgent(node, obj);
        // 逻辑运行器：按新对象重绑（资产文本按 rel 缓存命中则不重读）
        if (node instanceof FsmRunnerNode) this.logic.syncFsm(node, obj);
        else if (node instanceof BtRunnerNode) this.logic.syncBt(node, obj);
      }
      syncAudioComponents(this, node);
      syncPhysicsNode(this, node);
    }
    this.applySkyFromGraph();
    this.applyFogFromGraph();
  }

  /** 用后端装载结果中的嵌套文档根重建镜像与渲染（scene_open / scene_load_doc 装载用） */
  applySceneDocRoot(rootJson: JsonRecord | null): void {
    this.graph.replaceFromDocRoot(rootJson);
    this.selectedId = null;
    this.rebuildAll();
  }

  // ===================== gizmo 模式 / 视图模式 / 环境 =====================

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

  /**
   * 编辑视口 UI 显示开关：布局视图开（画布贴合相机叠加显示，可点选/Gizmo 编辑），
   * 场景视图关（画布整体隐藏，视口点选同规则不可选中）。导出运行时不受影响（恒显示）。
   */
  setUIViewVisible(visible: boolean): void {
    this.uiSystem.setVisible(visible);
    // 布局视口：变换工具按 UI 2D 语义显示（平移/缩放 = X/Y 轴，旋转 = Z 轴）；
    // 导航切 2D 设计视图（滚轮缩放/右中键平移），禁用轨道相机（旋转/推拉对
    // 贴合相机的 UI 无视觉效果的无效操作）
    this.gizmo?.setUI2DMode(visible);
    if (this.gizmo) this.renderer.orbitControls.enabled = !visible;
    if (!visible) this.uiSystem.resetView();
    // 切换后的视口选不中的对象（布局视图的 3D 残留选中 / 场景视图的 UI 选中）
    // 一并取消选中：隐藏对象仍挂着可拖拽的 Gizmo 会造成「能选中」的错觉
    if (this.selectedId && !isSelectableInViewport(this, this.selectedId)) {
      this.clearSelection();
    }
  }

  /** UI 画布当前是否在编辑视口显示（布局视图 = true） */
  get uiViewVisible(): boolean {
    return this.uiSystem.isVisible();
  }

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
    if (want) {
      this.previewFallbackLogged = false;
      // 预览接管整个视口：画中画立即关闭并上报（预览下渲染暂停，等不到下一帧）
      this.pipNode = null;
      emitPiPState(this, null);
    }
    syncPreviewView(this);
  }

  /**
   * 控制编辑器后台渲染循环：
   * - active=true（场景编辑）→ 恢复 rAF 渲染；
   * - active=false（预览/脚本由中央区域独立面板接管）→ 暂停后台渲染，避免空转。
   */
  setRenderingActive(active: boolean): void {
    this.renderer.setPaused(!active);
    if (!active) {
      // 渲染暂停后不再有帧回调：画中画立即关闭并上报（浮层不能残留）
      this.pipNode = null;
      emitPiPState(this, null);
    }
    // 后台渲染暂停（预览/脚本面板接管）时挂起编辑器音频上下文（进度保留），
    // 避免与网页预览面板的音频叠加；恢复渲染时解除挂起并补起 autoplay
    this.audio.setSuspended(!active);
  }

  // ===================== 场景环境（实现见 skyEnv.ts / fogEnv.ts） =====================

  applySkyFromGraph(): void {
    applySkyFromGraph(this);
  }

  invalidateTexCube(rel: string): void {
    invalidateTexCubeOp(this, rel);
  }

  invalidateSkyMaterial(rel: string): void {
    invalidateSkyMaterialOp(this, rel);
  }

  removeSkyEnvLight(): void {
    removeSkyEnvLightOp(this);
  }

  applyFogFromGraph(): void {
    applyFogFromGraph(this);
  }

  // ===================== 地形绘制（实现见 terrainPaint.ts） =====================

  setTerrainPaintBrush(brush: Partial<TerrainToolBrush>): void {
    this.paintBrush = { ...this.paintBrush, ...brush };
  }

  getTerrainPaintBrush(): TerrainToolBrush {
    return { ...this.paintBrush };
  }

  beginTerrainPaint(): Promise<{ ok: boolean; reason?: string }> {
    return beginTerrainPaintOp(this);
  }

  /** 结束地形绘制（冲刷未落盘笔画 + 恢复轨道相机/点选） */
  endTerrainPaint(): void {
    this.terrainPaint?.end();
  }

  /** 雕刻提交（terrainPaint 模块实现；mount 的控制器回调经此入口） */
  commitTerrainSculpt(): void {
    commitTerrainSculptOp(this);
  }

  invalidateTerrainSplatmap(rel: string): void {
    invalidateTerrainSplatmapOp(this, rel);
  }

  setTerrainPaintCommitHandler(handler: (buffer: SplatBuffer, rel: string) => void): void {
    setTerrainPaintCommitHandlerOp(this, handler);
  }

  invalidateTerrainSplatmapCache(rel: string): void {
    invalidateTerrainSplatmapCacheOp(this, rel);
  }

  // ===================== 视口查询（实现见 viewportQuery.ts） =====================

  screenToWorldPoint(clientX: number, clientY: number): Vec3 | null {
    return screenToWorldPointOp(this, clientX, clientY);
  }

  focusOnNode(id: string): boolean {
    return focusOnNodeOp(this, id);
  }
}
