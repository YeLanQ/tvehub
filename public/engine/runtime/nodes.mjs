// 场景树构建：按导出的 scene.json 递归生成 three 对象并挂到场景。
// - meshNode → createMesh（mesh.mjs）；
// - 灯光节点 → Group + 真实 Light（方向光/聚光灯附加本地 -Z 目标点；
//   点光/平行光/聚光灯可自带阴影参数组，见 applyLightShadow）；
// - cameraNode → Group（记录世界位姿供渲染相机选用）；
// - fogNode → Group（场景环境雾；scene.fog 由 player 经 runtime/fog.mjs 统一应用，
//   第一个 启用且可见 的 fogNode 生效，与编辑器 applyFogFromGraph 同语义）；
// - particleSystemNode → Group + 粒子 Points 子对象（发射器见 core/particles.mjs，
//   与编辑器 ParticleEmitter 同语义；每帧推进由 runtime/particles.mjs 驱动）；
// - UI（Canvas-Widget）：uiCanvasNode/uiImageNode/uiTextNode/uiButtonNode →
//   buildUI*（ui.mjs；画布叠加与渲染序合成由 runtime/ui.mjs 的 createUI 驱动）；
// - 其余 → Group；
// - 组件模式：任意节点 components 中的 light / audioSource 组件同样生效——
//   灯光组件重建灯光子对象（与灯光节点同一光照语义），音源组件并入音频绑定
//   表（组件 id 寻址；节点 id 命中首个音源，兼容 SDK 按实体播放）。
import * as THREE from "../core/three.module.min.js";
import { num, vec, D2R } from "../core/utils.mjs";
import { buildComponentLight } from "../core/lights.mjs";
import { createParticleEmitter } from "../core/particles.mjs";
import { createMesh } from "./mesh.mjs";
import { createTerrain } from "./terrain.mjs";
import { buildUICanvas, buildUIImage, buildUIText, buildUIButton, buildUILayout } from "./ui.mjs";

/** 节点层索引收敛（与编辑器 clampLayerIndex 同语义：0~31，越界/非法回退 0） */
function parseLayerIndex(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return n >= 0 && n < 32 ? n : 0;
}

/** culling mask 收敛（与编辑器 parseCullingMask 同语义：int32 位掩码，缺省全部层） */
export function parseCullingMask(v) {
  return typeof v === "number" && Number.isFinite(v) ? v | 0 : -1;
}

const LIGHT_NODE_TYPES = new Set([
  "pointLightNode",
  "directionalLightNode",
  "spotLightNode",
  "ambientLightNode",
]);

/**
 * 递归构建场景树（含自身/子级的变换与可见性），返回收集结果：
 * - cameras：cameraNode 列表（{ json, obj }，供渲染相机取位姿/参数）；
 * - meshes：meshNode 列表（{ json, obj }，供贴图回填/动画绑定遍历）；
 * - audios：音源列表（{ json, obj }，json.id 为音源节点 id 或音源组件 id，
 *   供音频绑定遍历；音源组件条目另带 nodeId 供按实体寻址回填）；
 * - clips：关键帧动画剪辑组件列表；
 * - particles：粒子系统节点列表（{ json, obj, emitter }，供 runtime/particles.mjs
 *   每帧推进与按节点 id 寻址控制）；
 * - nodes：全部节点列表（{ json, obj }，供脚本宿主/tve SDK 寻址；
 *   节点对象打 userData.nodeId/nodeTag 标记，灯光实例等内部子对象不带标记）。
 * ctx = { materialParams, models, particleMaterial }：.mat 参数表 + 模型实例化缓存 +
 * 粒子材质工厂（按渲染后端注入：WebGPU 传 TSL 工厂，缺省 GLSL）。
 */
