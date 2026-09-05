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

// 材质参数兜底：与编辑器内置 internal/materials/Default.mat 一致
const MAT_DEFAULTS = { color: 0x9aa4b2, metalness: 0.1, roughness: 0.75, emissive: 0x000000, wireframe: false };

// 天空盒节点默认配色（与编辑器 SkyboxNode.DEFAULT_SKYBOX_COLORS 一致）
const SKY_DEFAULTS = { top: 0x2f6fbb, horizon: 0xcfe4f7, ground: 0x8fa2b5 };

/** 颜色：number / "#rrggbb" → number */
function matColor(v, fb) {
  if (typeof v === "number" && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v === "string") {
    const s = v.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(s)) return parseInt(s, 16) & 0xffffff;
  }
  return fb;
}

function skyHex(c) {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

function skyRgb(c) {
  const n = c & 0xffffff;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function skyRgba(c, alpha) {
  return `rgba(${skyRgb(c)}, ${alpha})`;
}

/** 程序化天空：等距柱状垂直渐变（顶=天顶 → 中=地平线 → 底=下方）+ 可选太阳，与编辑器一致 */
function makeSkyEquirectTexture(top, horizon, ground, sun) {
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, skyHex(top));
    g.addColorStop(0.5, skyHex(horizon));
    g.addColorStop(1, skyHex(ground));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    drawSkySun(ctx, w, h, sun || {});
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** 在等距柱状画布上绘制太阳（等角椭圆绘制，天空里保持正圆；与编辑器一致） */
function drawSkySun(ctx, w, h, sun) {
  const disk = sun.disk === "simple" || sun.disk === "none" ? sun.disk : "high";
  if (disk === "none") return;
  const sizeDeg = num(sun.size, 3);
  if (sizeDeg <= 0) return;
  const azDeg = ((num(sun.azimuth, 90) % 360) + 360) % 360;
  const elCycle = ((num(sun.elevation, 25) % 360) + 360) % 360;
  const effEl = (Math.asin(Math.sin((elCycle * Math.PI) / 180)) * 180) / Math.PI;
  if (effEl < 0.5) return;
  const elDeg = Math.min(89, effEl);
  const u = 0.5 + azDeg / 360;
  const col = (((u % 1) + 1) % 1) * w;
  const v = elDeg / 180 + 0.5;
  const row = (1 - v) * (h - 1);
  const rx = Math.max(0.5, (sizeDeg / 360) * w);
  const ry = Math.max(0.5, (sizeDeg / 180) * h);
  const sy = ry / rx;
  const R = rx;
  const color = matColor(sun.color, 0xffd27d);
  // 在 col 及左右 ±w 处各画一份：太阳靠近 0/1 列接缝时经 RepeatWrapping
  // 采样无缝衔接，避免 180° 方位出现分界线/半圆
  const offsets = [-w, 0, w];
  for (const ox of offsets) {
    ctx.save();
    ctx.translate(col + ox, row);
    ctx.scale(1, sy);
    if (disk === "high") {
      const glowStrength = Math.max(0, Math.min(1, num(sun.glow, 0.8)));
      if (glowStrength > 0.001) {
        const glowR = R * (0.6 + glowStrength * 2.4);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
        glow.addColorStop(0, skyRgba(color, Math.min(1, glowStrength + 0.2)));
        glow.addColorStop(0.4, skyRgba(color, glowStrength * 0.9));
        glow.addColorStop(1, skyRgba(color, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2);
      }
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.2);
      core.addColorStop(0, "rgba(255,255,255,1)");
      core.addColorStop(0.5, "rgba(255,255,255,0.9)");
      core.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = core;
      ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
    } else {
      const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      disc.addColorStop(0, skyRgba(color, 1));
      disc.addColorStop(0.82, skyRgba(color, 0.95));
      disc.addColorStop(1, skyRgba(color, 0));
      ctx.fillStyle = disc;
      ctx.fillRect(-R, -R, R * 2, R * 2);
    }
    ctx.restore();
  }
}

/** 默认立方体天空盒：六面纯色 CubeTexture（四面=地平线色，顶=天空色，底=地面色） */
function makeSkyCubeTexture(top, horizon, ground) {
  const solid = (c) => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = skyHex(c);
      ctx.fillRect(0, 0, 4, 4);
    }
    return canvas;
  };
  const side = solid(horizon);
  const up = solid(top);
  const down = solid(ground);
  const tex = new THREE.CubeTexture([side, side, up, down, side, side]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 深度优先查找首个 type=skyboxNode 且 启用且可见 的节点（与编辑器 findSkyboxNode 一致） */
function findSkyNode(json) {
  if (!json || typeof json !== "object") return null;
  if (json.type === "skyboxNode" && json.active !== false && json.visible !== false) return json;
  if (Array.isArray(json.children)) {
    for (const c of json.children) {
      const r = findSkyNode(c);
      if (r) return r;
    }
  }
  return null;
}

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

    // 材质按 .mat 资产引用解析（缺失回退默认参数）
    const m = materialParams.get(json.material) || MAT_DEFAULTS;
    const mat = new THREE.MeshStandardMaterial({
      color: m.color & 0xffffff,
      metalness: m.metalness,
      roughness: m.roughness,
      emissive: m.emissive & 0xffffff,
      wireframe: m.wireframe === true,
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

  // 材质资产：节点只保存 .mat 引用，这里先按引用预取文件并解析参数（缺失回退默认）
  const materialParams = new Map();
  {
    const refs = new Set();
    (function walkMatRefs(o) {
      if (!o || typeof o !== "object") return;
      if (o.type === "meshNode" && typeof o.material === "string" && o.material) refs.add(o.material);
      if (Array.isArray(o.children)) o.children.forEach(walkMatRefs);
    })(rootJson);
    for (const rel of refs) {
      try {
        const r = await fetch(rel);
        if (r.ok) {
          const j = await r.json();
          materialParams.set(rel, {
            color: matColor(j.color, MAT_DEFAULTS.color),
            metalness: num(j.metalness, MAT_DEFAULTS.metalness),
            roughness: num(j.roughness, MAT_DEFAULTS.roughness),
            emissive: matColor(j.emissive, MAT_DEFAULTS.emissive),
            wireframe: j.wireframe === true,
          });
        }
      } catch {
        /* 缺失材质：回退默认 */
      }
    }
  }

  buildNode(rootJson, null);

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
    }
  }
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
