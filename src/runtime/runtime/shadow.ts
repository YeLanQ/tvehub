// ---------------------------------------------------------------------------
// 阴影相机贴合（player 侧）：与编辑器 SceneSynchronizer.refitShadowCameras 同一语义。
//
// 灯光建出时只写了静态参数（贴图分辨率/浓度/偏移；见 nodes.ts / core/lights.ts），
// normalBias ≤ 0 的「自动档」依赖贴合逻辑兑现——没有贴合时 normalBias 恒为 0，
// 阴影贴图深度量化不配法线偏移，受光面出现整面自阴影条纹（shadow acne 摩尔纹）。
//
// 每帧调用 refitShadowCameras(scene)：
// - 每 REFIT_INTERVAL 帧贴合一次（脚本/动画/物理驱动的位姿变化随之跟进）；
// - 首次调用立即生效（等价编辑器加载完成时的 force）；
// - 平行光沿光照轴后推阴影相机（本地 +Z 增量单调，不破坏已推好的位置），
//   正交范围贴合场景包围盒；点光/聚光灯按灯型合成 far 与纹素尺度；
// - 自动 normalBias = 纹素 ×1.2，夹在 [0.0005, radius×0.1]（与编辑器同一公式）。
// ---------------------------------------------------------------------------
import * as THREE from "../core/three.module.min.js";

const REFIT_INTERVAL = 20;
// 自动法线偏移的纹素倍数：掠射光（光源与对象齐平）下受光面的深度斜率大，
// 压不住自阴影时会呈「百叶窗」条纹（拖动光源时纹素网格扫过表面）；
// 3 纹素可覆盖常见掠射角，代价是阴影边缘轻微内缩（peter-panning 可忽略）
const NORMAL_BIAS_TEXELS = 3;
const DEFAULT_MAP_SIZE = 4096;

let frameCount = 0;
let started = false;

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _toCenter = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _tmpBox = new THREE.Box3();

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 场景投影包围盒：全部可见网格的世界包围盒并集（隐藏对象与其子树不参与） */
function sceneBounds(scene) {
  _box.makeEmpty();
  scene.traverse((o) => {
    if (!o.visible) return;
    if (o.isMesh !== true || !o.geometry) return;
    const geom = o.geometry;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return;
    _tmpBox.copy(geom.boundingBox).applyMatrix4(o.matrixWorld);
    _box.union(_tmpBox);
  });
  return _box.isEmpty() ? null : _box;
}

