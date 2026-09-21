// ---------------------------------------------------------------------------
// @priority P0
// 网页运行时模块「链接检查」冒烟（Node 直接运行，不需 GPU）：
// 逐个 import public/engine/** 下的运行时模块，验证它们能真正被链接 ——
// 语法检查（node --check）只查语法，**命名导出缺失/拼写不符是链接期错误**，
// 只有实际 import 才会暴露（曾发生：particles.mjs 未导出 FADE_OUT_FRACTION，
// 导致 particleNodeMaterial.mjs 整体加载失败，WebGPU 下粒子静默不可见）。
//
// 跳过项：
// - physics-engines/**：按后端可选打包的 WASM 引擎，需环境支持（各自有冒烟套件）；
// - 需要 DOM 才能 import 的模块（player.mjs 等）：浏览器入口，非本检查目标。
// 运行：pnpm smoke runtime-modules
// ---------------------------------------------------------------------------
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, relative, dirname, join, normalize } from "node:path";
import { createSuite, installDomShim } from "../harness.mjs";

const { ok, finish } = createSuite();

const root = resolve(import.meta.dirname, "..", "..", "..");
const engineDir = resolve(root, "public/engine");

/** 递归收集 .mjs/.js 模块（跳过按后端可选打包的物理引擎目录） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "physics-engines") continue;
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

// 最小 DOM 垫片：部分运行时模块在导入期访问 window/document（事件监听、兼容分支）
const listeners = new Set();
installDomShim();

const files = collect(engineDir).sort();
console.log(`[1] 运行时模块链接（${files.length} 个模块）`);
const broken = [];
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, "/");
  try {
    await import(pathToFileURL(file).href);
    ok(true, rel);
  } catch (e) {
    const msg = e?.message ?? String(e);
    broken.push(`${rel}: ${msg}`);
    ok(false, `${rel} — ${msg.split("\n")[0]}`);
  }
}

console.log("[2] 后端相关模块的导出面（WebGPU 装配所需）");
{
  const particles = await import(pathToFileURL(resolve(engineDir, "core/particles.mjs")).href);
  ok(typeof particles.createGlslParticleMaterial === "function", "core/particles.mjs 导出 GLSL 材质工厂");
  ok(typeof particles.FADE_OUT_FRACTION === "number", "core/particles.mjs 导出 FADE_OUT_FRACTION（TSL 实现共用）");
  ok(typeof particles.getParticleSpriteTexture === "function", "core/particles.mjs 导出内置软圆点贴图");
  ok(typeof particles.PARTICLES_CHILD_NAME === "string", "core/particles.mjs 导出实例网格子对象名");

  const nodeMat = await import(pathToFileURL(resolve(engineDir, "core/particleNodeMaterial.mjs")).href);
  ok(typeof nodeMat.createNodeParticleMaterialFactory === "function", "core/particleNodeMaterial.mjs 导出 TSL 工厂");
  const factory = nodeMat.createNodeParticleMaterialFactory();
  ok(typeof factory === "function", "TSL 工厂可构造（three 的 WebGPU 构建含 SpriteNodeMaterial + TSL）");
  if (typeof factory === "function") {
    let built = null;
    let err = "";
    try {
      built = factory({ startSize: 0.4, colorOverLifetime: true, sizeOverLifetime: true, blending: "additive" });
    } catch (e) {
      err = e?.message ?? String(e);
    }
    ok(!!built && !err, `TSL 粒子材质可构造（headless）${err ? " — " + err : ""}`);
    if (built) {
      const mat = built.material;
      ok(mat.isSpriteNodeMaterial === true, "材质为 SpriteNodeMaterial（three 自身在 WebGPU 下渲染精灵的路径）");
      ok(mat.positionNode !== null && mat.scaleNode !== null && mat.colorNode !== null, "positionNode / scaleNode / colorNode 均已装配");
      ok(mat.transparent === true && mat.depthWrite === false, "透明 + 不写深度（与 GLSL 版一致）");
      built.setSettings({ startSize: 1.5, colorOverLifetime: false, sizeOverLifetime: false, blending: "additive" });
      ok(true, "setSettings 可写（参数更新不重建材质）");
      built.setTexture(null);
      ok(true, "setTexture(null) 可写（回内置软圆点）");
      built.dispose();
    }
  }

  const stage = await import(pathToFileURL(resolve(engineDir, "runtime/stage.mjs")).href);
  ok(typeof stage.createRenderer === "function" && typeof stage.createStage === "function", "runtime/stage.mjs 导出 createRenderer / createStage");
  const nodes = await import(pathToFileURL(resolve(engineDir, "runtime/nodes.mjs")).href);
  ok(typeof nodes.buildSceneTree === "function", "runtime/nodes.mjs 导出 buildSceneTree");
  const rtParticles = await import(pathToFileURL(resolve(engineDir, "runtime/particles.mjs")).href);
  ok(typeof rtParticles.createParticles === "function", "runtime/particles.mjs 导出 createParticles");
}

console.log("[3] 导入闭包：运行时模块的静态导入都在服务清单内");
{
  // 预览/导出只服务清单里的文件；某个模块 import 了清单外的文件 → 预览服务返回
  // HTML 404 → 浏览器报 "Unexpected token '<'"（曾发生：新增翻译器后清单未跟上）
  const genText = readFileSync(resolve(root, "src/generated/web-preview-files.ts"), "utf8");
  const group = (name) => {
    const m = new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(genText);
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const served = new Set([
    ...group("WEB_PREVIEW_RUNTIME_FILES"),
    ...group("WEB_PREVIEW_WEBGPU_FILES"),
    ...[...genText.matchAll(/"([^"]*physics-engines[^"]*)"/g)].map((m) => m[1]),
  ]);
  const missing = [];
  for (const rel of served) {
    // 清单键：web-preview 入口（index.html/player.mjs）相对 public/web-preview，
    // engine/** 相对 public；解析 import 时按各自基目录换算回清单键
    const inWebPreview = !rel.startsWith("engine/");
    const abs = resolve(root, inWebPreview ? "public/web-preview" : "public", rel);
    if (!existsSync(abs)) {
      missing.push(`${rel}（清单项在磁盘上不存在）`);
      continue;
    }
    const baseDir = inWebPreview ? "web-preview" : "";
    for (const m of readFileSync(abs, "utf8").matchAll(/from\s*["'](\.[^"']+)["']/g)) {
      let target = normalize(join(baseDir, dirname(rel), m[1])).split("\\").join("/");
      if (target.startsWith("web-preview/")) target = target.slice("web-preview/".length);
      if (!served.has(target)) missing.push(`${rel} → ${target}`);
    }
  }
  ok(missing.length === 0, `清单覆盖全部导入（${served.size} 个文件）${missing.length ? "：" + missing.join("；") : ""}`);
}

finish();
if (broken.length) console.error("链接失败的模块：\n  " + broken.join("\n  "));
