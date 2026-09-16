// 网页预览运行时（独立于编辑器）：加载由编辑器导出的 scene.json / config.json，
// 用 three 把场景内容原样回放（网格/灯光/相机），作为“网页预览视图”。
// 与编辑器预览渲染的差异：无网格/辅助线/gizmo，运行在独立 iframe 页面里。
// 实现拆分在 ../engine/core（three 运行时 + 基础设施 + 脚本系统）与
// ../engine/runtime（场景回放系统），此处只做装配。
import * as THREE from "../engine/core/three.module.min.js";
import { fail, postLog, setLogForwarding } from "../engine/core/log.mjs";
import { matColor, mixHexColor } from "../engine/core/utils.mjs";
import {
  SKY_DEFAULTS,
  findSkyNode,
  loadSkyMatParams,
  loadSkyTexCube,
  makeNishitaSkyEquirect,
  makeSkyBandTexture,
  makeSkyEquirectTexture,
} from "../engine/runtime/sky.mjs";
import { loadMaterialParams } from "../engine/runtime/material.mjs";
import { loadModels } from "../engine/runtime/model.mjs";
import { createAnimationsWorker as createAnimations } from "../engine/runtime/animation.mjs";
import { createAudios } from "../engine/runtime/audio.mjs";
import { createParticles } from "../engine/runtime/particles.mjs";
import { createTerrains, applyTerrainSplatmaps } from "../engine/runtime/terrain.mjs";
import { findFogNode, applyFogFromNode } from "../engine/runtime/fog.mjs";
import { ensureHeightFogChunk } from "../engine/runtime/heightFog.mjs";
import { createPhysicsWorker as createPhysics } from "../engine/runtime/physics.mjs";
import { buildSceneTree } from "../engine/runtime/nodes.mjs";
import { optimizeScene } from "../engine/runtime/batching.mjs";
import { createClipAnimations } from "../engine/runtime/animclip.mjs";
import { createUI } from "../engine/runtime/ui.mjs";
import { createLogic } from "../engine/runtime/logic.mjs";
import { createScripts } from "../engine/core/scripts.mjs";
import { applyMeshTextures, loadImageTex } from "../engine/runtime/textures.mjs";
import { tickShaderTime, setNodeMaterialBackend } from "../engine/runtime/mesh.mjs";
import { createRenderCamera } from "../engine/runtime/camera.mjs";
import { createRenderer, createStage, recreateWebGLRendererPreserveBuffer } from "../engine/runtime/stage.mjs";
import { configureSkyOrientation } from "../engine/runtime/sky.mjs";
import { layerPassBits, renderLayerPasses } from "../engine/runtime/layerpass.mjs";
import { base64ToBytes, gunzip, installAssetShim, parseArchive } from "../engine/runtime/pak.mjs";
import { resourceLoader } from "../engine/runtime/resource.mjs";
import { AssetBundle } from "../engine/runtime/asset-bundle.mjs";

const app = document.getElementById("app");

/** 法线偏移自动档（单位为阴影贴图纹素；与编辑器 SceneSynchronizer 同一取值） */
const SHADOW_NORMAL_BIAS_TEXELS = 1.2;

/**
 * 阴影相机贴合场景包围盒（启动时一次；three 只在首次渲染前按 mapSize 分配阴影贴图）。
 * 只处理开了投射阴影的灯光（点光/平行光/聚光灯，各灯自带阴影参数组）：
 * - 平行光：正交范围铺到能容下整场景（相机沿视轴后推保证场景在前方），near 合成用户近裁剪面；
 * - 聚光灯：远平面推够远，near = 用户近裁剪面；
 * - 点光：远平面取「灯到场景最远角落」（distance>0 时光照在该距离截止）；
 * 法线偏移在用户未设（≤0）时按阴影范围的纹素尺寸自动给，避免麻点/飘影。
 */
