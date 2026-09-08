// 场景树构建：按导出的 scene.json 递归生成 three 对象并挂到场景。
// - meshNode → createMesh（mesh.mjs）；
// - 灯光节点 → Group + 真实 Light（方向光/聚光灯附加本地 -Z 目标点）；
// - cameraNode → Group（记录世界位姿供渲染相机选用）；
// - 其余 → Group；
// - 组件模式：任意节点 components 中的 light / audioSource 组件同样生效——
//   灯光组件重建灯光子对象（与灯光节点同一光照语义），音源组件并入音频绑定
//   表（组件 id 寻址；节点 id 命中首个音源，兼容 SDK 按实体播放）。
import * as THREE from "./three.module.min.js";
import { num, vec, D2R } from "./utils.mjs";
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

    // 组件模式：灯光/音源组件（启用中的才生效）
    const comps = Array.isArray(json.components) ? json.components : [];
    for (const c of comps) {
      if (!c || typeof c !== "object" || c.enabled === false) continue;
      if (c.type === "light") {
        buildComponentLight(c.light || {}, obj);
      } else if (c.type === "audioSource") {
        audios.push({ json: { id: c.id, audio: c.audio }, obj, nodeId: json.id });
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

  function wrapLight(json, kind) {
    const group = new THREE.Group();
    const color = num(json.lightColor, 0xffffff) & 0xffffff;
    const intensity = num(json.intensity, 1);
    let light;
    if (kind === "ambient") {
      light = new THREE.AmbientLight(color, intensity);
    } else if (kind === "directional") {
      const dl = new THREE.DirectionalLight(color, intensity);
      dl.castShadow = json.castShadow === true;
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
      light = sl;
    } else {
      light = new THREE.PointLight(
        color,
        intensity,
        num(json.distance, 0),
        num(json.decay, 2),
      );
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

  /** 灯光组件 → 节点对象下的真实灯光子对象（设置形状与灯光组件序列化同构） */
  function buildComponentLight(s, obj) {
    const kind = typeof s.kind === "string" ? s.kind : "point";
    const color = num(s.lightColor, 0xffffff) & 0xffffff;
    const intensity = num(s.intensity, 1);
    const group = new THREE.Group();
    group.name = "__compLight";
    let light;
    if (kind === "ambient") {
      light = new THREE.AmbientLight(color, intensity);
    } else if (kind === "directional") {
      const dl = new THREE.DirectionalLight(color, intensity);
      dl.castShadow = s.castShadow === true;
      light = dl;
    } else if (kind === "spot") {
      const sl = new THREE.SpotLight(
        color,
        intensity,
        num(s.distance, 0),
        num(s.angle, 45) * D2R,
        num(s.penumbra, 0.2),
        num(s.decay, 2),
      );
      sl.castShadow = s.castShadow === true;
      light = sl;
    } else {
      light = new THREE.PointLight(color, intensity, num(s.distance, 0), num(s.decay, 2));
    }
    group.add(light);
    if (kind === "directional" || kind === "spot") {
      const target = new THREE.Object3D();
      target.position.set(0, 0, -1);
      group.add(target);
      light.target = target;
    }
    obj.add(group);
  }

  buildNode(rootJson, null);
  return { cameras, meshes, audios, nodes };
}
