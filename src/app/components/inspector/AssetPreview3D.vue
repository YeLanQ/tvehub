<script setup lang="ts">
/**
 * 资产 3D 预览视口（检查器内嵌小视口，可交互）：
 * - 交互：左键旋转 / 滚轮缩放 / 右键平移 / 双击重置（OrbitControls，带阻尼）；
 * - 取景：容器尺寸自适应（ResizeObserver + DPR 钳制，拖分隔条不会失真），
 *   模型按包围盒自动取景，材质球/全景按模式预设机位，重置回到该机位;
 * - 光照：PMREM 程序化室内环境（PBR 的金属度/粗糙度/清漆/透射正确呈现）
 *   + 半球光与主光做柔和补光；材质球与模型都配承影地面（PCF 软阴影，主光投影），
 *   模型另加地面网格，便于判断比例、朝向与接触关系;
 * - 模式：material 材质球（参数/贴图实时应用）、model 模型实例（带动画剪辑播放）、
 *   sky 程序化天空（Nishita 大气散射）、hdr RGBE 全景、texcube 立方体天空盒;
 * - 工具条：重置视角 / 播放暂停（模型带剪辑时）/ 剪辑选择 / 自动旋转 / 光照模式 /
 *   网格（模型）/ 线框（材质·模型）。
 *
 * 每个预览实例独立 WebGL 上下文（与引擎上下文隔离），卸载时全部释放：
 * 渲染器（连同本上下文内的环境贴图与投影纹理）、控制器、动画 mixer、
 * 网格/地面辅助物；仅预览自建的 HDR 纹理由本组件显式 dispose（引擎共享的
 * 几何/贴图对象不释放——它们属于引擎上下文与缓存）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { hookDataOf, materialTypeRegistry, type MaterialParams } from "../../../framework/material";
import {
  fetchTexCubeDoc,
  loadTexCubeTexture,
} from "../../../framework/engine/modules/skyboxTextures";
import { buildNishitaSkyEquirect, type NishitaSkyParams } from "../../../framework/engine/modules/nishitaSky";
import { getEditorStore } from "../../stores/editor";
import { getProjectStore } from "../../stores/project";
import { logStore } from "../../stores/log";
import { assetUrl } from "../../../lib/asset-url";

const props = defineProps<{
  kind: "material" | "model" | "sky" | "hdr" | "texcube";
  rel: string;
  /** material：实时参数（编辑时随 reactive 更新） */
  params?: MaterialParams | null;
  matType?: string;
  /** material：挂载的着色器资产引用（据此取 Hook 片段与 Properties 参数） */
  shaderRel?: string;
  /** sky：Nishita 大气散射参数（程序化材质） */
  nishita?: NishitaSkyParams | null;
  /** 天空背景属性（旋转/强度/模糊；随 sky 材质编辑实时应用） */
  bgRotation?: number;
  bgIntensity?: number;
  bgBlurriness?: number;
}>();

const host = ref<HTMLDivElement | null>(null);
const editorStore = getEditorStore();
const projectStore = getProjectStore();

// —— 视口状态（工具条） ——
/** 自动旋转（模型默认开；带剪辑播放的模型默认关，避免与动画抢姿态） */
const autoRotate = ref(true);
const showGrid = ref(true);
const wireframe = ref(false);
/**
 * 预览光照模式：
 * - env：PMREM 程序化环境 + 半球光 + 主光（默认，PBR 材质观感与编辑器一致）；
 * - light：关环境，仅半球光 + 主光（排除环境反射，看直接光照与投影）；
 * - flat：无光照，材质退化为纯基础色/贴图直出（核对基础色与贴图用）。
 */
const lightMode = ref<"env" | "light" | "flat">("env");
/** 模型动画剪辑（clips>0 时工具条出现剪辑选择） */
const clipNames = ref<string[]>([]);
const clipIndex = ref(0);
const playing = ref(true);

const canWireframe = computed(() => props.kind === "material" || props.kind === "model");
const isModel = computed(() => props.kind === "model");
const hasClips = computed(() => isModel.value && clipNames.value.length > 0);
/** 光照模式只对"有实体"的预览有意义（天空/全景只有背景） */
const canAdjustLight = computed(() => props.kind === "material" || props.kind === "model");

