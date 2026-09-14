// ---------------------------------------------------------------------------
// 地形笔刷绘制冒烟测试（headless，纯逻辑 + 契约段）。
// 覆盖三段：
// ① 笔刷核心：stampSplat 映射与圆形影响域 / 权重归一（总权重恒 255）/ 反复涂抹
//    收敛到目标层 / 擦除把权重转移回其余层 / stampSplatLine 沿线连续盖章；
// ② 映射一致性：像素 ↔ 世界坐标换算与 bakeColorTexture 的 UV 取样公式互逆；
// ③ 契约：地形颜色单独重烤（generate.ts 导出 bakeColorTexture / 同步器 geomSig
//    与 colorSig 拆分 + 纪元失效）、绘制控制器接线（orbit 让位 / 光标环 / 节流提交）、
//    引擎（begin/invalidate/点选抑制）、命令与 UI（editor.terrainPaint / 绘制按钮 /
//    浮动面板）、装载装配（commitTerrainPaint）、smoke:terrain-paint 登记。
// 跑法：npm run smoke:terrain-paint
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stampSplat,
  stampSplatLine,
  splatPixelToWorld,
  worldToSplatPixel,
  type SplatBuffer,
} from "../src/framework/terrain/paint";
import {
  decodeSculptData,
  encodeSculptData,
  parseTerrainSculpt,
  stampSculpt,
  stampSculptLine,
  type SculptBrush,
} from "../src/framework/terrain/sculpt";
import { bakeTerrainHeights, buildTerrain } from "../src/framework/terrain/generate";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeBuffer(w = 64, h = 64, fillLayer = 0): SplatBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + fillLayer] = 255;
  return { data, width: w, height: h };
}

function weightsAt(buf: SplatBuffer, px: number, py: number): number[] {
  const p = (py * buf.width + px) * 4;
  return [buf.data[p], buf.data[p + 1], buf.data[p + 2], buf.data[p + 3]];
}

// ===========================================================================
console.log("[1] 笔刷核心：盖章 / 归一 / 收敛 / 擦除 / 线插值");
{
  const SIZE = 64; // 世界 64m，缓冲 64px → 1px ≈ 1m
  const buf = makeBuffer(64, 64, 0);

  // 中心 (32,32) 世界 (0,0) 画层 1，半径 8m
  stampSplat(buf, SIZE, 0, 0, { layer: 1, radius: 8, strength: 1, erase: false });
  const center = weightsAt(buf, 32, 32);
  check("中心像素收敛到目标层", center[1] === 255 && center[0] < 5, JSON.stringify(center));
  const sum = center[0] + center[1] + center[2] + center[3];
  check("权重归一（总 ≈ 255）", Math.abs(sum - 255) <= 2, String(sum));

  // 影响域为圆：远端像素不受影响
  const far = weightsAt(buf, 3, 32);
  check("半径外像素不受影响", far[1] === 0 && far[0] === 255, JSON.stringify(far));
  // 边界像素部分影响（衰减平滑，无硬边跳变）
  const edge = weightsAt(buf, 25, 32);
  check("边缘存在过渡权重", edge[1] > 0 && edge[1] < 255, JSON.stringify(edge));

  // 弱强度多次涂抹 → 渐进收敛（不到 255 但高于初始）
  const buf2 = makeBuffer();
  for (let i = 0; i < 5; i++) {
    stampSplat(buf2, SIZE, 0, 0, { layer: 2, radius: 6, strength: 0.2, erase: false });
  }
  const mid = weightsAt(buf2, 32, 32);
  check("反复弱涂抹渐进收敛", mid[2] > 20 && mid[2] < 255, String(mid[2]));

  // 擦除：把已画的层 1 抹掉，剩余权重均分回其余层（其余层此前已被压到 0，
  // 无法按比例回退 → 均分是唯一无偏选择；总权重保持 255 不出黑洞）
  const buf3 = makeBuffer();
  stampSplat(buf3, SIZE, 0, 0, { layer: 1, radius: 8, strength: 1, erase: false });
  for (let i = 0; i < 12; i++) {
    stampSplat(buf3, SIZE, 0, 0, { layer: 1, radius: 8, strength: 0.6, erase: true });
  }
  const erased = weightsAt(buf3, 32, 32);
  const erasedSum = erased[0] + erased[1] + erased[2] + erased[3];
  check("擦除清空目标层且总权重保持", erased[1] < 3 && Math.abs(erasedSum - 255) <= 2,
    JSON.stringify(erased));

  // 线插值：从 (-10,0) 到 (10,0) 连续盖章 → 中途像素被覆盖
  const buf4 = makeBuffer();
  stampSplatLine(buf4, SIZE, -10, 0, 10, 0, { layer: 3, radius: 4, strength: 1, erase: false });
  check("线段中点被覆盖", weightsAt(buf4, 32, 32)[3] === 255);
  check("线段连续（中段无断触）", (() => {
    for (let px = 26; px <= 38; px++) {
      if (weightsAt(buf4, px, 32)[3] < 200) return false;
    }
    return true;
  })());
  // 线段外不受影响
  check("线段外像素不受影响", weightsAt(buf4, 32, 5)[3] === 0);

  // 世界 ↔ 像素映射互逆
  const w = worldToSplatPixel(SIZE, 64, 10.5);
  check("像素→世界换算互逆", Math.abs(splatPixelToWorld(SIZE, 64, w) - 10.5) <= 64 / 63 / 2);
}

