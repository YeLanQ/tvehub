// 完整评测 A（全部走项目流）：建场景（DEM 地形+数据网格+压测网格）→ scene.save 落盘验证 → undo/redo
(async () => {
  const vurl = (n) => (performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(n)) || ('http://localhost:1420' + n));
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const demMod = await import(vurl('/src/framework/terrain/dem.ts'));
  const dgMod = await import(vurl('/src/framework/mesh/dataGeometry.ts'));
  const sculptMod = await import(vurl('/src/framework/terrain/sculpt.ts'));
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // —— 清场（走后端删除通道）——
  const doc0 = await run('scene.doc', {});
  for (const c of (doc0.root?.children ?? [])) await run('node.delete', { id: c.id });

  // —— 地形：DEM 斜坡数据源（64×64 ASC，西低东高 0..630）——
  const S = 64, NL = String.fromCharCode(10);
  const rows = [];
  for (let r = 0; r < S; r++) rows.push(Array.from({ length: S }, (_, c) => c * 10).join(' '));
  const asc = ['ncols ' + S, 'nrows ' + S, 'xllcorner 0', 'yllcorner 0', 'cellsize 1', 'nodata_value -9999'].join(NL) + NL + rows.join(NL);
  const dem = demMod.importDemFile('ramp-west-east.asc', '.asc', () => asc, () => new ArrayBuffer(0));

  const t = await run('node.add', { kind: 'terrain', name: '评测地形' });
  const tid = t?.id ?? t;
  const patch = async (id, mut, label) => {
    const before = engine.graph.get(id).toJSON();
    const after = JSON.parse(JSON.stringify(before));
    mut(after);
    engine.patchNode(id, before, after, label || '评测补丁');
    await sleep(120);
  };
  await patch(tid, (n) => Object.assign(n.terrain, { seed: 5, size: 400, segments: 128, heightScale: 45, talusPasses: 0 }));
  await patch(tid, (n) => { n.dem = dem; }, '导入 DEM');
  // 雕刻层叠加（DEM 基准 + 中心 +5 偏移）
  const gridN = 129;
  const offsets = new Float32Array(gridN * gridN);
  offsets[(Math.floor(gridN / 2)) * gridN + Math.floor(gridN / 2)] = 5;
  await patch(tid, (n) => { n.sculpt = { gridN, data: sculptMod.encodeSculptData(offsets) }; }, '叠加雕刻');

  // —— 投影平行光 ——
  const sun = await run('node.add', { kind: 'light', subtype: 'directional', name: '评测平行光' });
  await run('node.set', { id: sun.id, castShadow: true, position: { x: 60, y: 90, z: 40 }, rotation: { x: -50, y: 30, z: 0 } });

  // —— 压测网格：200 同规格 box + 50 sphere ——
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 20; j++) {
      const b = await run('node.add', { kind: 'mesh', subtype: 'box', name: 'b' + i + j });
      await run('node.set', { id: b.id, position: { x: (j - 10) * 8, y: 1, z: (i - 5) * 8 } });
    }
  }
  for (let k = 0; k < 50; k++) {
    const s = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: 's' + k });
    await run('node.set', { id: s.id, position: { x: (k % 10) * 9 - 45, y: 6, z: 100 + Math.floor(k / 10) * 9 } });
  }

  // —— 数据网格节点：导入四棱锥 JSON ——
  const dm = await run('node.add', { kind: 'mesh', subtype: 'data', name: '评测数据网格' });
  const pyramid = { positions: [0,0,0, 2,0,0, 2,0,2, 0,0,2, 1,1.5,1], indices: [0,2,1, 0,3,2, 0,1,4, 1,2,4, 2,3,4, 3,0,4] };
  const payload = dgMod.importMeshDataFile('pyramid.json', '.json', JSON.stringify(pyramid));
  await patch(dm.id, (n) => { n.dataMesh = payload; }, '导入数据网格');
  await run('node.set', { id: dm.id, position: { x: 30, y: 3, z: -30 } });

  await sleep(400);
  out.nodeCount = engine.graph.all().length;

  // —— 落盘 + 磁盘内容验证（走项目资产链路 readText）——
  await run('scene.save', {});
  const ps = (await import(vurl('/src/app/stores/project.ts'))).getProjectStore();
  const api = (await import(vurl('/src/lib/api.ts'))).api;
  const diskText = await api.readText(ps.currentPath, ps.sceneRel);
  const disk = JSON.parse(diskText);
  const flat = [];
  const walk = (n) => { flat.push(n); for (const c of (n.children ?? [])) walk(c); };
  walk(disk.root);
  out.disk = {
    rootId: disk.root.id || '(空)',
    nodeCount: flat.length,
    demNodes: flat.filter((n) => n.dem).length,
    demFormat: flat.find((n) => n.dem)?.dem?.format,
    sculptNodes: flat.filter((n) => n.sculpt).length,
    dataMeshNodes: flat.filter((n) => n.dataMesh).length,
    dataVerts: flat.find((n) => n.dataMesh)?.dataMesh?.vertexCount,
    boxes: flat.filter((n) => n.name?.startsWith('b')).length,
    spheres: flat.filter((n) => n.name?.startsWith('s')).length,
    rootChildCount: (disk.root.children ?? []).length,
  };

  // —— undo（后端历史 → 事件回填镜像；撤销最后一个 node.set：位置回退）——
  const probe = await run('node.add', { kind: 'mesh', subtype: 'box', name: 'undo探针' });
  await run('node.set', { id: probe.id, position: { x: 7, y: 7, z: 7 } });
  await sleep(250);
  const posBefore = engine.synchronizer.getObjectMap().get(probe.id)?.position.x;
  await run('editor.undo', {});
  await sleep(500);
  const posAfterUndo = engine.synchronizer.getObjectMap().get(probe.id)?.position.x;
  await run('node.delete', { id: probe.id });
  await sleep(250);
  out.undoRedo = {
    posBefore, posAfterUndo,
    ok: posBefore === 7 && posAfterUndo !== 7,
    note: '应用无 redo 命令（engine.redo 内部存在），undo 撤销 node.set 位置',
  };

  // —— DEM + 雕刻烘焙正确性（镜像高度 = DEM 斜坡 × 45，中心格含雕刻 +5）——
  const g = engine.synchronizer.getObjectMap().get(tid)?.children?.find((c) => c.name === '__terrainMesh');
  const H = g?.userData.terrainHeights, N = g?.userData.terrainGridSize;
  if (H && N) {
    const at = (gx, gz) => Number(H[gz * N + gx].toFixed(2));
    const mid = N >> 1;
    out.terrain = {
      gridN: N,
      west: at(0, mid),       // 期望 ≈ 0
      east: at(N - 1, mid),   // 期望 ≈ 45（630 归一化 1.0 × 45）
      midBase: at(mid + 2, mid), // 期望 ≈ 22.5 ± 邻格（避开雕刻单格）
      midSculpt: at(mid, mid),   // 期望 ≈ 27.5 = 22.5 + 5
    };
    out.terrainCheck = Math.abs(out.terrain.west) < 0.5 &&
      Math.abs(out.terrain.east - 45) < 0.5 &&
      Math.abs(out.terrain.midBase - 22.5) < 1.5 &&
      Math.abs(out.terrain.midSculpt - 27.5) < 0.5;
  }
  out.pass = out.disk.nodeCount === out.nodeCount && out.disk.demFormat === 'asc' &&
    out.disk.sculptNodes === 1 && out.disk.dataVerts === 5 &&
    out.disk.rootId.startsWith('node_') &&
    out.undoRedo.ok && !!out.terrainCheck;
  return out;
})()
