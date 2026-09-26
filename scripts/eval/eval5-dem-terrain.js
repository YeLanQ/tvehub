// 评测⑤：DEM 数字地形数据源——合成 ASC 高程导入 → 编辑器烘焙 → 运行时产物一致性 + 碰撞贴合
(async () => {
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    return hit || ('http://localhost:1420' + needle);
  };
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const store = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore();
  const engine = store.engine;
  const demMod = await import(vurl('/src/framework/terrain/dem.ts'));
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // 清场 + 建地形
  engine.graph.removeNodes(engine.graph.all().map((n) => n.id));
  const t = await run('node.add', { kind: 'terrain', name: 'DEM 验证地形' });
  const tid = t?.id ?? t;
  const nodeJson = (id) => {
    const n = engine.graph.get(id);
    return n ? n.toJSON() : null;
  };
  const patch = async (id, mut) => {
    const before = nodeJson(id);
    const after = JSON.parse(JSON.stringify(before));
    mut(after);
    engine.patchNode(id, before, after, 'DEM 评测');
  };
  await patch(tid, (n) => Object.assign(n.terrain, { seed: 3, size: 200, segments: 64, heightScale: 30, talusPasses: 0 }));

  // 合成 64×64 西低东高斜坡 ASC（DLG/DEM 常见交换格式）
  const S = 64;
  const rows = [];
  for (let r = 0; r < S; r++) rows.push(Array.from({ length: S }, (_, c) => c * 10).join(' '));
  const NL = String.fromCharCode(10);
  const asc = ['ncols ' + S, 'nrows ' + S, 'xllcorner 0', 'yllcorner 0', 'cellsize 1', 'nodata_value -9999'].join(NL) + NL + rows.join(NL);
  const dem = demMod.importDemFile('ramp-west-east.asc', '.asc', () => asc, () => new ArrayBuffer(0));
  out.demMeta = { format: dem.format, gridN: dem.gridN, src: `${dem.sourceCols}x${dem.sourceRows}`, range: [dem.sourceMin, dem.sourceMax] };

  // 导入前基线（程序化）
  await sleep(300);
  const groupOf = () => engine.synchronizer.getObjectMap().get(tid)?.children?.find((c) => c.name === '__terrainMesh');
  const g0 = groupOf();
  out.sigBefore = String(g0?.userData.terrainSig ?? '');
  const H0 = g0?.userData.terrainHeights;

  // 导入 DEM（一次 patch；geomSig 应含 dem 段并触发重建）
  await patch(tid, (n) => { n.dem = dem; });
  await sleep(500);
  const g1 = groupOf();
  out.sigAfter = String(g1?.userData.terrainSig ?? '');
  const H = g1?.userData.terrainHeights;
  const N = g1?.userData.terrainGridSize;
  out.rebuilt = H !== H0;
  out.sigHasDem = out.sigAfter.includes('dem:');
  if (H && N) {
    let mn = Infinity, mx = -Infinity;
    for (const v of H) { if (v < mn) mn = v; if (v > mx) mx = v; }
    out.heightRange = [Number(mn.toFixed(3)), Number(mx.toFixed(3))]; // 期望 ≈ [0, 30]
    out.westEdge = Number(H[0].toFixed(3));    // 期望 ≈ 0（西低）
    out.eastEdge = Number(H[N - 1].toFixed(3)); // 期望 ≈ 30（东高）
    out.midRamp = Number(H[(N >> 1) * N + (N >> 1)].toFixed(3)); // 期望 ≈ 15
  }

  // 运行时产物镜像：public/engine/runtime/terrain.mjs 用同一节点 JSON 烘焙，逐点应一致
  const rt = await import('http://localhost:1420/engine/runtime/terrain.mjs');
  const json = nodeJson(tid);
  const rtTerrain = rt.createTerrain(json);
  const RH = rtTerrain.data.heights;
  let maxDiff = 0;
  if (RH.length === H.length) {
    for (let i = 0; i < H.length; i++) maxDiff = Math.max(maxDiff, Math.abs(H[i] - RH[i]));
  } else maxDiff = -1;
  out.rtMirrorMaxDiff = Number(maxDiff.toFixed(4)); // 期望 0（同一算法双轨）

  // 碰撞贴合：挂高度场碰撞体 + 射线，东西两端命中高度应跟随 DEM 斜坡
  await run('node.component.add', { id: tid, type: 'collider' });
  await patch(tid, (n) => {
    const col = (n.components ?? []).find((c) => c.type === 'collider');
    col.collider = { ...col.collider, shape: 'heightfield', resolution: 64 };
  });
  engine.physics.play();
  await sleep(2500);
  const rayAt = (x) => {
    const hits = engine.physics.castRay({ origin: { x, y: 100, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 300 });
    return hits.length ? Number(hits[0].point.y.toFixed(3)) : null;
  };
  out.rayWest = rayAt(-90); // 期望 ≈ 30×(5/100)=1.5
  out.rayMid = rayAt(0);    // 期望 ≈ 15
  out.rayEast = rayAt(90);  // 期望 ≈ 28.5
  engine.physics.stop();

  out.pass = out.rebuilt && out.sigHasDem &&
    Math.abs(out.heightRange[0]) < 0.5 && Math.abs(out.heightRange[1] - 30) < 0.5 &&
    out.rtMirrorMaxDiff === 0 &&
    out.rayWest != null && Math.abs(out.rayWest - 1.5) < 1.0 &&
    out.rayMid != null && Math.abs(out.rayMid - 15) < 1.0 &&
    out.rayEast != null && Math.abs(out.rayEast - 28.5) < 1.0;
  return out;
})()