// —— 渲染对象（非响应式，避免 Vue 代理 three 对象） ——
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let envRT: THREE.WebGLRenderTarget | null = null;
let grid: THREE.GridHelper | null = null;
let ground: THREE.Mesh | null = null;
let raf = 0;
let resizeObs: ResizeObserver | null = null;
/** 补光（光照模式切换时显隐；模型模式由主光投影） */
let hemiLight: THREE.HemisphereLight | null = null;
let keyLight: THREE.DirectionalLight | null = null;
/** 预览专用对象（每次重建清空；材质球/模型实例挂在这里，便于按需回收） */
let subject: THREE.Object3D | null = null;
/** material 模式当前材质实例（重建时 dispose；贴图来自引擎缓存不释放） */
let liveMaterial: THREE.Material | null = null;
/** 模型动画（mixer + 全部动作；剪辑选择/播放暂停用） */
let mixer: THREE.AnimationMixer | null = null;
let actions: THREE.AnimationAction[] = [];
/** 预览自建的 HDR 纹理（引擎缓存之外的，卸载时释放） */
let hdrTexture: THREE.Texture | null = null;
/** 机位预设（重置视角回到这里） */
const home = { pos: new THREE.Vector3(0, 0, 3), target: new THREE.Vector3(0, 0, 0) };
let disposed = false;

/** 视口尺寸（容器实测；无尺寸时给兜底值，避免首帧 0×0） */
function viewportSize(): { w: number; h: number } {
  const el = host.value;
  return { w: Math.max(1, el?.clientWidth ?? 240), h: Math.max(1, el?.clientHeight ?? 180) };
}

function ensureRenderer(): void {
  const el = host.value;
  if (!el || renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // 阴影：WebGLRenderer 默认关闭阴影贴图（不打开的话承影地面完全画不出东西），
  // PCF 采样 + 主光 radius 4（柔和档，与场景灯光的 Shadow 类型 Soft 一致）
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2a2e);
  camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  applyHomeView();
  // 与编辑器视口同一色调映射规则（随项目 HDR 模式），保证线性 HDR 呈现在两处一致
  renderer.toneMapping =
    projectStore.hdrMode === "hdr" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  // 程序化室内环境（PMREM）：PBR 材质/模型在没有场景光照时的正确呈现基础
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
  } catch {
    // 环境生成失败（极端驱动环境）时退回纯灯光预览，不影响可用性
  }
  pmrem.dispose();
  // 柔和补光：半球环境限定整体明度，主光提供高光方向（可被光照模式关掉/隐藏）
  hemiLight = new THREE.HemisphereLight(0xffffff, 0x50505a, 1.0);
  keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(2.5, 3, 2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.radius = 4; // 柔和档（Shadow 类型 Soft 同款）
  scene.add(hemiLight, keyLight);
  // 控制器：左键旋转 / 滚轮缩放 / 右键平移；双击回到预设机位
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 0.02;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI * 0.98;
  renderer.domElement.addEventListener("dblclick", applyHomeView);
  syncSize();
  startLoop();
}

/** 回到预设机位（含控制器目标与阻尼残留复位） */
function applyHomeView(): void {
  if (!camera) return;
  if (controls) {
    // 拖动/缩放后 OrbitControls 会留下阻尼残留（sphericalDelta / panOffset），直接落位
    // 会被下一帧的残留推移——先关阻尼跑一帧把残留应用并归零，再精确落位预设机位
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    camera.position.copy(home.pos);
    controls.target.copy(home.target);
    camera.lookAt(home.target);
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = damping;
    return;
  }
  camera.position.copy(home.pos);
  camera.lookAt(home.target);
  camera.updateProjectionMatrix();
}

function setHomeView(pos: THREE.Vector3, target: THREE.Vector3, fov: number): void {
  home.pos.copy(pos);
  home.target.copy(target);
  if (camera) camera.fov = fov;
  applyHomeView();
}

function syncSize(): void {
  if (!renderer || !camera) return;
  const { w, h } = viewportSize();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// —— 渲染循环：常驻（阻尼/自转/动画都需要连续帧）；页面隐藏时浏览器自动降频 ——
function startLoop(): void {
  stopLoop();
  const clock = new THREE.Clock();
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    if (mixer && playing.value) mixer.update(dt);
    if (autoRotate.value && subject && !hasClips.value) subject.rotation.y += dt * 0.6;
    controls?.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  };
  tick();
}

function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function render(): void {
  if (renderer && scene && camera) renderer.render(scene, camera);
}

