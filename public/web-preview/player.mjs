// 网页预览运行时（独立于编辑器）：加载由编辑器导出的 scene.json / config.json，
// 用 three 把场景内容原样回放（网格/灯光/相机），作为“网页预览视图”。
// 与编辑器预览渲染的差异：无网格/辅助线/gizmo，运行在独立 iframe 页面里。
// 实现按职责拆分在同目录 libs/ 下（three 运行时 + 各功能模块），此处只做装配。
import * as THREE from "./libs/three.module.min.js";
import { fail, postLog, setLogForwarding } from "./libs/log.mjs";
import { matColor, mixHexColor } from "./libs/utils.mjs";
import {
  SKY_DEFAULTS,
  findSkyNode,
  loadSkyMatParams,
  loadSkyTexCube,
  makeNishitaSkyEquirect,
  makeSkyBandTexture,
  makeSkyEquirectTexture,
} from "./libs/sky.mjs";
import { loadMaterialParams } from "./libs/material.mjs";
import { loadModels } from "./libs/model.mjs";
import { createAnimations } from "./libs/animation.mjs";
import { createAudios } from "./libs/audio.mjs";
import { createPhysics } from "./libs/physics.mjs";
import { buildSceneTree } from "./libs/nodes.mjs";
import { createClipAnimations } from "./libs/animclip.mjs";
import { createScripts } from "./libs/scripts.mjs";
import { applyMeshTextures } from "./libs/textures.mjs";
import { createRenderCamera } from "./libs/camera.mjs";
import { createStage } from "./libs/stage.mjs";
import { base64ToBytes, gunzip, installAssetShim, parseArchive } from "./libs/pak.mjs";