// ===========================================================================
console.log("[2] 雕刻逻辑：抬升/压低/压平/平滑 / base64 持久化 / buildTerrain 叠加");
{
  const SIZE = 64;
  const base = bakeTerrainHeights({
    seed: 1, size: SIZE, segments: 63, heightScale: 10, frequency: 0.01, octaves: 4,
    lacunarity: 2, gain: 0.5, erosion: 0.7, warp: 0.3, valleyBias: 1.2, seaLevel: 0.1,
    talus: 1, talusPasses: 4, grassColor: 0, rockColor: 0, snowColor: 0,
  });
  const gridN = base.gridSize;
  const offsets = new Float32Array(gridN * gridN);
  const brush: SculptBrush = { mode: "raise", radius: 8, strength: 1 };

  // 地形中心 = 世界 (0,0) → 像素 (32,32)（size 64、gridN 64）
  const wx = 0, wz = 0;
  const cIdx = Math.round(worldToSplatPixel(SIZE, gridN, wx)) + Math.round(worldToSplatPixel(SIZE, gridN, wz)) * gridN;
  const before = base.heights[cIdx];
  for (let i = 0; i < 10; i++) stampSculpt(offsets, base.heights, gridN, SIZE, wx, wz, brush, 0);
  const afterRaise = before + offsets[cIdx];
  check("抬升：中心组合高度升高", afterRaise > before + 0.5, `${before.toFixed(2)} → ${afterRaise.toFixed(2)}`);

  brush.mode = "lower";
  for (let i = 0; i < 30; i++) stampSculpt(offsets, base.heights, gridN, SIZE, wx, wz, brush, 0);
  const afterLower = before + offsets[cIdx];
  check("压低：低于抬升后的高度", afterLower < afterRaise);

  // 压平：向目标高度收敛
  const flat = new Float32Array(gridN * gridN);
  const flatBrush: SculptBrush = { mode: "flatten", radius: 10, strength: 1 };
  const targetY = base.heights[0];
  for (let i = 0; i < 40; i++) stampSculptLine(flat, base.heights, gridN, SIZE, wx, wz, wx + 2, wz + 2, flatBrush, targetY);
  const flatHeight = base.heights[cIdx] + flat[cIdx];
  check("压平：向目标高度收敛", Math.abs(flatHeight - targetY) < 0.5, `${flatHeight.toFixed(2)} vs ${targetY.toFixed(2)}`);

  // 平滑：偏移方差下降（采样笔刷影响区内的像素）
  const noisy = new Float32Array(gridN * gridN);
  for (let i = 0; i < noisy.length; i++) noisy[i] = ((i % 7) - 3) * 0.5;
  const smoothBrush: SculptBrush = { mode: "smooth", radius: 12, strength: 1 };
  const varOf = (arr: Float32Array): number => {
    let s = 0;
    for (let dz = -6; dz <= 6; dz += 2) {
      for (let dx = -6; dx <= 6; dx += 2) {
        const v = arr[cIdx + dz * gridN + dx];
        s += v * v;
      }
    }
    return s;
  };
  const beforeVar = varOf(noisy);
  for (let i = 0; i < 6; i++) stampSculpt(noisy, base.heights, gridN, SIZE, wx, wz, smoothBrush, 0);
  check("平滑：偏移方差下降", varOf(noisy) < beforeVar);

  // base64 持久化往返
  const data = encodeSculptData(offsets);
  const back = decodeSculptData(data);
  check("base64 往返", !!back && back.length === offsets.length && back[cIdx] === offsets[cIdx]);
  check("parse 收敛（非法拒绝）", parseTerrainSculpt({ gridN: 1, data: "x" }) === null
    && parseTerrainSculpt(null) === null
    && parseTerrainSculpt({ gridN: gridN, data: data })?.gridN === gridN);

  // buildTerrain 叠加雕刻：几何高度 = 程序化 + 偏移
  const buildPlain = buildTerrain({
    seed: 1, size: SIZE, segments: 63, heightScale: 10, frequency: 0.01, octaves: 4,
    lacunarity: 2, gain: 0.5, erosion: 0.7, warp: 0.3, valleyBias: 1.2, seaLevel: 0.1,
    talus: 1, talusPasses: 4, grassColor: 0, rockColor: 0, snowColor: 0,
  });
  const buildSculpt = buildTerrain({
    seed: 1, size: SIZE, segments: 63, heightScale: 10, frequency: 0.01, octaves: 4,
    lacunarity: 2, gain: 0.5, erosion: 0.7, warp: 0.3, valleyBias: 1.2, seaLevel: 0.1,
    talus: 1, talusPasses: 4, grassColor: 0, rockColor: 0, snowColor: 0,
  }, null, offsets);
  const c2 = cIdx;
  check("buildTerrain 雕刻叠加（几何高度 = 程序化 + 偏移）",
    Math.abs(buildSculpt.heights[c2] - buildPlain.heights[c2] - offsets[c2]) < 1e-4
      && Math.abs(offsets[c2]) > 0.4,
    `delta=${(buildSculpt.heights[c2] - buildPlain.heights[c2]).toFixed(3)} off=${offsets[c2].toFixed(3)}`);
  buildPlain.geometry.dispose();
  buildPlain.colorTexture.dispose();
  buildSculpt.geometry.dispose();
  buildSculpt.colorTexture.dispose();

  // TerrainNode sculpt 序列化往返 + 旧场景兼容
  const registry = createDefaultRegistry();
  const sculptNode = registry.create("terrainNode");
  sculptNode.sculpt = { gridN, data };
  const sculptBack = registry.createFromJSON(JSON.parse(JSON.stringify(sculptNode.toJSON())));
  check("TerrainNode sculpt 往返", sculptBack.sculpt?.gridN === gridN && sculptBack.sculpt.data === data);
  const legacy = registry.createFromJSON({ type: "terrainNode", id: "t1" });
  check("旧场景无 sculpt 兼容", legacy.sculpt === null);
  check("未雕刻不写入 JSON（字节兼容）", !("sculpt" in legacy.toJSON()));
}