/** 应用天空背景属性（旋转/强度/模糊；three 的 scene 背景属性） */
function applyBgProps(): void {
  if (!scene) return;
  scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(props.bgRotation ?? 0), 0);
  scene.backgroundIntensity = props.bgIntensity ?? 1;
  scene.backgroundBlurriness = Math.max(0, Math.min(1, props.bgBlurriness ?? 0));
}

// —— 光照模式 ——
/** 「仅基础色」模式下被替换的材质（退出该模式/重建/卸载时还原并释放自建材质） */
interface FlatSwap {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  flat: THREE.Material[];
}
let flatSwaps: FlatSwap[] = [];

/** 受光照影响的材质 → 纯基础色材质（保留基础色/贴图/透明/双面/线框等外观参数）；
 *  无 color 通道的材质（如自定义 ShaderMaterial）原样保留 */
function toFlatMaterial(src: THREE.Material): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
  if (!("color" in m) || !m.color) return src;
  return new THREE.MeshBasicMaterial({
    color: m.color.clone(),
    map: m.map ?? null,
    alphaMap: m.alphaMap ?? null,
    vertexColors: m.vertexColors === true,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: m.alphaTest ?? 0,
    side: src.side,
    wireframe: m.wireframe === true,
  });
}

/** 进入「仅基础色」：把主体材质换成不受光照的纯色/贴图材质 */
function applyFlatMaterials(): void {
  if (!subject || flatSwaps.length > 0) return;
  subject.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const flats = originals.map(toFlatMaterial);
    if (flats.every((f, i) => f === originals[i])) return; // 无可替换项
    flatSwaps.push({
      mesh,
      original: mesh.material,
      flat: flats.filter((f, i) => f !== originals[i]),
    });
    mesh.material = Array.isArray(mesh.material) ? flats : flats[0];
  });
}

/** 退出「仅基础色」：还原原材质并释放自建材质 */
function restoreFlatMaterials(): void {
  for (const s of flatSwaps) {
    s.mesh.material = s.original;
    for (const m of s.flat) m.dispose();
  }
  flatSwaps = [];
}

/** 应用光照模式（环境显隐 / 补光显隐 / 基础色材质切换） */
function applyLightMode(): void {
  if (scene) {
    scene.environment = lightMode.value === "env" ? (envRT?.texture ?? null) : null;
  }
  const lightsOn = lightMode.value !== "flat";
  if (hemiLight) hemiLight.visible = lightsOn;
  if (keyLight) keyLight.visible = lightsOn;
  if (lightMode.value === "flat") applyFlatMaterials();
  else {
    restoreFlatMaterials();
    applyWireframe();
  }
  render();
}

/** 清空预览主体（材质球/模型/网格/地面/动画/自建 HDR 纹理） */
function clearSubject(): void {
  if (!scene) return;
  if (mixer) {
    mixer.stopAllAction();
    const root = mixer.getRoot();
    if (root) mixer.uncacheRoot(root);
    mixer = null;
  }
  actions = [];
  clipNames.value = [];
  // 主体变更前先还原「仅基础色」替换掉的材质（自建材质随之释放）
  restoreFlatMaterials();
  if (subject) {
    scene.remove(subject);
    subject = null;
  }
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    (grid.material as THREE.Material).dispose();
    grid = null;
  }
  if (ground) {
    scene.remove(ground);
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
    ground = null;
  }
  if (liveMaterial) {
    liveMaterial.dispose();
    liveMaterial = null;
  }
  if (hdrTexture) {
    hdrTexture.dispose();
    hdrTexture = null;
  }
  scene.background = new THREE.Color(0x2a2a2e);
  if (keyLight) keyLight.castShadow = false;
}

// —— material：材质球（分支参数 + 着色器 Hook 实时应用，随注册表工厂装配） ——
/** 已尝试过「着色器未解析 → preload → 重建」的着色器引用（每个只补一次）：
 * 若读取失败（文件缺失/损坏），缓存永远建立不起来；无条件重试会变成
 * 「preload → 重建 → preload」的自激空转（主线程卡死）。 */
const shaderRetryTried = new Set<string>();
/** 材质球重建频率闸门（防自激）：1 秒内超过上限即跳过重建并告警一次，
 * 保证即使上游出现事件风暴，编辑器仍可响应，而不是整屏卡死。 */
const REBUILD_LIMIT_PER_SEC = 30;
let rebuildWindowStart = 0;
let rebuildCount = 0;

