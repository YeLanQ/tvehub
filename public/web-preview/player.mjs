// 网页预览运行时（独立于编辑器）：加载由编辑器导出的 scene.json / config.json，
// 用 three 把场景内容原样回放（网格/灯光/相机），作为“网页预览视图”。
// 与编辑器预览渲染的差异：无网格/辅助线/gizmo，运行在独立 iframe 页面里。
import * as THREE from "./three.module.min.js";

const app = document.getElementById("app");
const errorEl = document.getElementById("error");

/** 预览页 → 编辑器控制台转发（编辑器 WebPreviewPanel 监听 message） */
function postLog(level, text) {
  try {
    window.parent?.postMessage(
      { __editorPreviewLog: true, level, text: String(text), time: new Date().toLocaleTimeString() },
      "*",
    );
  } catch {
    /* ignore */
  }
}

function fail(msg) {
  const text = String(msg);
  if (errorEl) {
    errorEl.textContent = "预览运行失败\n\n" + text;
    errorEl.classList.add("visible");
  }
  postLog("error", text);
  console.error(text);
}

function num(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function vec(v, fb) {
  return v && typeof v === "object" ? v : fb;
}
const D2R = Math.PI / 180;

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

  const canvasCameras = [];

  /**
   * 生成单个节点的 three 对象并应用自身/子级：
   * - meshNode → Mesh（几何/材质照编辑器规则）
   * - 灯光节点 → Group + 真实 Light（方向光/聚光灯附加本地 -Z 目标点）
   * - cameraNode → Group（记录世界位姿供渲染相机选用）
   * - 其余 → Group
   */
  function buildNode(json, parent) {
    const type = json.type;
    const tr = json.transform || {};
    const obj = buildOwn(type, json);
    obj.name = json.name ?? type;
    obj.visible = json.active !== false && json.visible !== false;

    const p = vec(tr.position, { x: 0, y: 0, z: 0 });
    const r = vec(tr.rotation, { x: 0, y: 0, z: 0 });
    const s = vec(tr.scale, { x: 1, y: 1, z: 1 });
    obj.position.set(num(p.x, 0), num(p.y, 0), num(p.z, 0));
    obj.rotation.order = "XYZ";
    obj.rotation.set(num(r.x, 0) * D2R, num(r.y, 0) * D2R, num(r.z, 0) * D2R);
    obj.scale.set(num(s.x, 1), num(s.y, 1), num(s.z, 1));

    if (parent) parent.add(obj);
    else scene.add(obj);

    const children = Array.isArray(json.children) ? json.children : [];
    for (const c of children) buildNode(c, obj);

    if (type === "cameraNode") {
      canvasCameras.push({ json, obj });
    }
    return obj;
  }

  function buildOwn(type, json) {
    switch (type) {
      case "meshNode":
        return buildMesh(json);
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

  function buildMesh(json) {
    const kind = json.geometry || "box";
    const sz = vec(json.size, { x: 1, y: 1, z: 1 });
    const x = Math.max(0.01, num(sz.x, 1));
    const y = Math.max(0.01, num(sz.y, 1));
    const z = Math.max(0.01, num(sz.z, 1));
    let geom;
    if (kind === "sphere") geom = new THREE.SphereGeometry(x / 2, 32, 24);
    else if (kind === "plane") geom = new THREE.PlaneGeometry(x, z);
    else if (kind === "cylinder") geom = new THREE.CylinderGeometry(x / 2, x / 2, y, 24);
    else geom = new THREE.BoxGeometry(x, y, z);

    const mat = new THREE.MeshStandardMaterial({
      color: num(json.color, 0x9aa4b2) & 0xffffff,
      metalness: num(json.metalness, 0.1),
      roughness: num(json.roughness, 0.75),
      emissive: num(json.emissive, 0) & 0xffffff,
      wireframe: json.wireframe === true,
    });
    return new THREE.Mesh(geom, mat);
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

  buildNode(rootJson, null);
  scene.updateMatrixWorld(true);

  // ---------------------------------------------------------------- 渲染相机
  const cams = canvasCameras.filter((c) => c.json.isEditorCamera !== true);
  const pick = cams.length ? cams[0] : canvasCameras[0];
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  if (pick) {
    const j = pick.json;
    cam.fov = num(j.fov, 50);
    cam.near = Math.max(0.01, num(j.near, 0.1));
    cam.far = Math.max(num(j.far, 20), cam.near + 0.001);
    pick.obj.getWorldPosition(cam.position);
    pick.obj.getWorldQuaternion(cam.quaternion);
  } else {
    cam.position.set(7, 5, 8);
    cam.lookAt(0, 0.6, 0);
  }

  // ---------------------------------------------------------------- 渲染器
  // “显示与运行”：预览画布按项目设计分辨率取景/渲染，再按缩放模式适配 iframe
  // （noscale=原尺寸 / fixedwidth=等比宽度铺满 / fixedheight=等比高度铺满 /
  //   fixedauto=等比完整显示(留边) / full=拉伸铺满）。
  const designCfg =
    cfg.designResolution &&
    typeof cfg.designResolution === "object" &&
    cfg.designResolution.width > 0 &&
    cfg.designResolution.height > 0
      ? {
          width: Math.max(1, Math.round(cfg.designResolution.width)),
          height: Math.max(1, Math.round(cfg.designResolution.height)),
        }
      : null;
  const scaleMode =
    typeof cfg.scaleMode === "string" && cfg.scaleMode ? cfg.scaleMode : "full";
  const renderer = new THREE.WebGLRenderer({
    antialias: cfg.antiAliasing !== 0,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping =
    cfg.hdrMode === "hdr" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  app.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  // 平行光/聚光阴影范围兜底（相机朝 -Z 时 target 世界矩阵由场景更新）
  scene.traverse((o) => {
    if (o.isLight && o.castShadow) {
      o.shadow.mapSize.set(1024, 1024);
      o.shadow.bias = -0.0005;
    }
  });

  let stageW = -1;
  let stageH = -1;
  function resize() {
    const cw = Math.max(1, window.innerWidth || 1);
    const ch = Math.max(1, window.innerHeight || 1);
    if (!designCfg) {
      // 未配置设计分辨率：直接铺满窗口渲染
      if (stageW !== cw || stageH !== ch) {
        renderer.setSize(cw, ch, false);
        stageW = cw;
        stageH = ch;
      }
      cam.aspect = cw / ch;
      cam.updateProjectionMatrix();
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      return;
    }
    const dw = designCfg.width;
    const dh = designCfg.height;
    // 渲染缓冲 = 设计分辨率（相机取景比例固定为设计比例）
    if (stageW !== dw || stageH !== dh) {
      renderer.setSize(dw, dh, false);
      stageW = dw;
      stageH = dh;
    }
    cam.aspect = dw / dh;
    cam.updateProjectionMatrix();
    // CSS 层按缩放模式把设计画面适配到预览窗口
    let cssW = cw;
    let cssH = ch;
    if (scaleMode === "noscale") {
      cssW = dw;
      cssH = dh;
    } else if (scaleMode === "fixedwidth") {
      const s = cw / dw;
      cssH = dh * s;
    } else if (scaleMode === "fixedheight") {
      const s = ch / dh;
      cssW = dw * s;
    } else if (scaleMode === "fixedauto") {
      const s = Math.min(cw / dw, ch / dh);
      cssW = dw * s;
      cssH = dh * s;
    }
    // full（默认）：拉伸铺满
    canvas.style.width = `${Math.max(1, cssW)}px`;
    canvas.style.height = `${Math.max(1, cssH)}px`;
  }
  window.addEventListener("resize", resize);
  resize();

  function frame() {
    requestAnimationFrame(frame);
    renderer.render(scene, cam);
  }
  frame();

  postLog("info", "网页预览已启动（独立运行时）");
}

window.addEventListener("error", (e) => {
  fail(e.message || "未知错误");
});
main().catch(fail);