function configureShadows(scene) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmpBox = new THREE.Box3();
  scene.traverse((o) => {
    if (o.isMesh !== true || !o.geometry) return;
    const pos = typeof o.geometry.getAttribute === "function" ? o.geometry.getAttribute("position") : null;
    if (!pos || pos.count === 0) return; // 空几何容器（模型容器等）
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (!o.geometry.boundingBox) return;
    tmpBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(tmpBox);
  });
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.05);
  scene.traverse((o) => {
    if (o.isLight !== true || o.castShadow !== true) return;
    const isDir = o.isDirectionalLight === true;
    const isSpot = o.isSpotLight === true;
    const isPoint = o.isPointLight === true;
    if (!isDir && !isSpot && !isPoint) return;
    // 灯光建出时已按节点/组件参数置位 mapSize/浓度/偏移/近裁剪面（nodes.mjs /
    // lights.mjs 的 applyLightShadow），这里只做范围贴合与自动法线偏移
    const cfg = o.userData && typeof o.userData.shadowCfg === "object" ? o.userData.shadowCfg : {};
    const userNear = typeof cfg.near === "number" && cfg.near > 0 ? cfg.near : 0.1;
    const mapSize = o.shadow.mapSize.width || 2048;
    let autoBiasExtent;
    if (isPoint) {
      // 点光：立方体相机挂在灯位置；远平面 = 灯到场景最远角落（distance 截止取小）
      const origin = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const corner = new THREE.Vector3();
      let farthest = 1;
      for (const c of [
        [box.min.x, box.min.y, box.min.z],
        [box.max.x, box.min.y, box.min.z],
        [box.min.x, box.max.y, box.min.z],
        [box.max.x, box.max.y, box.min.z],
        [box.min.x, box.min.y, box.max.z],
        [box.max.x, box.min.y, box.max.z],
        [box.min.x, box.max.y, box.max.z],
        [box.max.x, box.max.y, box.max.z],
      ]) {
        const d = corner.set(c[0], c[1], c[2]).distanceTo(origin);
        if (d > farthest) farthest = d;
      }
      const far = o.distance > 0 ? Math.min(o.distance, farthest) : farthest;
      o.shadow.camera.near = userNear;
      o.shadow.camera.far = far;
      o.shadow.camera.updateProjectionMatrix();
      autoBiasExtent = far; // 90° 面在深度 d 处的世界宽度 ≈ 2d
    } else {
      const origin = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const target = new THREE.Vector3().setFromMatrixPosition(o.target.matrixWorld);
      const axis = target.sub(origin);
      if (axis.lengthSq() < 1e-8) axis.set(0, -1, 0);
      axis.normalize();
      const toCenter = center.clone().sub(origin);
      const along = toCenter.dot(axis);
      const reach = radius + Math.sqrt(Math.max(toCenter.lengthSq() - along * along, 0));
      if (isSpot) {
        const fitFar = Math.max(along + reach, 1);
        o.shadow.camera.near = userNear;
        o.shadow.camera.far = o.distance > 0 ? Math.min(o.distance, fitFar) : fitFar;
        o.shadow.camera.updateProjectionMatrix();
        autoBiasExtent = 2 * Math.tan(Math.max(o.angle, 0.01)) * o.shadow.camera.far;
      } else {
        // 平行光：把阴影相机沿视轴后推，保证整个场景都在相机前方
        // （定向光位置只影响阴影相机，着色只用方向，后推安全；增量补缺口，幂等）
        const deficit = reach + 0.05 - along;
        if (deficit > 1e-4) {
          o.position.z += deficit;
          o.updateWorldMatrix(true, false);
        }
        const alongFinal = deficit > 1e-4 ? reach + 0.05 : along;
        const cam = o.shadow.camera;
        cam.near = Math.max(alongFinal - reach + userNear, 0.01);
        cam.far = Math.max(alongFinal + reach, cam.near + 0.1);
        cam.left = -reach;
        cam.right = reach;
        cam.top = reach;
        cam.bottom = -reach;
        cam.updateProjectionMatrix();
        autoBiasExtent = reach * 2;
      }
    }
    if (!(typeof cfg.normalBias === "number" && cfg.normalBias > 0)) {
      o.shadow.normalBias = Math.min(
        Math.max(((autoBiasExtent / mapSize) * SHADOW_NORMAL_BIAS_TEXELS), 0.0005),
        Math.max(radius * 0.1, 0.001),
      );
    }
  });
}