function buildMaterialPreview(): void {
  if (props.kind !== "material" || !props.params || !scene) return;
  // 重建频率闸门：超限说明上游在自激（参数/事件风暴），跳过本轮并告警
  const now = performance.now();
  if (now - rebuildWindowStart > 1000) {
    rebuildWindowStart = now;
    rebuildCount = 0;
  }
  if (++rebuildCount > REBUILD_LIMIT_PER_SEC) {
    if (rebuildCount === REBUILD_LIMIT_PER_SEC + 1) {
      logStore.log(
        "warn",
        `材质预览重建过于频繁（>${REBUILD_LIMIT_PER_SEC}/秒），已暂停本轮重建以免界面卡死：${props.rel}`,
        "engine",
      );
    }
    return;
  }
  // 着色器文档（Base 决定分支、Hook 是效果片段）：钩子数据必须随上下文一起交给
  // 类型定义，否则预览看不到叠加效果；首次未解析时补取一次，取到后重建
  const shaderRel = props.shaderRel ?? "";
  if (shaderRel && !editorStore.engine.shaders.has(shaderRel) && !shaderRetryTried.has(shaderRel)) {
    shaderRetryTried.add(shaderRel);
    void editorStore.engine.shaders.preload([shaderRel]).then(() => {
      if (!disposed && props.kind === "material") buildMaterialPreview();
    });
  }
  clearSubject();
  const def = materialTypeRegistry.getOrDefault(props.matType ?? "physical");
  const mat = def.create();
  def.apply(
    mat,
    props.params,
    { loadTexture: (rel, srgb) => editorStore.engine.loadTexture(rel, srgb) },
    {
      hooks: shaderRel ? hookDataOf(editorStore.engine.shaders.docFor(shaderRel)) : null,
      props: props.params.props,
    },
  );
  liveMaterial = mat;
  applyWireframe();
  subject = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), mat);
  // three 的网格默认不投影也不受影：材质球同样要显式置位，否则承影地面收不到任何影子
  subject.castShadow = true;
  subject.receiveShadow = true;
  scene.add(subject);
  // 承影地面：材质球也让"投影"看得见（仅灯光模式下能看到球与地面的接触阴影）
  setupGroundAndShadow(1, -1);
  // 机位略微拉开并下俯：给球下方的承影面留出余量（否则阴影落在画面外看不见）
  setHomeView(new THREE.Vector3(0, 1.0, 4.4), new THREE.Vector3(0, -0.15, 0), 38);
  applyLightMode();
}

/** 线框开关（材质球/模型：递归应用，模型内嵌材质也一并切换） */
function applyWireframe(): void {
  if (!canWireframe.value) return;
  const on = wireframe.value;
  subject?.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if ("wireframe" in mat) (mat as THREE.MeshStandardMaterial).wireframe = on;
    }
  });
}

/**
 * 模型包围盒（蒙皮感知，世界矩阵先更新到位）：
 * - **必须先 updateMatrixWorld(true)**：刚克隆出来的蒙皮模型若矩阵未更新，three 的
 *   `Box3.setFromObject` 会把 Armature 的缩放重复计入（Mixamo 导出的 0.01 缩放会被算两次），
 *   得到的包围盒小两个数量级 —— 取景距离随之离谱地近，表现为「模型特别大、相机在模型里」；
 * - 蒙皮网格按**骨骼当前姿态**取顶点包围盒（SkinnedMesh.computeBoundingBox 已应用骨骼变换），
 *   普通网格用 geometry.boundingBox × matrixWorld。
 */
function measureBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      skinned.computeBoundingBox();
      if (skinned.boundingBox) {
        tmp.copy(skinned.boundingBox).applyMatrix4(skinned.matrixWorld);
        box.union(tmp);
      }
      return;
    }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) {
      tmp.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      box.union(tmp);
    }
  });
  return box;
}

