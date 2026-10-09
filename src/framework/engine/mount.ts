// ---------------------------------------------------------------------------
// 引擎挂载/卸载（生命周期序列）：渲染器挂载 → gizmo 初始化 → 后端材质策略 →
// 渲染回调/活动信号/画中画接线 → 场景事件绑定 → 视口点选/地形绘制/布局导航
// 装配；dispose 反向拆除全部监听与资源。
// ---------------------------------------------------------------------------
import { logger } from "../../platform_abstraction/logger";
import type { EditorEngine } from "./EditorEngine";
import type { RendererBackend } from "./modules/RendererManager";
import { GizmoController } from "./modules/GizmoController";
import { TerrainPaintController } from "./modules/TerrainPaintController";
import { loadParticleNodeMaterialFactory } from "../particles";
import { loadNodeMaterialBackend, setNodeMaterialBackend } from "../material/nodeMaterialBackend";
import { hookMaterialCount, tickAllHookTime } from "../material/shaderHooks";
import { tickAllNodeHookTime } from "../material/nodeMaterialBackend";
import { handleGraphChange, onSelectionChanged, onViewportMouseDown, syncGizmoTransformToNode } from "./events";
import { isUIPositionManaged } from "./viewportQuery";
import { installLayoutNavigation, removeLayoutNavigation } from "./layoutNav";
import { emitPiPState, resolvePiPRequest } from "./pipView";
import { updateOrthoSkyQuad } from "./skyEnv";
import type { JsonRecord } from "../prototype/types";

export async function mountEditorEngine(
  engine: EditorEngine,
  container: HTMLElement,
  options?: {
    renderer?: RendererBackend;
    antialias?: number;
    hdrMode?: "hdr" | "ldr";
  },
): Promise<void> {
  engine.disposed = false;
  await engine.renderer.mount(container, options);
  // 挂载期间（渲染器异步初始化）可能已被 dispose（如用户在就绪前点了“关闭”）：
  // 此时渲染器已释放，直接终止后续初始化，避免在已销毁的引擎上补建 gizmo/监听。
  if (engine.disposed) return;
  initGizmo(engine);
  // WebGPU 后端：粒子改注入 TSL 节点材质工厂（GLSL ShaderMaterial 不参与渲染），
  // 等待工厂就绪后再装载场景
  await applyBackendMaterialPolicy(engine);
  // 着色器编译失败 → 引擎事件（应用层桥接到编辑器控制台）
  engine.renderer.setShaderErrorCb((message) => engine.events.emit("shader:error", { message }));
  // UI 布局视图独占渲染：隐藏画布祖先链与 gizmo 之外的顶层子树，
  // 布局视口只显示 Canvas 下的节点
  engine.uiSystem.attach(engine.renderer.scene, [engine.gizmo.getGizmoHelper()]);
  engine.renderer.setUiSoloCb({
    begin: () => engine.uiSystem.beginSolo(),
    end: () => engine.uiSystem.endSolo(),
  });
  // 画中画（相机节点选中）：主渲染完成后在视口右下角按该相机取景离屏渲染
  engine.renderer.setPiPProvider((viewW, viewH) => resolvePiPRequest(engine, viewW, viewH));
  // 空闲降帧的活动信号：有活动内容（动画播放/粒子发射/物理模拟/导航代理/
  // 逻辑运行/着色器 _Time 钩子）时视口保持全速，静止场景降频省电
  engine.renderer.addActivityHook(() => engine.animation.hasActive());
  engine.renderer.addActivityHook(() => engine.particles.hasActive());
  engine.renderer.addActivityHook(() => engine.physics.isSimulatingActive());
  engine.renderer.addActivityHook(() => engine.nav.hasActiveAgents());
  engine.renderer.addActivityHook(() => engine.logic.hasRunning());
  engine.renderer.addActivityHook(() => hookMaterialCount() > 0);
  engine.events.on("select:changed", () => engine.renderer.markActivity());
  engine.renderer.setRenderCb(() => {
    // 帧间隔（Timer.update 每帧一次；getDelta 取值在本帧内多次调用结果一致）
    engine.timer.update();
    const dt = engine.timer.getDelta();
    // 动画推进（剪辑/骨骼/动画图状态机）与渲染同帧；
    // 物理紧随其后：运动学体跟随动画后的位姿推开动力学体
    engine.animation.update(dt);
    engine.physics.update(dt);
    // 粒子模拟推进（发射/积分/回收并写渲染缓冲）；world 空间粒子按节点世界矩阵回本地
    engine.particles.update(dt);
    // 导航代理推进（沿烘焙路径移动，SDF 查表滑移避障；区域改设置即重烘焙）
    engine.nav.update(dt);
    // 逻辑运行器推进（状态机切换/行为树求值；资产绑定变化即热重建）
    engine.logic.update(dt);
    // 着色器 Hook 时间（_Time 秒；按帧间隔累加，与 clock 多次取值互不干扰）
    // GL 侧走材质 userData 的 uniform 表，GPU 侧走节点 uniform，两条路都要推
    engine.shaderTime += dt;
    tickAllHookTime(engine.shaderTime);
    tickAllNodeHookTime(engine.shaderTime);
    // 音频：监听器随活动渲染相机 + 可见性自动暂停（Web Audio 自走时钟）
    const activeCam = engine.renderer.getActiveCamera();
    if (activeCam) engine.audio.attachListener(activeCam);
    engine.audio.update();
    // 每帧贴合辅助线世界变换（gizmo 拖拽时实时跟随）
    engine.helperSystem.tick(engine.synchronizer.getObjectMap());
    // 阴影相机贴合场景包围盒（按节拍惰性重算，场景增删/移动后投影范围自动跟上）；
    // 视口静止（无交互无活动内容）时跳过周期重贴合——对象不动，范围不会变；
    // 相机待重贴合说明场景内容变化 → 联动阴影图重画一次（静态场景阴影 pass 免除）
    if (engine.synchronizer.shadowDirty) engine.renderer.markShadowDirty();
    engine.synchronizer.refitShadowCameras(false, engine.renderer.viewportActive());
    // UI 相机叠加：画布根贴合活动渲染相机 + 按 SortOrder 合成 Widget 渲染序
    // （renderActive 用的同一活动相机；scene 模式 = 编辑器轨道相机，非 null）
    // gizmo 拖拽中把被拖对象传给布局解析（拖拽子树跳过，避免位置被拉回）
    const renderCam = engine.renderer.getActiveCamera();
    const dragId = engine.gizmo.isDragging() ? engine.selectedId : null;
    const dragObj = dragId ? engine.synchronizer.getObjectMap().get(dragId) ?? null : null;
    if (renderCam) engine.uiSystem.update(renderCam, engine.synchronizer.getObjectMap(), dragObj);
    // 正交预览的天空背景面跟随（渲染前更新 uniforms）
    updateOrthoSkyQuad(engine);
  });
  engine.audio.ensureGestureResume();
  // 编辑器中不自动起播 autoplay（仅手动点击播放；autoplay 数据标记随场景保存，预览/导出产物中生效）
  engine.audio.setAutoplayEnabled(false);
  engine.graph.onChange((c) => handleGraphChange(engine, c));
  engine.events.on("select:changed", () => onSelectionChanged(engine));
  setupViewportClickHandler(engine);
  initTerrainPaint(engine);
  // 布局视图 2D 导航：滚轮缩放（指针锚点）+ 右/中键拖拽平移 + 右键菜单抑制
  installLayoutNavigation(engine);
  // gizmo 拖动期间：捕获阶段拦截其它鼠标按下与键位输入（独占变换操作）
  window.addEventListener("pointerdown", engine.onCapturePointerDown, true);
  window.addEventListener("keydown", engine.onCaptureKeyDown, true);
  logger.info("EditorEngine mounted");
}