export function buildSceneTree(rootJson, scene, ctx) {
  const cameras = [];
  const meshes = [];
  const audios = [];
  const clips = [];
  const particles = [];
  const terrains = [];
  const nodes = [];

  function buildOwn(type, json) {
    switch (type) {
      case "meshNode":
        return createMesh(json, ctx);
      case "pointLightNode":
        return wrapLight(json, "point");
      case "directionalLightNode":
        return wrapLight(json, "directional");
      case "spotLightNode":
        return wrapLight(json, "spot");
      case "ambientLightNode":
        return wrapLight(json, "ambient");
      case "particleSystemNode":
        return wrapParticles(json);
      case "terrainNode":
        return wrapTerrain(json);
      case "uiCanvasNode":
        return buildUICanvas();
      case "uiImageNode":
        return buildUIImage(json);
      case "uiTextNode":
        return buildUIText(json);
      case "uiButtonNode":
        return buildUIButton(json);
      case "uiLayoutNode":
        return buildUILayout();
      default:
        return new THREE.Group();
    }
  }

  /** 粒子系统节点：Group 承载节点变换，粒子实例网格挂其下（与编辑器同结构） */
  function wrapParticles(json) {
    const group = new THREE.Group();
    // 材质工厂按渲染后端注入（WebGPU → TSL；缺省 GLSL）
    const emitter = createParticleEmitter(json.particles, ctx.particleMaterial);
    group.add(emitter.object);
    particles.push({ json, obj: group, emitter });
    return group;
  }

  /** 地形节点：Group 承载节点变换，烘焙高度场网格挂 __terrainMesh（与编辑器同结构）；
   *  data 供 createTerrains 的贴地采样（sampleHeight/sampleSlope）使用 */
  function wrapTerrain(json) {
    const group = new THREE.Group();
    const { obj: mesh, data, settings } = createTerrain(json);
    group.add(mesh);
    terrains.push({ json, obj: group, data, settings });
    return group;
  }

  function buildNode(json, parent) {
    const type = json.type;
    const tr = json.transform || {};
    const obj = buildOwn(type, json);
    obj.name = json.name ?? type;
    // 节点身份标记（tve SDK 实体寻址用；内部子对象不带）
    obj.userData.nodeId = typeof json.id === "string" ? json.id : "";
    obj.userData.nodeKind = typeof type === "string" ? type : "";
    obj.userData.nodeTag = typeof json.tag === "string" ? json.tag : "";
    obj.visible = json.active !== false && json.visible !== false;

    // 渲染层级：
    // - 网格/普通节点：根对象与其生成的渲染内容子树（描边壳等）同层；
    // - 灯光节点：包装组随层，内部真实灯光对象 = cullingMask（wrapLight 内置位），
    //   不能被子树覆盖。
    const layer = parseLayerIndex(json.layer);
    obj.layers.set(layer);
    obj.userData.nodeLayer = layer;
    if (!LIGHT_NODE_TYPES.has(type)) {
      obj.traverse((o) => {
        o.layers.set(layer);
      });
    }

    const p = vec(tr.position, { x: 0, y: 0, z: 0 });
    const r = vec(tr.rotation, { x: 0, y: 0, z: 0 });
    const s = vec(tr.scale, { x: 1, y: 1, z: 1 });
    obj.position.set(num(p.x, 0), num(p.y, 0), num(p.z, 0));
    obj.rotation.order = "XYZ";
    obj.rotation.set(num(r.x, 0) * D2R, num(r.y, 0) * D2R, num(r.z, 0) * D2R);
    obj.scale.set(num(s.x, 1), num(s.y, 1), num(s.z, 1));

    // 组件模式：灯光/音源/动画剪辑组件（启用中的才生效）
    const comps = Array.isArray(json.components) ? json.components : [];
    for (const c of comps) {
      if (!c || typeof c !== "object" || c.enabled === false) continue;
      if (c.type === "light") {
        buildComponentLight(c.light || {}, obj);
      } else if (c.type === "audioSource") {
        audios.push({ json: { id: c.id, audio: c.audio }, obj, nodeId: json.id });
      } else if (c.type === "animationClip") {
        const binding = c.clip && typeof c.clip === "object" ? c.clip : {};
        clips.push({
          key: typeof c.id === "string" ? c.id : "",
          nodeId: json.id,
          clip: typeof binding.clip === "string" ? binding.clip : "",
          obj,
          autoplay: binding.autoplay !== false,
          loop: binding.loop !== false,
          speed: num(binding.speed, 1),
        });
      }
    }

    if (parent) parent.add(obj);
    else scene.add(obj);

    // 文档序（先父后子）登记全节点注册表
    nodes.push({ json, obj });

    const children = Array.isArray(json.children) ? json.children : [];
    for (const c of children) buildNode(c, obj);

    if (type === "cameraNode") cameras.push({ json, obj });
    if (type === "meshNode") meshes.push({ json, obj });
    if (type === "audioNode") audios.push({ json, obj });
    return obj;
  }

  /**
   * 灯光阴影参数置位（与编辑器 SceneSynchronizer 同一语义）：
   * 贴图分辨率（点光 1024 / 其余 2048；three 只在首次渲染前按 mapSize 分配贴图）、
   * 浓度（shadow.intensity）、深度偏移、法线偏移（≤0 = 自动，交给 player 的贴合逻辑）、
   * 近裁剪面（平行光的相机要按场景包围盒后推，near 由 player 合成，这里不写）。
   * 配置留档在 light.userData.shadowCfg 供 player 贴合时读取。
   */
  function applyLightShadow(light, json) {
    const raw = json && typeof json.shadow === "object" ? json.shadow : {};
    const n = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
    const cfg = {
      strength: Math.min(1, Math.max(0, num(raw.strength, 1))),
      bias: Math.min(0, Math.max(-0.05, num(raw.bias, -0.0005))),
      normalBias: Math.max(0, num(raw.normalBias, 0)),
      near: Math.max(0.01, num(raw.near, 0.1)),
      radius: Math.min(5, Math.max(1, num(raw.radius, 4))),
      resolution: [512, 1024, 2048, 4096].includes(num(raw.resolution, 0)) ? num(raw.resolution, 0) : 0,
    };
    light.userData.shadowCfg = cfg;
    // 阴影相机层随灯光层掩码同步（灯的 Culling Mask 同时决定哪些层
    // 的对象投影进它的阴影贴图）。three 阴影通道按 shadowCamera.layers 过滤物体，
    // 默认只收层 0 —— 不同步会让非 0 层的对象"有光无影"。
    light.shadow.camera.layers.mask = light.layers.mask;
    if (light.castShadow !== true) return;
    const isPoint = light.isPointLight === true;
    // 显式分辨率档位优先；0 = 自动（平面 2048 / 点光 1024，立方体贴图 ×6 开销降档）
    const size = cfg.resolution > 0 ? cfg.resolution : isPoint ? 1024 : 2048;
    light.shadow.mapSize.set(size, size);
    light.shadow.intensity = cfg.strength;
    light.shadow.bias = cfg.bias;
    light.shadow.radius = cfg.radius;
    if (cfg.normalBias > 0) light.shadow.normalBias = cfg.normalBias;
    if (light.isDirectionalLight !== true) {
      // 点光/聚光灯的阴影相机就在灯光位置上，near = 用户近裁剪面
      // （平行光的相机要按场景包围盒后推，near 由 player 合成，这里不写）
      light.shadow.camera.near = cfg.near;
      light.shadow.camera.updateProjectionMatrix();
    }
  }

  function wrapLight(json, kind) {
    const group = new THREE.Group();
    const color = num(json.lightColor, 0xffffff) & 0xffffff;
    const intensity = num(json.intensity, 1);
    // 灯光 Culling Mask：真实灯光对象的 layers = 掩码，
    // 渲染按"灯层 vs 相机层"收集判定 + player 分层多 pass 实现"只照亮所选层"
    const lightMask = parseCullingMask(json.cullingMask);
    let light;
    if (kind === "ambient") {
      light = new THREE.AmbientLight(color, intensity);
      light.layers.mask = lightMask;
    } else if (kind === "directional") {
      const dl = new THREE.DirectionalLight(color, intensity);
      // 平行光位置归零（three 默认 (0,1,0)）：方向 = 节点本地 -Z（与编辑器同语义）
      dl.position.set(0, 0, 0);
      dl.castShadow = json.castShadow === true;
      dl.layers.mask = lightMask;
      applyLightShadow(dl, json);
      light = dl;
    } else if (kind === "spot") {
      const sl = new THREE.SpotLight(
        color,
        intensity,
        num(json.distance, 10),
        num(json.angle, 45) * D2R,
        num(json.penumbra, 0.2),
        num(json.decay, 2),
      );
      // 聚光灯位置归零（three 默认 (0,1,0)）：方向 = 节点本地 -Z（与编辑器同语义）
      sl.position.set(0, 0, 0);
      sl.castShadow = json.castShadow === true;
      sl.layers.mask = lightMask;
      applyLightShadow(sl, json);
      light = sl;
    } else {
      const pl = new THREE.PointLight(
        color,
        intensity,
        num(json.distance, 10),
        num(json.decay, 2),
      );
      // 点光阴影：立方体阴影贴图（六个 90° 面），开销高于平面阴影，默认关
      pl.castShadow = json.castShadow === true;
      pl.layers.mask = lightMask;
      applyLightShadow(pl, json);
      light = pl;
    }
    group.add(light);
    // 方向光/聚光灯：光照方向 = 节点本地 -Z（目标点随组旋转）
    if (kind === "directional" || kind === "spot") {
      const target = new THREE.Object3D();
      target.position.set(0, 0, -1);
      group.add(target);
      light.target = target;
    }
    return group;
  }

  buildNode(rootJson, null);
  return { cameras, meshes, audios, clips, particles, terrains, nodes };
}