// —— model：模型实例（引擎缓存克隆；包围盒取景 + 地面网格/投影 + 剪辑播放） ——
async function buildModelPreview(): Promise<void> {
  if (props.kind !== "model" || !props.rel || !scene) return;
  const engine = editorStore.engine;
  if (!engine.models.has(props.rel)) await engine.models.preload([props.rel]);
  if (disposed || props.kind !== "model" || !scene) return;
  const inst = engine.models.instantiate(props.rel);
  if (!inst) return;
  clearSubject();
  subject = inst;
  scene.add(inst);

  // 动画：模型自带剪辑时先建动作，取景依据取**整段剪辑**采样包围盒的并集
  // （不并入绑定姿态：Mixamo 之类绑定姿态常是张开的 T 型，动画里并不出现，
  //   计入会让取景明显偏远、人物偏小）
  const clips = engine.models.animationsFor(props.rel);
  clipNames.value = clips.map((c) => c.name || "Clip");
  let box: THREE.Box3;
  if (clips.length > 0) {
    mixer = new THREE.AnimationMixer(inst);
    actions = clips.map((c) => mixer!.clipAction(c));
    // 先让动作生效（未 play 的动作不驱动姿态，mixer.setTime 也采样不到动画姿态）
    actions[0]?.reset().play();
    const dur = Math.max(clips[0].duration, 0);
    // 沿剪辑均匀采样（12 段）：取并集保证整段动画都在取景内
    const samples = 12;
    mixer.setTime(0);
    box = measureBounds(inst);
    for (let i = 1; i <= samples; i++) {
      mixer.setTime((dur * i) / samples);
      box.union(measureBounds(inst));
    }
    autoRotate.value = false;
    playClip(0);
  } else {
    box = measureBounds(inst);
  }

  // 取景：用（并集）包围盒居中 + 半径定机位（比例与朝向由地面网格辅助判断）
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.001);
  inst.position.sub(center);
  if (camera) {
    camera.near = Math.max(radius / 200, 0.001);
    camera.far = radius * 40;
  }
  // 推拉范围按取景半径相对化：模型可能以厘米/毫米为单位（包围半径成百上千），
  // 写死的距离上限会把相机夹到模型内部（看起来「模型特别大」）
  if (controls) {
    controls.minDistance = Math.max(radius * 0.05, 0.001);
    controls.maxDistance = radius * 12;
  }
  // 地面网格 + 投影承接面（仅模型模式：判断比例/朝向/接触关系）
  grid = new THREE.GridHelper(radius * 6, 24, 0x4a4a52, 0x33333a);
  grid.position.y = -size.y / 2;
  scene.add(grid);
  setupGroundAndShadow(radius, -size.y / 2);
  applyWireframe();
  applyLightMode();
  // 取景留一点余量（球包围所需距离 ≈ 2.9r，fov 38 时）
  setHomeView(
    new THREE.Vector3(radius * 1.7, radius * 1.2, radius * 2.1),
    new THREE.Vector3(0, 0, 0),
    38,
  );
}

/**
 * 承影地面 + 主光阴影范围（材质球与模型共用，尺寸按取景半径相对化）：
 * - 地面用 ShadowMaterial：除被遮挡处画阴影外全透明，只做"接影"，不挡住主体；
 * - 主光阴影相机按半径定正交范围与远近平面，法线偏移按阴影贴图纹素相对化
 *   （半径大的模型纹素粗，固定偏移会变成麻点/飘影）。
 */
