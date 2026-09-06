// 网页预览运行时（独立于编辑器）：加载由编辑器导出的 scene.json / config.json，
// 用 three 把场景内容原样回放（网格/灯光/相机），作为“网页预览视图”。
// 与编辑器预览渲染的差异：无网格/辅助线/gizmo，运行在独立 iframe 页面里。
// 实现按职责拆分在同目录 libs/ 下（three 运行时 + 各功能模块），此处只做装配。
import * as THREE from "./libs/three.module.min.js";
import { fail, postLog } from "./libs/log.mjs";
import { matColor, mixHexColor } from "./libs/utils.mjs";
import {
  SKY_DEFAULTS,
  findSkyNode,
  makeSkyCubeTexture,
  makeSkyEquirectTexture,
} from "./libs/sky.mjs";
import { loadMaterialParams } from "./libs/material.mjs";
import { loadModels } from "./libs/model.mjs";
import { createAnimations } from "./libs/animation.mjs";
import { buildSceneTree } from "./libs/nodes.mjs";
import { applyMeshTextures } from "./libs/textures.mjs";
import { createRenderCamera } from "./libs/camera.mjs";
import { createStage } from "./libs/stage.mjs";

const app = document.getElementById("app");

async function main() {
  // 项目配置（渲染合成/抗锯齿；缺省按编辑器 LDR 默认）
  let cfg = {};
  try {
    const r = await fetch("./config.json");
    if (r.ok) cfg = await r.json();
  } catch {
    /* 无配置也允许预览 */
  }

  const sceneData = await (async () => {
    const r = await fetch("./scene.json");
    if (!r.ok) throw new Error("读取 scene.json 失败: HTTP " + r.status);
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
  const { cameras, meshes } = buildSceneTree(rootJson, scene, { materialParams, models });

  // 天空盒：场景里有 启用且可见 的 skyboxNode → 覆盖背景（与编辑器场景背景规则一致）
  {
    const sky = findSkyNode(rootJson);
    if (sky) {
      const top = matColor(sky.topColor, SKY_DEFAULTS.top);
      const horizon = matColor(sky.horizonColor, SKY_DEFAULTS.horizon);
      const ground = matColor(sky.groundColor, SKY_DEFAULTS.ground);
      scene.background =
        sky.skyKind === "cube"
          ? makeSkyCubeTexture(top, horizon, ground)
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

  // 渲染相机
  const { cam, applyProjection } = createRenderCamera(cameras);

  // 渲染器 + 舞台缩放适配（按设计分辨率/缩放模式取景并适配 iframe）
  const renderer = createStage(app, cfg, applyProjection);

  // 平行光/聚光阴影范围兜底（相机朝 -Z 时 target 世界矩阵由场景更新）
  scene.traverse((o) => {
    if (o.isLight && o.castShadow) {
      o.shadow.mapSize.set(1024, 1024);
      o.shadow.bias = -0.0005;
    }
  });

  // 模型动画（单剪辑/动画图，autoplay 的节点随渲染循环播放）
  const animations = createAnimations(meshes, models);
  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);
    animations.update(clock.getDelta());
    renderer.render(scene, cam);
  }
  frame();

  postLog("info", "网页预览已启动（独立运行时）");
}

window.addEventListener("error", (e) => {
  fail(e.message || "未知错误");
});
main().catch(fail);
