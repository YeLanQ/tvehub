// ---------------------------------------------------------------------------
// 层级系统「网页运行时」冒烟（Node 直接运行，不经打包）：
// 用导出的 scene.json 片段喂给 public/engine/runtime 的构建链路，验证
//   ① meshNode layer 打层（根对象 + userData.nodeLayer，子树内容跟随）；
//   ② 灯光节点：包装组随节点层、真实灯光对象 layers = cullingMask、
//     阴影相机层同步、缺省 cullingMask = 全部层；
//   ③ 灯光组件 cullingMask 同语义；
//   ④ 相机节点 cullingMask → 渲染相机 layers.mask；无相机回退全层；
//   ⑤ 分层多 pass：layerPassBits 决策与 renderLayerPasses 门控（运行时镜像）。
// 运行：npm run smoke:layers-runtime
// ---------------------------------------------------------------------------
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const root = resolve(import.meta.dirname, "..");
const runtime = (rel) => pathToFileURL(resolve(root, "public/engine/runtime", rel)).href;
const core = (rel) => pathToFileURL(resolve(root, "public/engine/core", rel)).href;

const { buildSceneTree } = await import(runtime("nodes.mjs"));
const { layerPassBits, renderLayerPasses, populatedLayerBits } = await import(
  runtime("layerpass.mjs")
);
const THREE = await import(core("three.module.min.js"));

