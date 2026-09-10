// ---------------------------------------------------------------------------
// 灯光对象构建（core 原语）：灯光组件/灯光节点设置 → 真实 three 灯光子对象。
// 场景装配（runtime/nodes.mjs 组件模式）与脚本 SDK 门面（core/tve.mjs 运行时
// 创建/切换灯光类型）共用同一套光照语义，方向光/聚光灯方向 = 节点本地 -Z。
// 点光/平行光/聚光灯可自带阴影参数组（Unity Shadows 语义：浓度/深度偏移/
// 法线偏移/近裁剪面，扁平字段 shadowStrength/shadowBias/shadowNormalBias/shadowNear）。
// ---------------------------------------------------------------------------
import * as THREE from "./three.module.min.js";
import { num, D2R } from "./utils.mjs";

/**
 * 灯光阴影参数置位：
 * 贴图分辨率（点光 1024 / 其余 2048；three 只在首次渲染前按 mapSize 分配贴图）、
 * 浓度（shadow.intensity）、深度偏移；法线偏移 ≤0 = 自动（交给运行时贴合按纹素
 * 相对化）；近裁剪面对点光/聚光灯直接生效（平行光的阴影相机由运行时按场景包围盒
 * 后推后合成 near，这里不写）。配置留档在 light.userData.shadowCfg 供贴合读取。
 */
export function applyLightShadow(light, s) {
  const cfg = {
    strength: Math.min(1, Math.max(0, num(s.shadowStrength, 1))),
    bias: Math.min(0, Math.max(-0.05, num(s.shadowBias, -0.0005))),
    normalBias: Math.max(0, num(s.shadowNormalBias, 0)),
    near: Math.max(0.01, num(s.shadowNear, 0.1)),
    radius: Math.min(5, Math.max(1, num(s.shadowRadius, 4))),
    resolution: [512, 1024, 2048, 4096].includes(num(s.shadowResolution, 0)) ? num(s.shadowResolution, 0) : 0,
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
    // （平行光的相机由运行时按场景包围盒后推后合成 near，这里不写）
    light.shadow.camera.near = cfg.near;
    light.shadow.camera.updateProjectionMatrix();
  }
}

/** 灯光组件设置 → 节点对象下的真实灯光子对象（__compLight 组；导出供 SDK
 *  门面动态创建/切换灯光类型复用，与组件模式同一光照语义） */
export function buildComponentLight(s, obj) {
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
    // 平行光位置归零（three 默认 (0,1,0)）：光照方向 = 节点本地 -Z 的项目语义，
    // 也让运行时阴影相机沿轴后推的位移精确落在光照轴上
    dl.position.set(0, 0, 0);
    dl.castShadow = s.castShadow === true;
    applyLightShadow(dl, s);
    light = dl;
  } else if (kind === "spot") {
    const sl = new THREE.SpotLight(
      color,
      intensity,
      num(s.distance, 10),
      num(s.angle, 45) * D2R,
      num(s.penumbra, 0.2),
      num(s.decay, 2),
    );
    // 聚光灯位置归零（three 默认 (0,1,0)）：方向 = 节点本地 -Z 的项目语义
    sl.position.set(0, 0, 0);
    sl.castShadow = s.castShadow === true;
    applyLightShadow(sl, s);
    light = sl;
  } else {
    // 点光阴影：立方体阴影贴图（六个 90° 面），开销高于平面阴影，默认关
    const pl = new THREE.PointLight(color, intensity, num(s.distance, 10), num(s.decay, 2));
    pl.castShadow = s.castShadow === true;
    applyLightShadow(pl, s);
    light = pl;
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