export function disposeEditorEngine(engine: EditorEngine): void {
  // 幂等且容错：允许在引擎尚未 mount（或挂载中）时被销毁，不抛错
  if (engine.disposed) return;
  engine.disposed = true;
  engine.pipNode = null;
  emitPiPState(engine, null);
  engine.unbindSceneEvents();
  engine.graph.setTransport(null);
  window.removeEventListener("pointerdown", engine.onCapturePointerDown, true);
  window.removeEventListener("keydown", engine.onCaptureKeyDown, true);
  if (engine.skyApplied) {
    engine.skyApplied.texture.dispose();
    engine.skyApplied = null;
  }
  if (engine.orthoSkyQuad) {
    engine.orthoSkyQuad.geometry.dispose();
    engine.orthoSkyQuad.material.dispose();
    engine.orthoSkyQuad.parent?.remove(engine.orthoSkyQuad);
    engine.orthoSkyQuad = null;
  }
  engine.removeSkyEnvLight();
  engine.textureCache.clear();
  engine.texCubeCache.clear();
  engine.skyMatCache.clear();
  engine.textureUrlResolver = null;
  engine.renderer?.dispose();
  engine.gizmo?.dispose();
  engine.helperSystem?.dispose();
  engine.synchronizer?.dispose();
  engine.animation?.dispose();
  engine.audio?.dispose();
  engine.physics?.dispose();
  engine.particles?.dispose();
  engine.materials?.clear();
  engine.shaders?.clear();
  engine.models?.clear();
  removeViewportClickHandler(engine);
  removeLayoutNavigation(engine);
}

/** 视口点选监听装配（mousedown → 事件模块的 onViewportMouseDown） */
function setupViewportClickHandler(engine: EditorEngine): void {
  const dom = engine.renderer.domElement;
  const handler = (e: MouseEvent) => onViewportMouseDown(engine, e);
  engine._viewportClickHandler = handler;
  dom.addEventListener("mousedown", handler);
}

function removeViewportClickHandler(engine: EditorEngine): void {
  if (!engine._viewportClickHandler) return;
  engine.renderer.domElement.removeEventListener("mousedown", engine._viewportClickHandler);
  engine._viewportClickHandler = null;
}

