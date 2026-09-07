<script setup lang="ts">
/**
 * 资产 3D 预览画布（小视口离屏渲染，属检查器 UI 层）：
 * - material：材质球（类型工厂 create+apply 实时应用参数，编辑即时反映）；
 * - model：模型实例（引擎 ModelManager 缓存，自动取景 + 缓慢自转）；
 * - sky：天空盒材质预览（三段色带背景，随颜色实时更新）；
 * - hdr：RGBE 全景背景；texcube：TextureCube 资产背景（等距柱状/六面）。
 * 各模式独立渲染上下文，卸载时释放；引擎共享的几何/贴图对象不 dispose
 * （每个 WebGLRenderer 有独立 GL 上下文，dispose 渲染器即释放本上下文资源）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { materialTypeRegistry, type MaterialParams } from "../../../framework/material";
import {
  buildBandSkyTexture,
  fetchTexCubeDoc,
  loadTexCubeTexture,
  type SkyColorSet,
} from "../../../framework/engine/modules/skyboxTextures";
import { getEditorStore } from "../../stores/editor";
import { assetUrl } from "../../../lib/asset-url";

const props = defineProps<{
  kind: "material" | "model" | "sky" | "hdr" | "texcube";
  rel: string;
  /** material：实时参数（编辑时随 reactive 更新） */
  params?: MaterialParams | null;
  matType?: string;
  /** sky：三段色带颜色 */
  skyColors?: SkyColorSet | null;
}>();

const host = ref<HTMLDivElement | null>(null);

const editorStore = getEditorStore();

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let raf = 0;
let spin: THREE.Object3D | null = null;
/** material 模式当前材质实例（重建参数时 dispose；贴图来自引擎缓存不释放） */
let liveMaterial: THREE.Material | null = null;
let disposed = false;

function ensureRenderer(): void {
  const el = host.value;
  if (!el || renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(el.clientWidth || 220, el.clientHeight || 170);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2a2e);
  camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  // 简单布光：半球环境 + 主平行光，材质球/模型有基础立体感
  const hemi = new THREE.HemisphereLight(0xffffff, 0x606068, 1.1);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 3, 2);
  scene.add(hemi, key);
  syncAspect();
}

function syncAspect(): void {
  const el = host.value;
  if (!el || !renderer || !camera) return;
  const w = el.clientWidth || 220;
  const h = el.clientHeight || 170;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function render(): void {
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function startSpin(): void {
  stopSpin();
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    if (spin) spin.rotation.y += 0.006;
    render();
  };
  tick();
}

function stopSpin(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function clearScene(): void {
  if (!scene) return;
  if (spin) {
    scene.remove(spin);
    spin = null;
  }
  if (liveMaterial) {
    liveMaterial.dispose();
    liveMaterial = null;
  }
  scene.background = new THREE.Color(0x2a2a2e);
}

// —— material：材质球 ——
function buildMaterialPreview(): void {
  const el = host.value;
  if (!el || props.kind !== "material" || !props.params || !scene) return;
  clearScene();
  const def = materialTypeRegistry.getOrDefault(props.matType ?? "physical");
  const mat = def.create();
  def.apply(mat, props.params, {
    loadTexture: (rel, srgb) => editorStore.engine.loadTexture(rel, srgb),
  });
  liveMaterial = mat;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
  scene.add(mesh);
  render();
}

// —— model：模型实例（引擎缓存；就绪后取景 + 自转）——
async function buildModelPreview(): Promise<void> {
  if (props.kind !== "model" || !props.rel || !scene) return;
  const engine = editorStore.engine;
  if (!engine.models.has(props.rel)) await engine.models.preload([props.rel]);
  if (disposed || props.kind !== "model" || !scene) return;
  const inst = engine.models.instantiate(props.rel);
  if (!inst) return;
  clearScene();
  spin = inst;
  scene.add(inst);
  // 取景：包围盒半径定相机距离
  const box = new THREE.Box3().setFromObject(inst);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.001);
  inst.position.sub(center);
  camera!.near = radius / 100;
  camera!.far = radius * 20;
  camera!.position.set(radius * 1.9, radius * 1.3, radius * 2.4);
  camera!.lookAt(0, 0, 0);
  camera!.updateProjectionMatrix();
  startSpin();
}

// —— sky：三段色带背景 ——
function buildSkyPreview(): void {
  if (props.kind !== "sky" || !scene) return;
  clearScene();
  if (props.skyColors) scene.background = buildBandSkyTexture(props.skyColors);
  render();
}

// —— hdr / texcube：全景背景 ——
async function buildPanoramaPreview(): Promise<void> {
  const el = host.value;
  if (!scene || !el) return;
  if (props.kind === "hdr") {
    if (!props.rel) return;
    const tex = await new RGBELoader().loadAsync(assetUrl(props.rel)).catch(() => null);
    if (disposed || props.kind !== "hdr" || !scene) return;
    clearScene();
    if (tex) {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = tex;
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
    clearScene();
    if (res) {
      // 预览画布旋转：等距柱状取正视方向，六面 CubeTexture 直接作背景
      scene.background = res.texture;
    }
    render();
  }
}

function rebuild(): void {
  stopSpin();
  ensureRenderer();
  if (props.kind === "material") buildMaterialPreview();
  else if (props.kind === "model") void buildModelPreview();
  else if (props.kind === "sky") buildSkyPreview();
  else if (props.kind === "hdr" || props.kind === "texcube") void buildPanoramaPreview();
}

onMounted(() => {
  ensureRenderer();
  rebuild();
  window.addEventListener("resize", syncAspect);
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("resize", syncAspect);
  stopSpin();
  if (liveMaterial) {
    liveMaterial.dispose();
    liveMaterial = null;
  }
  renderer?.dispose();
  if (renderer?.domElement.parentElement) {
    renderer.domElement.parentElement.removeChild(renderer.domElement);
  }
  renderer = null;
  scene = null;
  camera = null;
});

watch(() => [props.kind, props.rel], () => rebuild());
// 材质参数/天空颜色实时更新（reactive 镜像被就地修改，深监听捕获）
watch(
  () => [props.params, props.skyColors],
  () => {
    if (props.kind === "material") buildMaterialPreview();
    else if (props.kind === "sky") buildSkyPreview();
  },
  { deep: true },
);
watch(() => props.matType, () => {
  if (props.kind === "material") buildMaterialPreview();
});
</script>

<template>
  <div ref="host" class="asset-preview-3d"></div>
</template>

<style scoped>
.asset-preview-3d {
  height: 170px;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  overflow: hidden;
  background:
    repeating-conic-gradient(#242428 0% 25%, #2e2e33 0% 50%) 0 0 / 16px 16px;
  margin-bottom: 2px;
}
</style>