const app = document.getElementById("app");

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
      const r = await fetch("./config.json");
      if (r.ok) cfg = await r.json();
    } catch {
      /* 无配置也允许预览 */
    }
  }

  // 发布构建（debug=false）关闭日志转发（编辑器内嵌预览默认转发）
  if (cfg.debug === false) setLogForwarding(false);

  // 资产来源优先级：内联 gzip 包（单页+gzip）→ 内联资产表（单页）→
  // assets.gzip 归档（多文件+gzip）→ 磁盘文件（多文件/编辑器预览）。
  // 归档命中后安装 fetch 拦截，场景/材质/贴图/模型仍按相对路径 fetch。
  if (inline && inline.pak) {
    installAssetShim(parseArchive(await gunzip(base64ToBytes(inline.pak))));
  } else if (inline && inline.assets) {
    const map = new Map();
    for (const [rel, b64] of Object.entries(inline.assets)) map.set(rel, base64ToBytes(b64));
    installAssetShim(map);
  } else if (!inline) {
    try {
      // gzip 资源地址（config.gzipBase，与 Three CDN 模式无关）非空时归档从远端
      // 拉取，产物内仍生成 assets.gzip 供上传；空 = 按本地相对路径读取。
      // 地址已以 /assets.gzip 结尾时直接使用，避免重复拼接
      const pakBase =
        typeof cfg.gzipBase === "string" ? cfg.gzipBase.trim().replace(/\/+$/, "") : "";
      const pakUrl = pakBase.endsWith("/assets.gzip") ? pakBase : pakBase + "/assets.gzip";
      const r = await fetch(pakUrl || "./assets.gzip");
      if (r.ok) installAssetShim(parseArchive(await gunzip(new Uint8Array(await r.arrayBuffer()))));
    } catch {
      /* 无归档则按文件读取 */
    }
  }

  // 场景文件：编辑器内嵌预览固定 ./scene.json；构建产物按 config.scenes 列表
  // 选择（?scene=<场景名> 查询参数 > cfg.mainScene > 首个场景）
  const sceneUrl = (() => {
    if (!Array.isArray(cfg.scenes) || cfg.scenes.length === 0) return "./scene.json";
    const wanted = new URLSearchParams(location.search).get("scene") || cfg.mainScene;
    const pick = cfg.scenes.find((s) => s && s.name === wanted) || cfg.scenes[0];
    return "./" + String(pick.file || "scene.json");
  })();
  const sceneData = await (async () => {
    const r = await fetch(sceneUrl);
    if (!r.ok) throw new Error("读取场景文件失败: HTTP " + r.status);
    return r.json();
  })();

  const rootJson = sceneData && sceneData.root;
  if (!rootJson) throw new Error("scene.json 缺少 root");

  const renderSettings = sceneData.settings && sceneData.settings.rendering;
  const bgColor =
    typeof renderSettings?.backgroundColor === "number"
      ? renderSettings.backgroundColor & 0xffffff
      : 0x141414;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bgColor);

  // 资产预取：材质参数表（.mat）+ 模型（glb/gltf/fbx/obj，已随导出拷贝到同相对路径）
  const [materialParams, models] = await Promise.all([
    loadMaterialParams(rootJson),
    loadModels(rootJson),
  ]);
  const { cameras, meshes, audios, clips, nodes } = buildSceneTree(rootJson, scene, { materialParams, models });

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
      // 天空作为环境光照参与网格材质（与编辑器注入的半球环境光一致）
      const env = new THREE.HemisphereLight(mixHexColor(top, horizon, 0.5), ground, 0.55);
      scene.add(env);
    }
  }
  scene.updateMatrixWorld(true);

  // 贴图回填（贴图文件已在导出产物内，按相对路径 fetch）
  await applyMeshTextures(meshes, materialParams);

  // 渲染相机（含清除标志：skybox/solidColor/depthOnly/colorOnly）
  const { cam, applyProjection, clear } = createRenderCamera(cameras);
  const clearColor = new THREE.Color(clear.color);

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
    scene.add(orthoSkyQuad);
    // uniforms 在 applyClearFlags 每帧更新前先按纹理形态就位
    orthoSkyQuad.material.uniforms.tSky.value = isCube ? null : skyTexture;
    orthoSkyQuad.material.uniforms.tSkyCube.value = isCube ? skyTexture : null;
  }

  // 渲染器 + 舞台缩放适配（按设计分辨率/缩放模式取景并适配 iframe）
  const renderer = createStage(app, cfg, applyProjection);

  // 程序化天空材质：Nishita 大气散射（Blender 天空纹理风格）。需要渲染上下文，
  // 渲染器就绪后生成并覆盖渐变兜底；强度经背景属性与正交面 uniform 同步生效
  if (activeSkyKind === "procedural" && skyMatParams) {
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

  // 平行光/聚光阴影范围兜底（相机朝 -Z 时 target 世界矩阵由场景更新）
  scene.traverse((o) => {
    if (o.isLight && o.castShadow) {
      o.shadow.mapSize.set(1024, 1024);
      o.shadow.bias = -0.0005;
    }
  });

  // 模型动画（单剪辑/动画图，autoplay 的节点随渲染循环播放）
  const animations = createAnimations(meshes, models);

  // 音频（音源节点 2D/3D 播放；监听器挂渲染相机随其位姿推进；
  // autoplay 绑定在用户首次交互解锁 AudioContext 后自动起播）
  const audiosApi = createAudios(audios, cam);

  // 物理（刚体/碰撞体节点模拟）。配置取项目设置（config.json 的 physics 字段：
  // 引擎/重力/physicsEnabled）；旧产物无项目配置时回退场景 settings.physics。
  // physicsEnabled 为 true 时自动开始模拟，后端 rapier|jolt|ammo 惰性加载。
  const physicsApi = await createPhysics({
    nodes,
    settings: (cfg && cfg.physics) || (sceneData.settings && sceneData.settings.physics),
  }).catch((e) => {
    postLog("error", `物理运行时启动失败: ${e?.message ?? e}`);
    return null;
  });

  // 关键帧动画剪辑（节点 animationClip 组件；autoplay 绑定自动应用）
  const clipAnims = await createClipAnimations(clips).catch((e) => {
    postLog("error", `关键帧动画运行时启动失败: ${e?.message ?? e}`);
    return { update() {} };
  });

  // 用户脚本（节点脚本组件 + 入口脚本）：宿主失败不阻断渲染回放
  let scripts = { update() {}, dispose() {} };
  try {
    scripts = await createScripts({
      nodes,
      cfg,
      animations,
      audios: audiosApi,
      physics: physicsApi,
      canvas: renderer.domElement,
    });
  } catch (e) {
    postLog("error", `脚本宿主启动失败: ${e?.message ?? e}`);
  }
  // 页面卸载/预览重载：脚本 onDisable → onDestroy（清理定时器/事件等外部资源）
  window.addEventListener("pagehide", () => scripts.dispose(), { once: true, capture: true });

  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);
    const dt = clock.getDelta();
    scripts.update(dt);
    animations.update(dt);
    physicsApi?.update(dt);
    clipAnims.update(dt);
    audiosApi.update();
    applyClearFlags();
    renderer.render(scene, cam);
  }
  frame();

  postLog("info", "网页预览已启动（独立运行时）");
}

window.addEventListener("error", (e) => {
  fail(e.message || "未知错误");
});
main().catch(fail);