console.log("[1] meshNode / 普通节点 layer 打层");
const scene = new THREE.Scene();
const sceneJson = {
  type: "node",
  id: "root",
  name: "Root",
  children: [
    {
      type: "meshNode",
      id: "m1",
      name: "Box",
      layer: 2,
      geometry: "box",
      size: { x: 2, y: 2, z: 2 },
      transform: { position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    },
    {
      type: "meshNode",
      id: "m2",
      name: "BadLayer",
      layer: 99,
      geometry: "box",
      size: { x: 1, y: 1, z: 1 },
    },
  ],
};
const built = buildSceneTree(sceneJson, scene, { materialParams: new Map(), models: new Map() });
const nodeOf = (id) => built.nodes.find((n) => n.json.id === id)?.obj ?? null;
const box = nodeOf("m1");
ok(box?.layers.mask === (1 << 2), "meshNode layer=2 → layers.mask = 1<<2");
ok(box?.userData.nodeLayer === 2, "userData.nodeLayer 标记（SDK Entity.layer 读取用）");
ok(nodeOf("m2")?.layers.mask === 1, "非法层索引收敛回 0");

console.log("[2] 灯光节点 cullingMask → 真实灯光对象 + 阴影相机");
const lightScene = new THREE.Scene();
const lightJson = {
  type: "node",
  id: "root2",
  children: [
    {
      type: "pointLightNode",
      id: "pl",
      name: "PL",
      layer: 1,
      cullingMask: (1 << 1) | (1 << 2),
      castShadow: true,
      intensity: 1,
    },
    { type: "ambientLightNode", id: "al", name: "AL", intensity: 0.2 },
  ],
};
const built2 = buildSceneTree(lightJson, lightScene, { materialParams: new Map(), models: new Map() });
const pl = built2.nodes.find((n) => n.json.id === "pl")?.obj;
const plGroup = pl;
const plLight = (() => {
  let hit = null;
  pl.traverse((o) => {
    if (!hit && o.isLight) hit = o;
  });
  return hit;
})();
ok(plGroup.layers.mask === (1 << 1), "灯光包装组随节点层（layer=1）");
ok(plLight?.layers.mask === ((1 << 1) | (1 << 2)), "真实灯光对象 layers = cullingMask");
ok(plLight?.shadow.camera.layers.mask === ((1 << 1) | (1 << 2)), "阴影相机层同步（非 0 层有影）");
const al = built2.nodes.find((n) => n.json.id === "al")?.obj;
const alLight = (() => {
  let hit = null;
  al.traverse((o) => {
    if (!hit && o.isLight) hit = o;
  });
  return hit;
})();
ok(alLight?.layers.mask === -1, "缺省 cullingMask = 全部层（-1）");

console.log("[3] 灯光组件 cullingMask");
const compScene = new THREE.Scene();
const compJson = {
  type: "node",
  id: "host",
  layer: 3,
  components: [
    { id: "c1", type: "light", enabled: true, light: { kind: "point", cullingMask: 1 << 4 } },
  ],
};
const built3 = buildSceneTree(compJson, compScene, { materialParams: new Map(), models: new Map() });
const hostObj = built3.nodes[0].obj;
let compLight = null;
hostObj.traverse((o) => {
  if (!compLight && o.isLight) compLight = o;
});
ok(hostObj.layers.mask === (1 << 3), "宿主节点层保持（layer=3）");
ok(compLight?.layers.mask === (1 << 4), "灯光组件内层灯光 layers = cullingMask");

console.log("[4] 渲染相机 cullingMask");
const { createRenderCamera } = await import(runtime("camera.mjs"));
const camScene = new THREE.Scene();
const camJson = {
  type: "node",
  id: "root4",
  children: [
    { type: "cameraNode", id: "cam", name: "Cam", cullingMask: (1 << 1) | (1 << 3) },
    { type: "cameraNode", id: "nomask", name: "NoMask" },
  ],
};
const built4 = buildSceneTree(camJson, camScene, { materialParams: new Map(), models: new Map() });
const masked = createRenderCamera(built4.cameras.slice(0, 1));
ok(masked.cam.layers.mask === ((1 << 1) | (1 << 3)), "相机节点 cullingMask → cam.layers.mask");
const noMask = createRenderCamera([{ json: built4.cameras[1].json, obj: built4.cameras[1].obj }]);
ok(noMask.cam.layers.mask === -1, "缺省 cullingMask → 全部层");

console.log("[5] 分层多 pass（运行时镜像 layerpass.mjs）");
const ps = new THREE.Scene();
const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
a.layers.set(0);
const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
b.layers.set(2);
const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
hidden.layers.set(9);
hidden.visible = false;
ps.add(a, b, hidden);
ok(populatedLayerBits(ps) === (1 | (1 << 2)), "populatedLayerBits 只计可见可渲染体");
const pc = new THREE.PerspectiveCamera();
ok(layerPassBits(ps, pc) === null, "掩码全开 → 单 pass");
pc.layers.mask = (1 << 2) | 1;
const bits = layerPassBits(ps, pc);
ok(JSON.stringify(bits) === JSON.stringify([1, 1 << 2]), "多层占用 → 升序单层位列表");
const calls = [];
const fakeRenderer = {
  autoClearColor: true,
  autoClearDepth: true,
  render(s, camera) {
    calls.push({ mask: camera.layers.mask, clearColor: this.autoClearColor });
  },
};
const sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
sky.userData.skyOnlyFirstPass = true;
ps.add(sky);
renderLayerPasses(fakeRenderer, ps, pc, bits);
ok(
  calls.length === 2 &&
    calls[0].mask === 1 &&
    calls[0].clearColor &&
    calls[1].mask === (1 << 2) &&
    !calls[1].clearColor,
  "多 pass 调用序列：首 pass 全清、后续不清屏",
);
ok(
  pc.layers.mask === ((1 << 2) | 1) && fakeRenderer.autoClearColor && sky.visible,
  "多 pass 后恢复相机层/清屏标志/天空面",
);
// 相机掩码全开 + 部分掩码灯光：灯光 Culling Mask 恒生效（Unity 语义）
const maskedLight = new THREE.PointLight();
maskedLight.layers.mask = 1;
ps.add(maskedLight);
pc.layers.enableAll(); // three 默认 mask=1（仅层 0），显式全开
ok(
  JSON.stringify(layerPassBits(ps, pc)) === JSON.stringify([1, 1 << 2]),
  "掩码全开 + 部分掩码灯光 + 多层占用 → 按在用层拆分",
);
maskedLight.layers.mask = -1;
ok(layerPassBits(ps, pc) === null, "掩码全开 + 全层灯光 → 单 pass（零开销）");

console.log(failed === 0 ? `\n全部 ${passed} 项通过` : `\n${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