async function main() {
  // 构建产物可把 config/场景/资产内联进 index.html（window.__TVE_BUILD_DATA，
  // 单页模式），否则按文件读取（多文件产物与编辑器内嵌预览一致）
  const inline = window.__TVE_BUILD_DATA ?? null;

  // 项目配置（渲染合成/抗锯齿；缺省按编辑器 LDR 默认）
  let cfg = {};
  if (inline && inline.config) {
    cfg = inline.config;
  } else {
    try {
      cfg = await resourceLoader.loadJSON("./config.json");
    } catch {
      /* 无配置也允许预览 */
    }
  }

  // 发布构建（debug=false）关闭日志转发（编辑器内嵌预览默认转发）
  if (cfg.debug === false) setLogForwarding(false);

  // 渲染后端（项目设置 renderer）在建场景树之前确定：粒子在场景树构建时即创建
  // 发射器，其材质实现是后端相关的（GLSL / TSL 节点材质）。渲染器挂载到舞台
  // 推迟到相机就绪之后（createStage）。
  // renderer 可能因清除标志需要跨帧保留缓冲而重建（见 createRenderCamera 之后）
  const { renderer: initialRenderer, backend } = await createRenderer(cfg);
  let renderer = initialRenderer;
  // 立方体贴图采样约定按后端不同（GL vs D3D）：天空纹理翻转策略随之后定（见 sky.mjs）
  configureSkyOrientation(backend);
  if (backend === "webgpu") {
    postLog("info", "渲染后端: WebGPU（不可用时自动回退 WebGL2）");
  }
  // 粒子材质工厂：WebGPU 用 TSL 节点材质（GLSL ShaderMaterial 在该后端不参与渲染），
  // 该模块静态依赖 three 的 WebGPU 构建，故仅在 WebGPU 后端下动态引入
  let particleMaterialFactory;
  if (backend === "webgpu") {
    try {
      const mod = await import("../engine/core/particleNodeMaterial.mjs");
      particleMaterialFactory = mod.createNodeParticleMaterialFactory() ?? undefined;
      if (!particleMaterialFactory) postLog("warn", "粒子 TSL 材质不可用，粒子将不参与渲染");
    } catch (e) {
      postLog("warn", `粒子 TSL 材质加载失败（${e?.message ?? e}），粒子将不参与渲染`);
    }
    // 材质：改用节点材质 + 把 Hook 翻译为 TSL 接节点槽位（与编辑器同一策略，
    // 使同一份 .shader 在 WebGL 与 WebGPU 下语义一致）；模块静态依赖 WebGPU 构建，
    // 故仅在 WebGPU 后端下动态引入
    try {
      const mod = await import("../engine/core/nodeMaterialHooks.mjs");
      const backend = mod.createNodeMaterialBackend();
      if (backend) setNodeMaterialBackend(backend);
      else postLog("warn", "节点材质后端不可用，着色器 Hook 不参与渲染（材质仍按分支参数渲染）");
    } catch (e) {
      postLog("warn", `节点材质后端加载失败（${e?.message ?? e}），着色器 Hook 不参与渲染`);
    }
  }

  // 资产来源优先级：内联 gzip 包（单页+gzip）→ 内联资产表（单页）→
  // assets.gzip 归档（多文件+gzip）→ 磁盘文件（多文件/编辑器预览）。
  // AssetBundle 设置到 resourceLoader 供各模块统一加载；
  // installAssetShim 保留供 GLTFLoader 等内部 fetch 兼容。
  let bundle = null;
  if (inline && inline.pak) {
    bundle = await AssetBundle.fromBase64Gzip(inline.pak);
  } else if (inline && inline.assets) {
    bundle = AssetBundle.fromBase64Map(inline.assets);
  } else if (!inline) {
    try {
      // gzip 资源地址（config.gzipBase，与 Three CDN 模式无关）非空时归档从远端
      // 拉取，产物内仍生成 assets.gzip 供上传；空 = 按本地相对路径读取。
      // 地址已以 /assets.gzip 结尾时直接使用，避免重复拼接
      const pakBase =
        typeof cfg.gzipBase === "string" ? cfg.gzipBase.trim().replace(/\/+$/, "") : "";
      const pakUrl = pakBase.endsWith("/assets.gzip") ? pakBase : pakBase + "/assets.gzip";
      bundle = await AssetBundle.loadGzip(pakUrl || "./assets.gzip");
    } catch {
      /* 无归档则按文件读取 */
    }
  }
  if (bundle) {
    resourceLoader.setBundle(bundle);
    installAssetShim(bundle.entries);
  }

  // 场景文件：编辑器内嵌预览固定 ./scene.json；构建产物按 config.scenes 列表
  // 选择（?scene=<场景名> 查询参数 > cfg.mainScene > 首个场景）
  const sceneUrl = (() => {
    if (!Array.isArray(cfg.scenes) || cfg.scenes.length === 0) return "./scene.json";
    const wanted = new URLSearchParams(location.search).get("scene") || cfg.mainScene;
    const pick = cfg.scenes.find((s) => s && s.name === wanted) || cfg.scenes[0];
    return "./" + String(pick.file || "scene.json");
  })();
  const sceneData = await resourceLoader.loadJSON(sceneUrl);

  const rootJson = sceneData && sceneData.root;
  if (!rootJson) throw new Error("scene.json 缺少 root");

  // 高度雾 fog chunk patch：必须先于任何材质 program 编译（buildSceneTree /
  // renderer.compile 预热之前；幂等，与编辑器 ensureHeightFogChunk 同一算法）
  ensureHeightFogChunk();

  const renderSettings = sceneData.settings && sceneData.settings.rendering;
  const bgColor =
    typeof renderSettings?.backgroundColor === "number"
      ? renderSettings.backgroundColor & 0xffffff
      : 0x141414;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bgColor);

  // 场景环境光（settings.rendering.ambientIntensity/ambientColor）：与背景色同属
  // 场景渲染设置（场景文档必带，缺省 0.3 白）。无灯光/天空的场景靠它保底照明，
  // 否则材质全黑叠黑背景，预览/导出画面一片漆黑（编辑器视口有网格/线框参照）。
  // intensity 缺失或 ≤0 时不注入（旧行为）。
  const ambientIntensity = Number(renderSettings?.ambientIntensity);
  if (Number.isFinite(ambientIntensity) && ambientIntensity > 0) {
    const ambientColor =
      typeof renderSettings?.ambientColor === "number"
        ? renderSettings.ambientColor & 0xffffff
        : 0xffffff;
    const ambient = new THREE.AmbientLight(ambientColor, ambientIntensity);
    // 引擎注入的照明覆盖全部渲染层（three 新建灯光默认只算层 0）
    ambient.layers.enableAll();
    scene.add(ambient);
  }

  // 资产预取：材质参数表（.mat）+ 模型（glb/gltf/fbx/obj，已随导出拷贝到同相对路径）
  const [materialParams, models] = await Promise.all([
    loadMaterialParams(rootJson),
    loadModels(rootJson),
  ]);
  const { cameras, meshes, audios, clips, particles, terrains, nodes } = buildSceneTree(rootJson, scene, {
    materialParams,
    models,
    particleMaterial: particleMaterialFactory,
  });

  // 批处理优化：InstancedMesh + 静态几何合并（减少 DrawCall）
  const perfSettings = sceneData.settings && sceneData.settings.performance;
  optimizeScene(scene, meshes, clips, {
    instancing: perfSettings ? perfSettings.instancing !== false : true,
    batching: perfSettings ? perfSettings.batching !== false : true,
  });

  // 物理 Worker URL：多文件模式下用 import.meta.url 解析 Worker 路径，物理模拟
  // 在独立线程运行；单页模式（inline）下 import.meta.url 为 blob URL 无法解析，
  // 不传 workerUrl → createPhysicsWorker 回退主线程
  let physicsWorkerUrl;
  if (!inline) {
    try {
      physicsWorkerUrl = new URL("../engine/runtime/physics-worker.mjs", import.meta.url).href;
    } catch {
      // file:// 等协议下 import.meta.url 可能无法解析相对路径，回退主线程
    }
  }

  // 动画 Worker URL：同物理 Worker 模式，骨骼动画 + IK 在独立线程运行
  let animationWorkerUrl;
  if (!inline) {
    try {
      animationWorkerUrl = new URL("../engine/runtime/animation-worker.mjs", import.meta.url).href;
    } catch {
      // 同上回退主线程
    }
  }

  // 物理引擎提前启动：WASM 编译（2-3MB）耗时长，与后续天空盒/贴图/渲染预热并行
  const physicsPromise = createPhysics({
    nodes,
    terrains,
    settings: (cfg && cfg.physics) || (sceneData.settings && sceneData.settings.physics),
    workerUrl: physicsWorkerUrl,
  }).catch((e) => {
    postLog("error", `物理运行时启动失败: ${e?.message ?? e}`);
    return null;
  });

  // 动画 Worker 提前启动（与物理同模式：Worker 初始化与后续天空盒/贴图/渲染预热并行）
  const animationPromise = createAnimations(meshes, models, animationWorkerUrl).catch((e) => {
    postLog("error", `动画运行时启动失败: ${e?.message ?? e}`);
    return null;
  });

  // UI（Canvas-Widget，屏幕叠加）：画布根贴合渲染相机由 update 每帧完成；
  // 主渲染各 pass 隐藏画布、主渲染后由专属叠加渲染绘制（beginRender/endRender）；
  // 图片/按钮背景贴图按相对路径异步回填（与网格贴图同一 fetch 链路）
  function renderOverlayPass(c) {
    const prevBg = scene.background;
    const prevClearColor = renderer.autoClearColor;
    const prevClearDepth = renderer.autoClearDepth;
    scene.background = null;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.render(scene, c);
    scene.background = prevBg;
    renderer.autoClearColor = prevClearColor;
    renderer.autoClearDepth = prevClearDepth;
  }
  const uiApi = createUI({ nodes, canvas: renderer.domElement, scene, render: renderOverlayPass, scaleMode: cfg.scaleMode });

  // 天空盒：场景里有 启用且可见 的 skyboxNode → 覆盖背景（与编辑器场景背景规则一致）；
  // 立方体天空盒优先消费天空材质（.mat）绑定的 TextureCube（材质 cubeMap 优先，
  // 节点 cubeMap 兜底），未绑定/加载失败（含 .hdr）回退三段色带
  let activeSkyKind = null;
  let skyMatParams = null;
  {
    const sky = findSkyNode(rootJson);
    if (sky) {
      activeSkyKind = sky.skyKind;
      if (sky.material) {
        try {
          skyMatParams = await loadSkyMatParams(sky.material);
        } catch {
          skyMatParams = null;
        }
      }
      const top = matColor(sky.topColor, SKY_DEFAULTS.top);
      const horizon = matColor(sky.horizonColor, SKY_DEFAULTS.horizon);
      const ground = matColor(sky.groundColor, SKY_DEFAULTS.ground);
      scene.background =
        sky.skyKind === "cube"
          ? ((skyMatParams?.cubeMap || sky.cubeMap
              ? await loadSkyTexCube(skyMatParams?.cubeMap || sky.cubeMap)
              : null) ?? makeSkyBandTexture(top, horizon, ground))
          : makeSkyEquirectTexture(top, horizon, ground, {
              disk: sky.sunDisk,
              color: sky.sunColor,
              size: sky.sunSize,
              glow: sky.sunGlow,
              azimuth: sky.sunAzimuth,
              elevation: sky.sunElevation,
            });
      // 天空作为环境光照参与网格材质（与编辑器注入的半球环境光一致）；
      // 照明全部层（three 新建灯光默认只算层 0）
      const env = new THREE.HemisphereLight(mixHexColor(top, horizon, 0.5), ground, 0.55);
      env.layers.enableAll();
      scene.add(env);
    }
  }
  scene.updateMatrixWorld(true);

  // 场景环境雾：场景里有 启用且可见 的 fogNode → 应用 scene.fog
  // （线性 Fog / 指数 FogExp2 / 高度雾，与编辑器 applyFogFromGraph 同一规则；
  // 高度雾在 WebGPU 后端下改走 scene.fogNode —— TSL 来自已随渲染器加载的
  // WebGPU 构建，经典 WebGL 构建不包含 TSL、不参与加载）
  {
    const fog = findFogNode(rootJson);
    if (fog) {
      let webgpuTsl = null;
      if (fog.fogKind === "height" && backend === "webgpu") {
        try {
          webgpuTsl = (await import("../engine/core/three.webgpu.min.js")).TSL;
        } catch {
          webgpuTsl = null;
        }
      }
      applyFogFromNode(scene, fog, { webgpuTsl });
    }
  }

  // 贴图回填（贴图文件已在导出产物内，按相对路径 fetch）
  // 网格贴图与 UI 贴图互不依赖，并行加载
  await Promise.all([
    applyMeshTextures(meshes, materialParams),
    applyTerrainSplatmaps(terrains),
    uiApi.applyTextures().catch((e) => {
      postLog("warn", `UI 贴图回填失败: ${e?.message ?? e}`);
    }),
  ]);

  // 渲染相机（含清除标志：skybox/solidColor/depthOnly/colorOnly）
  const { cam, applyProjection, syncPose, clear, nodeId: renderCamNodeId } = createRenderCamera(cameras);
  const clearColor = new THREE.Color(clear.color);

  // 仅深度/仅颜色清除标志需要跨帧保留缓冲：WebGL 默认关闭（省一整块画布带宽），
  // 命中时在挂载舞台前重建渲染器（首个渲染前 GPU 资源未上传，重建零成本）
  if (
    backend === "webgl" &&
    (clear.flags === "depthOnly" || clear.flags === "colorOnly")
  ) {
    renderer = recreateWebGLRendererPreserveBuffer(cfg, renderer);
  }

  // 正交相机的天空背景面：three.js 的纹理背景只支持透视相机（立方体路径按贴在
  // 相机位置的 1×1×1 反转盒绘制，正交取景远大于盒子），正交 + 天空盒清除标志
  // 时改由该全屏三角形渲染天空：逐像素由逆投影求光线方向后采样天空纹理
  // （等距柱状按 equirectUv、TextureCube 按光线方向 cube 采样，
  // 与编辑器 EditorEngine.updateOrthoSkyQuad 同一算法）
  let skyTexture = scene.background?.isTexture === true ? scene.background : null;
  let orthoSkyQuad = null;
  if (cam.isOrthographicCamera === true && skyTexture) {
    const isCube = skyTexture.isCubeTexture === true;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tSky: { value: null },
        tSkyCube: { value: null },
        uIsCube: { value: isCube ? 1 : 0 },
        uSkyRotation: {
          value: ((skyMatParams?.rotation ?? 0) * Math.PI) / 180,
        },
        uSkyIntensity: { value: skyMatParams?.strength ?? 1 },
        projInverse: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
      },
      vertexShader: `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4( position.xy, 1.0, 1.0 );
        }
      `,
      fragmentShader: `
        uniform sampler2D tSky;
        uniform samplerCube tSkyCube;
        uniform float uIsCube;
        uniform float uSkyRotation;
        uniform float uSkyIntensity;
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
          float cr = cos( uSkyRotation );
          float sr = sin( uSkyRotation );
          vec3 sdir = normalize( vec3( cr * dir.x - sr * dir.z, dir.y, sr * dir.x + cr * dir.z ) );
          vec3 col = uIsCube > 0.5
            ? textureCube( tSkyCube, sdir ).rgb
            : texture2D( tSky, equirectUv( sdir ) ).rgb;
          gl_FragColor = vec4( col * uSkyIntensity, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      fog: false,
      // 与透视背景同一色调映射规则：线性 HDR（等距柱状程序化天空）随渲染器
      // toneMapping；sRGB 显示域内容（TextureCube）不再映射（同 WebGLBackground）
      toneMapped: !isCube,
    });
    orthoSkyQuad = new THREE.Mesh(geometry, material);
    orthoSkyQuad.renderOrder = -1000000; // 最先绘制，被其后绘制的场景物体覆盖
    orthoSkyQuad.frustumCulled = false;
    orthoSkyQuad.visible = false;
    // 分层多 pass 渲染（Culling Mask）：天空背景面只在首个 pass 绘制
    orthoSkyQuad.userData.skyOnlyFirstPass = true;
    scene.add(orthoSkyQuad);
    // uniforms 在 applyClearFlags 每帧更新前先按纹理形态就位
    orthoSkyQuad.material.uniforms.tSky.value = isCube ? null : skyTexture;
    orthoSkyQuad.material.uniforms.tSkyCube.value = isCube ? skyTexture : null;
  }

  // 舞台尺寸适配（场景始终按窗口尺寸渲染铺满；缩放模式由 UI 系统消费）
  createStage(app, cfg, applyProjection, renderer);

  // 程序化天空材质：Nishita 大气散射。需要 WebGL 渲染上下文（离屏 LUT 预计算），
  // 渲染器就绪后生成并覆盖渐变兜底；强度经背景属性与正交面 uniform 同步生效。
  // WebGPU 后端同编辑器策略：保留渐变兜底（不做示意性替换）
  if (activeSkyKind === "procedural" && skyMatParams && backend === "webgl") {
    try {
      const nishita = makeNishitaSkyEquirect(renderer, skyMatParams);
      scene.background = nishita;
      scene.backgroundIntensity = skyMatParams.strength ?? 1;
      skyTexture = scene.background;
      if (orthoSkyQuad) {
        const u = orthoSkyQuad.material.uniforms;
        u.tSky.value = null;
        u.tSkyCube.value = null;
        u.uIsCube.value = 0;
        u.tSky.value = skyTexture;
        u.uSkyIntensity.value = skyMatParams.strength ?? 1;
      }
    } catch (e) {
      postLog("error", `程序化天空生成失败: ${e?.message ?? e}`);
    }
  } else if (activeSkyKind === "procedural" && skyMatParams) {
    postLog("info", "WebGPU 后端下程序化天空使用渐变兜底（与编辑器一致）");
  }

  // 相机清除标志：每帧渲染前应用（与编辑器预览渲染规则一致）
  function applyClearFlags() {
    switch (clear.flags) {
      case "solidColor":
        scene.background = clearColor;
        renderer.autoClearColor = true;
        renderer.autoClearDepth = true;
        break;
      case "depthOnly":
        // 只清深度：不清颜色、不绘制背景，保留上一帧画面
        scene.background = null;
        renderer.autoClearColor = false;
        renderer.autoClearDepth = true;
        break;
      case "colorOnly":
        // 只清颜色：不清深度，保留上一帧深度
        scene.background = null;
        renderer.autoClearColor = true;
        renderer.autoClearDepth = false;
        break;
      default:
        // skybox：透视保留全局天空/底色背景，确保颜色+深度全清；
        // 正交由全屏天空背景面渲染（背景置空，避免失效的立方体背景绘制）
        renderer.autoClearColor = true;
        renderer.autoClearDepth = true;
        if (orthoSkyQuad) {
          scene.background = null;
          const u = orthoSkyQuad.material.uniforms;
          cam.updateMatrixWorld(); // 渲染前 matrixWorld 尚未推进，需手动刷新
          u.projInverse.value.copy(cam.projectionMatrixInverse);
          u.camWorld.value.copy(cam.matrixWorld);
          orthoSkyQuad.visible = true;
        }
    }
  }

  // 阴影相机贴合场景包围盒（相机朝 -Z 时 target 世界矩阵由场景更新）。
  // three 的平行光阴影相机默认为正交 ±5：场景稍大阴影就会整块消失/被裁掉，
  // 聚光灯远平面也默认按 distance（0 时 500）。这里按**整场景包围盒**贴合一次，
  // 贴图分辨率与深度偏移一并置位（three 只在首次渲染前按 mapSize 分配阴影贴图，
  // 所以必须在渲染循环启动前置位）。
  configureShadows(scene);

  // 首帧管线/着色程序预热：全部材质（含阴影深度变体）在载入阶段编译完毕
  // （WebGPU 异步、WebGL 同步），避免首个渲染帧集中编译造成的启动卡顿
  try {
    if (backend === "webgpu") await renderer.compileAsync(scene, cam);
    else renderer.compile(scene, cam);
  } catch (e) {
    postLog("warn", `渲染预热失败（${e?.message ?? e}），首帧可能卡顿`);
  }

  // 模型动画（单剪辑/动画图，autoplay 的节点随渲染循环播放）
  // Worker 初始化已提前启动，此处 await 拿到 API 后绑定骨骼/IK 目标
  const animations = await animationPromise;

  // 骨骼/IK 目标绑定（MeshNode.boneBindings 随场景数据；场景树已建全，目标对象可直接解析。
  // 编辑器皮肤面板写入的绑定在此生效——与 anim/animGraph 同为节点持久化数据）
  if (animations) {
    for (const { json, obj } of nodes) {
      if (json.source !== "model" || !Array.isArray(json.boneBindings) || !json.boneBindings.length) {
        continue;
      }
      for (const def of json.boneBindings) {
        if (!def || typeof def !== "object" || typeof def.target !== "string" || typeof def.bone !== "string") {
          continue;
        }
        const target = nodes.find((n) => n.json.id === def.target)?.obj;
        if (target && obj) animations.attachObject(json.id, target, def.bone, def);
      }
    }
  }

  // 音频（音源节点 2D/3D 播放；监听器挂渲染相机随其位姿推进；
  // autoplay 绑定在用户首次交互解锁 AudioContext 后自动起播）
  const audiosApi = createAudios(audios, cam);

  // 粒子系统（粒子节点 CPU 模拟 + 实例化四边形渲染；每帧渲染前推进，
  // 脚本经 engine.particles / ParticleSystemNode 控制播放）。
  // 粒子贴图走与网格贴图同一 fetch + ImageBitmap 链路（颜色贴图 sRGB），异步到位后热替换；
  // 材质工厂在建场景树之前按后端选定（见入口处），此处透传给运行时的重建/add 路径
  const particleTexCache = new Map();
  const particlesApi = createParticles(
    particles,
    (rel) => loadImageTex(particleTexCache, rel, true),
    particleMaterialFactory,
  );

  // 地形（静态高度场网格，无逐帧更新；脚本经 TerrainNode SDK 贴地采样）
  const terrainsApi = createTerrains(terrains);

  // 物理：await 提前启动的 promise（WASM 编译已与天空盒/贴图/渲染预热并行完成）
  const physicsApi = await physicsPromise;

  // 关键帧动画剪辑（节点 animationClip 组件；autoplay 绑定自动应用）。
  // 传渲染相机（camera.* 投影通道按节点匹配写入）与 UI 系统（ui.* 数据通道）
  const clipAnims = await createClipAnimations(clips, {
    renderCamera: { nodeId: renderCamNodeId, cam },
    ui: uiApi,
  }).catch((e) => {
    postLog("error", `关键帧动画运行时启动失败: ${e?.message ?? e}`);
    return { update() {} };
  });

  // 逻辑运行器（状态机/行为树节点；.fsm/.bt 资产按 rel 读取）：
  // 必须先于脚本宿主完成——脚本 onStart 时 engine.logic 已可用。
  // 宿主失败不阻断渲染回放（运行器空转）。
  let logicApi = { update() {}, dispose() {} };
  try {
    logicApi = await createLogic({ nodes });
  } catch (e) {
    postLog("error", `逻辑运行时启动失败: ${e?.message ?? e}`);
  }

  // 用户脚本（节点脚本组件 + 入口脚本）：宿主失败不阻断渲染回放
  let scripts = { update() {}, dispose() {} };
  try {
    scripts = await createScripts({
      nodes,
      cfg,
      animations: animations || { update() {} },
      audios: audiosApi,
      physics: physicsApi,
      clipAnims,
      particles: particlesApi,
      terrains: terrainsApi,
      ui: uiApi,
      logic: logicApi,
      canvas: renderer.domElement,
    });
  } catch (e) {
    postLog("error", `脚本宿主启动失败: ${e?.message ?? e}`);
  }
  // 页面卸载/预览重载：脚本 onDisable → onDestroy（清理定时器/事件等外部资源）
  window.addEventListener("pagehide", () => { scripts.dispose(); logicApi.dispose(); }, { once: true, capture: true });

  // 静态场景门控：无用户脚本/模型动画/关键帧剪辑/物理时，场景每帧不变 ——
  // 世界矩阵停更（render 跳过全树遍历重算），阴影贴图只渲染一次
  // （每灯 shadow.needsUpdate 首帧消费后冻结，WebGL/WebGPU 同语义）。
  // 脚本/动画/物理都可能移动任意节点，存在其一即保持逐帧更新。
  // 注意物理判据用配置的 physicsEnabled（createPhysics 未启用时也返回空转 API，非 null）。
  const physicsSettings =
    (cfg && cfg.physics) || (sceneData.settings && sceneData.settings.physics) || null;
  const physicsActive = !!(physicsSettings && physicsSettings.physicsEnabled === true);
  const hasScriptComponent = nodes.some(({ json }) =>
    (Array.isArray(json.components) ? json.components : []).some(
      (c) => c && c.type === "script" && c.enabled !== false && typeof c.script === "string" && c.script,
    ),
  );
  const hasEntryScript = typeof cfg.entryScript === "string" && cfg.entryScript.trim() !== "";
  const hasModelClip = meshes.some(
    ({ json }) => json.source === "model" && (models.get(json.model)?.clips?.length > 0),
  );
  // UI 画布存在时保持逐帧更新：画布根每帧贴合相机（矩阵覆写）不能被冻结
  const hasUICanvas = nodes.some(({ json }) => json.type === "uiCanvasNode");
  if (
    !hasScriptComponent &&
    !hasEntryScript &&
    clips.length === 0 &&
    !hasModelClip &&
    !physicsActive &&
    !hasUICanvas
  ) {
    scene.matrixWorldAutoUpdate = false;
    scene.traverse((o) => {
      if (o.isLight === true && o.castShadow === true) {
        o.shadow.autoUpdate = false;
        o.shadow.needsUpdate = true;
      }
    });
  }

  // 帧间隔计时（THREE.Clock 已在 r183 弃用 → Timer；connect 启用页面可见性处理，
  // 切后台恢复后不产生巨大补帧间隔。update 用 rAF 时间戳，与帧回调同源对齐）
  const timer = new THREE.Timer();
  timer.connect(document);
  // 着色器时间（钩子 _Time；按帧间隔累加，与 timer 的 getDelta 取值互不干扰）
  let shaderTime = 0;

  // —— 调试统计面板（编辑器 postMessage 或 F3 键切换）——
  let debugVisible = false;
  let debugFps = 0;
  let debugLastTime = 0;
  let debugMeshes = 0;
  let debugVertices = 0;
  let debugPanel = null;
  let debugTimer = 0;

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }

  function buildDebugPanel() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute;top:8px;right:8px;z-index:9999;pointer-events:none;" +
      "background:rgba(0,0,0,0.55);border-radius:4px;padding:6px 10px;" +
      "font:11px/1.6 monospace;color:#ddd;min-width:120px;";
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">FPS</span><b id="dbg-fps">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">DrawCalls</span><b id="dbg-calls">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">网格</span><b id="dbg-meshes">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">顶点</span><b id="dbg-verts">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">三角面</span><b id="dbg-tris">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">几何体</span><b id="dbg-geos">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">纹理</span><b id="dbg-texs">0</b></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px"><span style="opacity:.6">着色器</span><b id="dbg-progs">0</b></div>';
    return el;
  }

  function updateDebugPanel() {
    if (!debugPanel) return;
    const info = renderer.info;
    const fpsEl = debugPanel.querySelector("#dbg-fps");
    fpsEl.textContent = Math.round(debugFps);
    fpsEl.style.color = debugFps < 30 ? "#f44" : debugFps < 50 ? "#fa0" : "#ddd";
    debugPanel.querySelector("#dbg-calls").textContent = info?.render?.calls ?? 0;
    debugPanel.querySelector("#dbg-meshes").textContent = debugMeshes;
    debugPanel.querySelector("#dbg-verts").textContent = fmtNum(debugVertices);
    debugPanel.querySelector("#dbg-tris").textContent = fmtNum(info?.render?.triangles ?? 0);
    debugPanel.querySelector("#dbg-geos").textContent = info?.memory?.geometries ?? 0;
    debugPanel.querySelector("#dbg-texs").textContent = info?.memory?.textures ?? 0;
    debugPanel.querySelector("#dbg-progs").textContent = info?.programs?.length ?? 0;
  }

  function toggleDebugPanel() {
    debugVisible = !debugVisible;
    if (debugVisible && !debugPanel) {
      debugPanel = buildDebugPanel();
      if (app) app.appendChild(debugPanel);
      debugTimer = setInterval(updateDebugPanel, 200);
    } else if (debugVisible && debugPanel) {
      debugPanel.style.display = "";
      if (!debugTimer) debugTimer = setInterval(updateDebugPanel, 200);
    } else if (debugPanel) {
      debugPanel.style.display = "none";
      if (debugTimer) { clearInterval(debugTimer); debugTimer = 0; }
    }
  }

  // 编辑器经 postMessage 切换调试面板（设备仿真条"调试"按钮）
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.__editorPreviewDebug === true) {
      debugVisible = d.visible === true;
      if (debugVisible && !debugPanel) {
        debugPanel = buildDebugPanel();
        if (app) app.appendChild(debugPanel);
        debugTimer = setInterval(updateDebugPanel, 200);
      } else if (debugVisible && debugPanel) {
        debugPanel.style.display = "";
        if (!debugTimer) debugTimer = setInterval(updateDebugPanel, 200);
      } else if (debugPanel) {
        debugPanel.style.display = "none";
        if (debugTimer) { clearInterval(debugTimer); debugTimer = 0; }
      }
    }
  });
  // F3 键快捷切换
  window.addEventListener("keydown", (e) => {
    if (e.key === "F3") { e.preventDefault(); toggleDebugPanel(); }
  });

  function frame(now) {
    requestAnimationFrame(frame);
    timer.update(now);
    const dt = timer.getDelta();
    shaderTime += dt;
    tickShaderTime(shaderTime);
    // 固定步长脚本更新（1/60s 累积驱动 0..n 次，先于本帧一切可变步长更新；
    // 与物理步进同频，物理相关的确定性逻辑在 onFixedUpdate）
    scripts.fixedUpdate(dt);
    scripts.update(dt);
    // 逻辑运行器推进（状态机切换/行为树求值；脚本本帧的 fire/参数写入即刻生效）
    logicApi.update(dt);
    animations?.update(dt);
    physicsApi?.update(dt);
    clipAnims.update(dt);
    audiosApi.update();
    // 粒子推进（脚本/物理已更新节点位姿后再发射，world 空间粒子出生点跟上）
    particlesApi.update(dt);
    // 晚更新：全部模拟（脚本/动画/物理/粒子）完成后、相机位姿回填与渲染前
    // ——相机跟随等覆盖性位姿写在 onLateUpdate，当帧即被回填生效
    scripts.lateUpdate(dt);
    // 场景相机节点位姿（可能被脚本/动画/物理驱动）每帧回填渲染相机
    syncPose();
    // UI 相机叠加：画布根贴合渲染相机（相机位姿回填之后）
    uiApi.update(cam);
    applyClearFlags();
    // 主渲染各 pass 隐藏 UI 画布；完成后恢复并做 UI 专属叠加渲染
    const uiHidden = uiApi.beginRender();
    // 分层渲染（Culling Mask）：相机掩码全开/单层占用 → 单 pass（零开销）；
    // 多层占用 → 按层拆 pass，灯光只照亮各自掩码内的层（layerpass.mjs）
    const bits = layerPassBits(scene, cam);
    if (!bits) renderer.render(scene, cam);
    else renderLayerPasses(renderer, scene, cam, bits);
    if (uiHidden > 0) uiApi.endRender(cam);
    // 调试统计：FPS（EMA 平滑）+ 场景网格/顶点遍历
    if (debugVisible) {
      const t = performance.now();
      if (debugLastTime > 0) {
        const d = t - debugLastTime;
        if (d > 0) {
          const inst = 1000 / d;
          debugFps = debugFps > 0 ? debugFps * 0.9 + inst * 0.1 : inst;
        }
      }
      debugLastTime = t;
      let m = 0, v = 0;
      scene.traverse((o) => {
        if (o.isMesh && o.geometry) {
          const pos = o.geometry.getAttribute("position");
          if (pos) { m++; v += pos.count; }
        }
      });
      debugMeshes = m;
      debugVertices = v;
    }
  }
  frame();

  postLog("info", "网页预览已启动（独立运行时）");
}

window.addEventListener("error", (e) => {
  fail(e.message || "未知错误");
});
main().catch(fail);
