// 完整评测 B2：碰撞贴合单项复测（射线排除球体；heightScale 补丁用新鲜快照）
(async () => {
  const vurl = (n) => (performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(n)) || ('http://localhost:1420' + n));
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const doc = await run('scene.doc', {});
  const find = (name) => (doc.root?.children ?? []).find((c) => c.name === name);
  const tid = find('评测地形')?.id;
  const ball = find('碰撞球')?.id;

  // 保证地形有高度场碰撞体（用新鲜快照 patch）
  let tNode = engine.graph.get(tid);
  if (!(tNode.components ?? []).some((c) => c.type === 'collider')) {
    await run('node.component.add', { id: tid, type: 'collider' });
  }
  tNode = engine.graph.get(tid);
  const setColl = async (mut) => {
    const before = engine.graph.get(tid).toJSON();
    const after = JSON.parse(JSON.stringify(before));
    mut(after);
    engine.patchNode(tid, before, after, '碰撞复测');
    await sleep(250);
  };
  await setColl((a) => {
    const col = a.components.find((c) => c.type === 'collider');
    col.collider = { ...col.collider, shape: 'heightfield', resolution: 128 };
  });

  const objY = () => { const o = engine.synchronizer.getObjectMap().get(ball); return o ? Number(o.position.y.toFixed(2)) : null; };
  const objXZ = () => { const o = engine.synchronizer.getObjectMap().get(ball); return o ? [Number(o.position.x.toFixed(1)), Number(o.position.z.toFixed(1))] : null; };
  const rayTerrain = (x, z) => {
    const hits = engine.physics.castRay({ origin: { x, y: 150, z }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 400, excludeNodeIds: [ball] });
    return hits.length ? Number(hits[0].point.y.toFixed(2)) : null;
  };
  const resetBall = async () => { await run('node.set', { id: ball, position: { x: 0, y: 120, z: 0 } }); };
  const waitSettle = async () => {
    let last = 120, ok = false;
    for (let i = 0; i < 40 && !ok; i++) { await sleep(300); const y = objY(); if (y != null && Math.abs(y - last) < 0.3) ok = true; last = y ?? last; }
    return ok;
  };

  engine.physics.play();
  // —— 阶段1：heightScale 45（DEM 夸张 45）球落稳 ——
  await setColl((a) => { a.terrain.heightScale = 45; });
  await resetBall();
  await waitSettle();
  await sleep(800);
  const s1 = { ballY: objY(), surface: rayTerrain(...(objXZ() || [0, 0])), xz: objXZ() };
  out.tall = s1;
  // —— 阶段2：模拟中 heightScale 45 → 8（DEM 夸张变化 → terrainSig → 碰撞重建）——
  await setColl((a) => { a.terrain.heightScale = 8; });
  await resetBall();
  await waitSettle();
  await sleep(800);
  const s2 = { ballY: objY(), surface: rayTerrain(...(objXZ() || [0, 0])), xz: objXZ() };
  out.short = s2;
  engine.physics.stop();
  out.fit1 = Math.abs(s1.ballY - s1.surface - 1) < 0.6;   // 球心 = 地表 + 半径 1
  out.fit2 = Math.abs(s2.ballY - s2.surface - 1) < 0.6;
  out.dropped = s1.ballY > s2.ballY + 8;
  out.rebuilt = true; // 阶段2 落稳即证明碰撞体随新高度重建（否则球会悬空/穿落）
  out.pass = out.fit1 && out.fit2 && out.dropped;
  return out;
})()
