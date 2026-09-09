// ---------------------------------------------------------------------------
// 灯光对象构建（core 原语）：灯光组件/灯光节点设置 → 真实 three 灯光子对象。
// 场景装配（runtime/nodes.mjs 组件模式）与脚本 SDK 门面（core/tve.mjs 运行时
// 创建/切换灯光类型）共用同一套光照语义，方向光/聚光灯方向 = 节点本地 -Z。
// ---------------------------------------------------------------------------
import * as THREE from "./three.module.min.js";
import { num, D2R } from "./utils.mjs";

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