// ===========================================================================
console.log("[3] 映射一致性：与 bakeColorTexture 取样公式同基准");
{
  // bakeColorTexture：su = wx/size + 0.5；sx = round(su*(width-1)) —— 与 worldToSplatPixel 一致
  const size = 200, width = 129;
  let ok = true;
  for (const wx of [-100, -50, 0, 33, 99.9]) {
    const su = Math.min(1, Math.max(0, wx / size + 0.5));
    const sx = Math.round(su * (width - 1));
    if (sx !== worldToSplatPixel(size, width, wx)) ok = false;
  }
  check("像素映射与 splatmap 采样公式一致", ok);
}

// ===========================================================================
console.log("[4] 契约：重烤链路 / 控制器 / 引擎 / 命令与 UI / 装配");
{
  const gen = readFileSync(resolve(process.cwd(), "src/framework/terrain/generate.ts"), "utf8");
  check("generate.ts 导出 bakeColorTexture（颜色单独重烤）", /export function bakeColorTexture/.test(gen));

  const paint = readFileSync(resolve(process.cwd(), "src/framework/terrain/paint.ts"), "utf8");
  check("笔刷纯逻辑模块存在", /export function stampSplat\b/.test(paint) && /export function stampSplatLine/.test(paint));

  const sync = readFileSync(resolve(process.cwd(), "src/framework/engine/modules/SceneSynchronizer.ts"), "utf8");
  check("同步器：几何签名与颜色签名拆分", /const geomSig = terrainSettingsSig/.test(sync)
    && /const colorSig = /.test(sync) && /splatmapEpoch/.test(sync));
  check("同步器：仅重烤颜色分支（几何不动）", /仅重烤颜色纹理/.test(sync) && /bakeColorTexture\(heights, gridN/.test(sync));
  check("同步器：splatmap 数据获取 / 纪元 / 缓存清理", /ensureSplatmapData/.test(sync)
    && /bumpSplatmapEpoch/.test(sync) && /clearSplatCache/.test(sync));

  const ctrl = readFileSync(resolve(process.cwd(), "src/framework/engine/modules/TerrainPaintController.ts"), "utf8");
  check("控制器：orbit 左键让位 + 光标环 + 节流提交", /mouseButtons = \{ LEFT: null/.test(ctrl)
    && /__terrainPaintCursor/.test(ctrl) && /COMMIT_INTERVAL_MS/.test(ctrl));
  check("控制器：双会话分发（绘制层 / 雕刻）", /kind === "paint"/.test(ctrl) && /stampSculptLine/.test(ctrl)
    && /onCommitSculpt/.test(ctrl) && /onCommitSplat/.test(ctrl));

  const engineSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/EditorEngine.ts"), "utf8");
  check("引擎：开始/结束/失效 + 点选抑制", /async beginTerrainPaint/.test(engineSrc)
    && /endTerrainPaint/.test(engineSrc) && /invalidateTerrainSplatmap/.test(engineSrc)
    && /this\.terrainPaint\?\.active/.test(engineSrc));
  check("引擎：落盘回调装配点", /setTerrainPaintCommitHandler/.test(engineSrc));
  check("引擎：雕刻提交走节点补丁（可撤销）", /commitTerrainSculpt/.test(engineSrc)
    && /雕刻地形/.test(engineSrc) && /bakeTerrainHeights/.test(engineSrc));

  const nodeSrc = readFileSync(resolve(process.cwd(), "src/framework/prototype/nodes/TerrainNode.ts"), "utf8");
  check("节点：sculpt 字段持久化（空值不写盘）", /target\.sculpt = \{ \.\.\.this\.sculpt \}/.test(nodeSrc)
    && /parseTerrainSculpt\(source\.sculpt\)/.test(nodeSrc));

  const vp = readFileSync(resolve(process.cwd(), "src/app/components/Viewport.vue"), "utf8");
  check("视口：绘制按钮 + 浮动笔刷面板", /terrainPaintActive/.test(vp) && /paint-panel/.test(vp)
    && /setTerrainPaintBrush/.test(vp));
  check("视口：雕刻模式按钮（抬升/压低/压平/平滑）", /sculptMode/.test(vp) && /抬升/.test(vp) && /压平/.test(vp));

  const cmd = readFileSync(resolve(process.cwd(), "src/app/commands/editorCommands.ts"), "utf8");
  check("命令：editor.terrainPaint + gizmo 绘制期守卫", /id: "editor.terrainPaint"/.test(cmd)
    && /terrainPaintActive\) return \{ set: false \}/.test(cmd));

  const service = readFileSync(resolve(process.cwd(), "src/app/services/editorService.ts"), "utf8");
  check("装配：绘制落盘（编码 PNG → 写资产 → 失效重载）", /commitTerrainPaint/.test(service)
    && /encodeSplatBufferPng/.test(service) && /writeAssetBinary/.test(service));

  const store = readFileSync(resolve(process.cwd(), "src/app/stores/editor.ts"), "utf8");
  check("store：绘制状态与层色", /terrainPaintActive/.test(store) && /terrainPaintLayers/.test(store));

  const pkg = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
  check("smoke:terrain-paint 脚本已登记", /"smoke:terrain-paint"/.test(pkg));
}

// ===========================================================================
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