function setupGroundAndShadow(radius: number, floorY: number): void {
  if (!scene) return;
  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 12, radius * 12),
    new THREE.ShadowMaterial({ opacity: 0.28 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floorY + radius * 0.0005;
  ground.receiveShadow = true;
  scene.add(ground);
  if (!keyLight) return;
  const d = radius * 3;
  keyLight.position.set(d, d * 1.4, d);
  keyLight.castShadow = true;
  const cam = keyLight.shadow.camera;
  cam.near = radius / 10;
  cam.far = d * 6;
  cam.left = -radius * 2;
  cam.right = radius * 2;
  cam.top = radius * 2;
  cam.bottom = -radius * 2;
  cam.updateProjectionMatrix();
  const mapSize = keyLight.shadow.mapSize.width || 1024;
  keyLight.shadow.normalBias = Math.max(((radius * 4) / mapSize) * 1.2, 0.0005);
}

/** 播放指定剪辑（其余停止；循环播放，时间归零） */
function playClip(index: number): void {
  if (actions.length === 0) return;
  clipIndex.value = Math.max(0, Math.min(actions.length - 1, index));
  actions.forEach((a, i) => {
    if (i === clipIndex.value) {
      a.paused = false;
      a.reset().play();
    } else {
      a.stop();
    }
  });
  playing.value = true;
}

/** 播放/暂停切换（three 的 AnimationAction 用 paused 属性，无 pause() 方法） */
function togglePlay(): void {
  if (actions.length === 0) return;
  playing.value = !playing.value;
  for (const a of actions) a.paused = !playing.value;
}

// —— sky：程序化背景（Nishita 大气散射） ——
function buildSkyPreview(): void {
  if (props.kind !== "sky" || !scene) return;
  clearSubject();
  if (props.nishita && renderer) {
    // 预览自身的渲染器：RT 纹理必须生成本上下文内才能显示
    scene.background = buildNishitaSkyEquirect(renderer, props.nishita);
  }
  applyBgProps();
  // 地平线取景（微仰视）：同框呈现 天顶蓝/地平线辉光/地平线下暗部，与编辑器视口构图一致
  setHomeView(new THREE.Vector3(0, 0.25, 3), new THREE.Vector3(0, 0.28, 0), 55);
  render();
}

// —— hdr / texcube：全景背景（环绕即改变观察方向） ——
async function buildPanoramaPreview(): Promise<void> {
  if (!scene) return;
  if (props.kind === "hdr") {
    if (!props.rel) return;
    const tex = await new RGBELoader().loadAsync(assetUrl(props.rel)).catch(() => null);
    if (disposed || props.kind !== "hdr" || !scene) {
      tex?.dispose();
      return;
    }
    clearSubject();
    if (tex) {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      hdrTexture = tex;
      scene.background = tex;
    }
    // 全景：机位贴近原点，环绕即改变朝向；限制推拉幅度避免脱离环境
    setHomeView(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 60);
    if (controls) {
      controls.minDistance = 0.2;
      controls.maxDistance = 4;
    }
    render();
    return;
  }
  if (props.kind === "texcube") {
    if (!props.rel) return;
    const doc = await fetchTexCubeDoc(assetUrl(props.rel));
    if (disposed || props.kind !== "texcube" || !scene) return;
    const res = doc ? await loadTexCubeTexture(doc, (rel) => assetUrl(rel)) : null;
    if (disposed || props.kind !== "texcube" || !scene) return;
    clearSubject();
    if (res) scene.background = res.texture;
    applyBgProps();
    setHomeView(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 60);
    if (controls) {
      controls.minDistance = 0.2;
      controls.maxDistance = 4;
    }
    render();
  }
}

function rebuild(): void {
  ensureRenderer();
  // 换资产/换模式：允许对新引用的着色器再补取一次
  shaderRetryTried.clear();
  // 相机 FOV / 距离限制：各模式会改，重建时先复位预设，避免残留到其它模式
  if (camera) camera.fov = 38;
  if (controls) {
    controls.minDistance = 0.02;
    controls.maxDistance = 60;
  }
  wireframe.value = false;
  if (props.kind === "material") buildMaterialPreview();
  else if (props.kind === "model") void buildModelPreview();
  else if (props.kind === "sky") buildSkyPreview();
  else if (props.kind === "hdr" || props.kind === "texcube") void buildPanoramaPreview();
}

onMounted(() => {
  ensureRenderer();
  rebuild();
  if (host.value && typeof ResizeObserver !== "undefined") {
    resizeObs = new ResizeObserver(() => {
      syncSize();
      render();
    });
    resizeObs.observe(host.value);
  } else {
    window.addEventListener("resize", syncSize);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  stopLoop();
  resizeObs?.disconnect();
  resizeObs = null;
  window.removeEventListener("resize", syncSize);
  clearSubject();
  controls?.dispose();
  controls = null;
  envRT?.dispose();
  envRT = null;
  if (renderer) {
    renderer.domElement.removeEventListener("dblclick", applyHomeView);
    renderer.dispose();
    renderer.domElement.parentElement?.removeChild(renderer.domElement);
  }
  renderer = null;
  scene = null;
  camera = null;
});

watch(() => [props.kind, props.rel], () => rebuild());
// 材质参数/天空参数实时更新（reactive 镜像被就地修改，深监听捕获）
watch(
  () => [props.params, props.nishita],
  () => {
    if (props.kind === "material") buildMaterialPreview();
    else if (props.kind === "sky") buildSkyPreview();
  },
  { deep: true },
);
// 材质球外观的**全部输入**都列在这里：渲染分支（matType）与挂载的着色器（shaderRel，
// 决定 Hook 注入）任一变化都必须重建——漏掉一路会让预览停在旧材质上
// （典型：PBR → 另一个 PBR 效果着色器、或从效果着色器切回普通 PBR，分支不变但效果变了）。
watch(
  () => [props.matType, props.shaderRel],
  () => {
    if (props.kind === "material") buildMaterialPreview();
  },
);
// 天空背景属性（旋转/强度/模糊）：无需重建，应用后重渲染即可
watch(
  () => [props.bgRotation, props.bgIntensity, props.bgBlurriness],
  () => {
    applyBgProps();
    render();
  },
);
watch(wireframe, () => {
  applyWireframe();
  render();
});
// 光照模式：环境/补光显隐 + （仅基础色时）材质切换
watch(lightMode, () => applyLightMode());
watch(showGrid, (v) => {
  if (grid) grid.visible = v;
  render();
});
watch(clipIndex, (v) => {
  if (actions.length > 0) playClip(v);
});
watch(playing, (v) => {
  for (const a of actions) a.paused = !v;
});
// 显隐状态在重建后失效：网格可见性随工具条状态恢复
watch(
  () => grid,
  (g) => {
    if (g) g.visible = showGrid.value;
  },
  { flush: "post" },
);
</script>

<template>
  <div class="asset-preview">
    <div ref="host" class="asset-preview-canvas" :class="{ 'no-grid': isModel && !showGrid }"></div>
    <div class="asset-preview-bar">
      <button title="重置视角（也可双击画布）" @click="applyHomeView">⟲ 重置</button>
      <template v-if="hasClips">
        <button :title="playing ? '暂停动画' : '播放动画'" @click="togglePlay">
          {{ playing ? "⏸ 暂停" : "▶ 播放" }}
        </button>
        <select
          v-if="clipNames.length > 1"
          :value="clipIndex"
          title="选择播放的动画剪辑"
          @change="clipIndex = Number(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="(name, i) in clipNames" :key="i" :value="i">{{ name }}</option>
        </select>
      </template>
      <button
        :class="{ on: autoRotate }"
        :disabled="hasClips"
        :title="hasClips ? '带动画的模型不自动旋转' : '自动旋转'"
        @click="autoRotate = !autoRotate"
      >
        ↻ 自转
      </button>
      <select
        v-if="canAdjustLight"
        v-model="lightMode"
        title="预览光照：环境+灯光（默认）/ 仅灯光（关环境反射）/ 仅基础色（无光照，看纯色与贴图）"
      >
        <option value="env">环境+灯光</option>
        <option value="light">仅灯光</option>
        <option value="flat">仅基础色</option>
      </select>
      <button v-if="isModel" :class="{ on: showGrid }" title="地面网格" @click="showGrid = !showGrid">
        ▦ 网格
      </button>
      <button v-if="canWireframe" :class="{ on: wireframe }" title="线框" @click="wireframe = !wireframe">
        ◫ 线框
      </button>
    </div>
    <div class="asset-preview-hint">左键旋转 · 滚轮缩放 · 右键平移 · 双击重置</div>
  </div>
</template>

<style scoped>
.asset-preview {
  position: relative;
  margin-bottom: 2px;
}

.asset-preview-canvas {
  /* 视口尺寸随面板宽度自适应（检查器窄栏也能用），高度夹在 180~320px */
  aspect-ratio: 4 / 3;
  max-height: 320px;
  min-height: 180px;
  width: 100%;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  overflow: hidden;
  background: #202024;
  /* 拖动分隔条/窗口缩放时不选中文本、不触发父级拖拽 */
  user-select: none;
  touch-action: none;
  cursor: grab;
}

.asset-preview-canvas:active {
  cursor: grabbing;
}

.asset-preview-bar {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  max-width: calc(100% - 12px);
}

.asset-preview-bar button,
.asset-preview-bar select {
  font-size: 10px;
  line-height: 1.2;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(20, 20, 22, 0.72);
  color: var(--text-dim, #bbb);
  cursor: pointer;
}

.asset-preview-bar button:hover:not(:disabled),
.asset-preview-bar select:hover {
  color: var(--text, #eee);
  border-color: rgba(255, 255, 255, 0.32);
}

.asset-preview-bar button:disabled {
  opacity: 0.45;
  cursor: default;
}

.asset-preview-bar button.on {
  color: var(--accent, #4a9eff);
  border-color: var(--accent, #4a9eff);
}

.asset-preview-bar select {
  max-width: 110px;
}

.asset-preview-hint {
  margin-top: 3px;
  font-size: 10px;
  color: var(--text-dim, #888);
}
</style>