/** 单灯贴合：按灯型设置阴影相机 near/far/正交范围，并兑现自动 normalBias */
function fitShadowCamera(light, bounds) {
  const cfg = light.userData && typeof light.userData.shadowCfg === "object" ? light.userData.shadowCfg : {};
  const near = Math.max(0.01, num(cfg.near, 0.1));
  const normalBias = Math.max(0, num(cfg.normalBias, 0));
  const radius = Math.min(5, Math.max(1, num(cfg.radius, 4)));
  const center = bounds.getCenter(_center);
  const reachRadius = Math.max(bounds.getSize(_size).length() / 2, 0.05);
  const shadow = light.shadow;
  const isDir = light.isDirectionalLight === true;
  const isPoint = light.isPointLight === true;
  let autoBiasExtent;

  if (isPoint) {
    // 点光：立方体阴影相机挂在灯光位置，far 取「灯光到场景包围盒最远角落」
    // （distance>0 时光照在该距离截止，直接用）
    _origin.setFromMatrixPosition(light.matrixWorld);
    let far = light.distance > 0 ? light.distance : 1;
    if (light.distance <= 0) {
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sy = -1; sy <= 1; sy += 2) {
          for (let sz = -1; sz <= 1; sz += 2) {
            _corner.set(
              center.x + sx * reachRadius,
              center.y + sy * reachRadius,
              center.z + sz * reachRadius,
            );
            far = Math.max(far, _corner.distanceTo(_origin));
          }
        }
      }
    }
    shadow.camera.near = near;
    shadow.camera.far = far;
    shadow.camera.updateProjectionMatrix();
    autoBiasExtent = far; // 90° 面在深度 d 处的世界宽度 ≈ 2d
  } else if (!isDir) {
    // 聚光灯：视锥由 angle 决定，near = 用户近裁剪面，far 推到覆盖场景
    _origin.setFromMatrixPosition(light.matrixWorld);
    _target.setFromMatrixPosition(light.target.matrixWorld);
    _axis.copy(_target).sub(_origin);
    if (_axis.lengthSq() < 1e-8) _axis.set(0, -1, 0);
    _axis.normalize();
    const along = _toCenter.copy(center).sub(_origin).dot(_axis);
    const perpSq = Math.max(_toCenter.lengthSq() - along * along, 0);
    const reach = reachRadius + Math.sqrt(perpSq);
    const fitFar = Math.max(along + reach, 1);
    shadow.camera.near = near;
    shadow.camera.far = light.distance > 0 ? Math.min(light.distance, fitFar) : fitFar;
    shadow.camera.updateProjectionMatrix();
    // 视锥在远平面处的世界宽度决定纹素粗细
    const halfAngle = Math.max(light.angle, 0.01);
    autoBiasExtent = 2 * Math.tan(halfAngle) * shadow.camera.far;
  } else {
    // 平行光：阴影相机沿视轴后推，保证整个场景在相机前方。three 把阴影相机放在
    // 灯光世界位置，方向只用 position − target，所以在灯光本地沿 +Z 后退是安全的
    // （灯"站"在场景里时，近平面会把近侧物体的阴影整片裁掉）。缺口只补不退：
    // 重复 refit 不来回挪灯。
    _origin.setFromMatrixPosition(light.matrixWorld);
    _target.setFromMatrixPosition(light.target.matrixWorld);
    _axis.copy(_target).sub(_origin);
    if (_axis.lengthSq() < 1e-8) _axis.set(0, -1, 0);
    _axis.normalize();
    const along = _toCenter.copy(center).sub(_origin).dot(_axis);
    const perpSq = Math.max(_toCenter.lengthSq() - along * along, 0);
    const reach = reachRadius + Math.sqrt(perpSq);
    const deficit = reach + 0.05 - along;
    if (deficit > 1e-4) {
      light.position.z += deficit;
      light.updateWorldMatrix(true, false);
    }
    const alongFinal = deficit > 1e-4 ? reach + 0.05 : along;
    const cam = shadow.camera;
    cam.near = Math.max(alongFinal - reach + near, 0.01);
    cam.far = Math.max(alongFinal + reach, cam.near + 0.1);
    // 正交范围沿灯光右/上轴做紧凑投影（8 个包围盒角落 → 灯光轴），比包围球
    // 半径的方形范围显著收紧——同分辨率下纹素更细，阴影边缘锯齿更轻
    _origin.setFromMatrixPosition(light.matrixWorld);
    const e = light.matrixWorld.elements;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (
      const [cx, cy, cz] of [
        [bounds.min.x, bounds.min.y, bounds.min.z],
        [bounds.max.x, bounds.min.y, bounds.min.z],
        [bounds.min.x, bounds.max.y, bounds.min.z],
        [bounds.max.x, bounds.max.y, bounds.min.z],
        [bounds.min.x, bounds.min.y, bounds.max.z],
        [bounds.max.x, bounds.min.y, bounds.max.z],
        [bounds.min.x, bounds.max.y, bounds.max.z],
        [bounds.max.x, bounds.max.y, bounds.max.z],
      ]
    ) {
      const dx = cx - _origin.x;
      const dy = cy - _origin.y;
      const dz = cz - _origin.z;
      const px = dx * e[0] + dy * e[1] + dz * e[2];
      const py = dx * e[4] + dy * e[5] + dz * e[6];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    cam.left = minX;
    cam.right = maxX;
    cam.top = maxY;
    cam.bottom = minY;
    cam.updateProjectionMatrix();
    autoBiasExtent = Math.max(maxX - minX, maxY - minY);
  }

  // 自动法线偏移（用户未设 >0 时）：按阴影贴图纹素相对化——范围越大纹素越粗
  if (normalBias <= 0) {
    const mapSize = shadow.mapSize.width || DEFAULT_MAP_SIZE;
    const texel = autoBiasExtent / mapSize;
    shadow.normalBias = Math.min(
      Math.max(texel * NORMAL_BIAS_TEXELS, 0.0005),
      Math.max(radius * 0.1, 0.001),
    );
  }
}

/**
 * 帧循环调用：把启用阴影的灯光阴影相机贴合到场景包围盒（含自动 normalBias）。
 * @param force 忽略帧节拍立即重算
 */
export function refitShadowCameras(scene, force = false) {
  if (!started) {
    started = true;
    force = true;
  }
  if (!force && ++frameCount < REFIT_INTERVAL) return;
  frameCount = 0;
  const lights = [];
  scene.traverse((o) => {
    if (
      o.castShadow === true &&
      (o.isDirectionalLight === true || o.isSpotLight === true || o.isPointLight === true)
    ) {
      lights.push(o);
    }
  });
  if (!lights.length) return;
  // 世界矩阵先推进到当前状态：包围盒与灯光视轴都按它取值
  scene.updateMatrixWorld(true);
  const bounds = sceneBounds(scene);
  if (!bounds) return;
  for (const l of lights) fitShadowCamera(l, bounds);
}