function initGizmo(engine: EditorEngine): void {
  engine.gizmo = new GizmoController(engine.renderer.camera, engine.renderer.domElement);
  engine.gizmo.setCallbacks({
    onDraggingChanged: (val) => {
      // 布局视图用 2D 设计视图导航（轨道相机禁用），拖拽结束后也不恢复轨道
      engine.renderer.orbitControls.enabled = !val && !engine.uiSystem.isVisible();
      if (val) {
        // UI 锚点托管节点：拖拽起点快照整节点 JSON（提交走 commitPatch 一次撤销）。
        // 注意只能在拖拽开始时捕获/清空——释放时本回调先于 GizmoController.commitDrag
        // 运行，若在此处清空快照，提交会落入 transform-only 路径（后端 setTransform
        // 事件回灌丢失 anchoredPosition → 松手回弹）；清空由 onCommitTransform 消费完成
        engine.uiDragBeforeJSON = null;
        const id = engine.selectedId;
        const node = id ? engine.graph.get(id) : undefined;
        if (node && id && isUIPositionManaged(engine, id)) engine.uiDragBeforeJSON = node.toJSON() as JsonRecord;
      }
    },
    onGizmoObjectChange: () => {
      // 拖动中把 three 对象的当前变换实时回写数据节点并广播，
      // 属性面板的 Transform 数值与视口 gizmo 同步变化（松手才写历史）
      if (engine.gizmo.isDragging()) syncGizmoTransformToNode(engine);
    },
  });
  engine.gizmo.onCommitTransform = (id, after, before) => {
    // UI 锚点托管节点：拖拽改写的是 anchoredPosition 等锚点字段（普通 transform
    // 提交表达不了），按整节点 JSON 补丁提交；其余节点走变换快照提交
    if (isUIPositionManaged(engine, id) && engine.uiDragBeforeJSON) {
      const node = engine.graph.get(id);
      if (node) {
        const beforeJSON = engine.uiDragBeforeJSON;
        engine.uiDragBeforeJSON = null;
        engine.graph.commitPatch(id, beforeJSON, node.toJSON() as JsonRecord, "变换 UI 节点");
        return;
      }
    }
    // 拖动期间镜像已实时生效；此处携带 before/after 一次性提交后端（一个拖动 = 一条历史）
    engine.graph.commitTransform(id, before, after);
  };
  engine.gizmo.attachToScene(engine.renderer.scene);
  // 关键：把 OrbitControls 的监听器摘掉后重新挂到 gizmo 之后——
  // 指针按下时 gizmo 先进入拖拽并（经 dragging-changed）禁用轨道相机，
  // OrbitControls 随后收到同一个按下事件时因 enabled=false 直接忽略，
  // 避免“拖动变换的同时相机也在旋转”。
  {
    const oc = engine.renderer.orbitControls as unknown as {
      disconnect?: () => void;
      connect?: (el: HTMLElement) => void;
    };
    oc.disconnect?.();
    oc.connect?.(engine.renderer.domElement);
  }
}

/**
 * 按渲染后端应用材质策略（挂载后调用一次；后端运行期不可切换）：
 * - 经典 WebGLRenderer：粒子用 GLSL ShaderMaterial，材质 Hook 走 onBeforeCompile 注入（默认路径）；
 * - WebGPURenderer：粒子改注入 TSL 节点材质工厂、材质改注入节点材质后端（three/webgpu +
 *   three/tsl 动态加载，未选 WebGPU 的产物不加载它们）——材质 Hook 同时翻译为 TSL 接到
 *   节点槽位，使同一份 .shader 在两种后端下语义一致。
 */
async function applyBackendMaterialPolicy(engine: EditorEngine): Promise<void> {
  if (engine.renderer.activeBackend !== "webgpu") return;
  const [particleFactory, materialBackend] = await Promise.all([
    loadParticleNodeMaterialFactory(),
    loadNodeMaterialBackend(),
  ]);
  if (engine.disposed) return;
  if (particleFactory) {
    engine.particles.setMaterialFactory(particleFactory);
  } else {
    logger.warn("[particles] WebGPU 后端下未能加载 TSL 粒子材质，粒子将不参与渲染");
  }
  if (materialBackend) {
    setNodeMaterialBackend(materialBackend);
  } else {
    logger.warn(
      "[material] WebGPU 后端下未能加载节点材质后端，着色器 Hook 不参与渲染（材质仍按分支参数渲染）",
    );
  }
}

/** 初始化地形绘制控制器（mount 后调用；落盘经 onCommit 上抛应用层） */
function initTerrainPaint(engine: EditorEngine): void {
  engine.terrainPaint = new TerrainPaintController({
    dom: engine.renderer.domElement,
    scene: engine.renderer.scene,
    orbit: engine.renderer.orbitControls,
    getCamera: () => engine.renderer.camera,
    getBrush: () => engine.paintBrush,
    onCommitSplat: (buffer, rel) => engine.terrainPaintCommitHandler?.(buffer, rel),
    onCommitSculpt: () => engine.commitTerrainSculpt(),
    onStamp: () => {
      const session = engine.terrainPaint?.getSession();
      if (!session || session.kind !== "paint") return;
      engine.synchronizer.previewTerrainSplatmap(session.node, session.buffer);
    },
  });
}
