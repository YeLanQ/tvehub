// 场景树构建：按导出的 scene.json 递归生成 three 对象并挂到场景。
// - meshNode → createMesh（mesh.mjs）；
// - 灯光节点 → Group + 真实 Light（方向光/聚光灯附加本地 -Z 目标点；
//   点光/平行光/聚光灯可自带阴影参数组，见 applyLightShadow）；
// - cameraNode → Group（记录世界位姿供渲染相机选用）；
// - 其余 → Group；
// - 组件模式：任意节点 components 中的 light / audioSource 组件同样生效——
//   灯光组件重建灯光子对象（与灯光节点同一光照语义），音源组件并入音频绑定
//   表（组件 id 寻址；节点 id 命中首个音源，兼容 SDK 按实体播放）。
import * as THREE from "../core/three.module.min.js";
import { num, vec, D2R } from "../core/utils.mjs";
import { buildComponentLight } from "../core/lights.mjs";
import { createMesh } from "./mesh.mjs";

/**
 * 递归构建场景树（含自身/子级的变换与可见性），返回收集结果：
 * - cameras：cameraNode 列表（{ json, obj }，供渲染相机取位姿/参数）；
 * - meshes：meshNode 列表（{ json, obj }，供贴图回填/动画绑定遍历）；
 * - audios：音源列表（{ json, obj }，json.id 为音源节点 id 或音源组件 id，
 *   供音频绑定遍历；音源组件条目另带 nodeId 供按实体寻址回填）；
 * - nodes：全部节点列表（{ json, obj }，供脚本宿主/tve SDK 寻址；
 *   节点对象打 userData.nodeId/nodeTag 标记，灯光实例等内部子对象不带标记）。
 * ctx = { materialParams, models }：.mat 参数表 + 模型实例化缓存。
 */
export function buildSceneTree(rootJson, scene, ctx) {
  const cameras = [];
  const meshes = [];
  const audios = [];
  const clips = [];
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
      default:
        return new THREE.Group();
    }
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
   * 灯光阴影参数置位（与编辑器 SceneSynchronizer 同一语义，Unity Shadows 参数组）：
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
    let light;
    if (kind === "ambient") {
      light = new THREE.AmbientLight(color, intensity);
    } else if (kind === "directional") {
      const dl = new THREE.DirectionalLight(color, intensity);
      // 平行光位置归零（three 默认 (0,1,0)）：方向 = 节点本地 -Z（与编辑器同语义）
      dl.position.set(0, 0, 0);
      dl.castShadow = json.castShadow === true;
      applyLightShadow(dl, json);
      light = dl;
    } else if (kind === "spot") {
      const sl = new THREE.SpotLight(
        color,
        intensity,
        num(json.distance, 0),
        num(json.angle, 45) * D2R,
        num(json.penumbra, 0.2),
        num(json.decay, 2),
      );
      sl.castShadow = json.castShadow === true;
      applyLightShadow(sl, json);
      light = sl;
    } else {
      const pl = new THREE.PointLight(
        color,
        intensity,
        num(json.distance, 0),
        num(json.decay, 2),
      );
      // 点光阴影：立方体阴影贴图（六个 90° 面），开销高于平面阴影，默认关
      pl.castShadow = json.castShadow === true;
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
  return { cameras, meshes, audios, clips, nodes };
}
