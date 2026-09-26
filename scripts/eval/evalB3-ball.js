// 完整评测 B3：干净球碰撞贴合（一次性建全组件；落稳判定带高度前置；射线排除球）
(async () => {
  const vurl = (n) => (performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(n)) || ('http://localhost:1420' + n));
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // 删旧球
  const old = engine.graph.all().filter((n) => n.name === '碰撞球' || n.name === '碰撞球2');
  for (const n of old) await run('node.delete', { id: n.id });
  await sleep(300);

  // 新球：add → 一次 patch 写齐 rigidBody + collider(sphere) + 位置/缩放
  const ballCmd = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: '碰撞球2' });
  const bid = ballCmd?.id ?? ballCmd;
  await sleep(250);
  const bn = engine.graph.get(bid);
  const before = bn.toJSON();
  const after = JSON.parse(JSON.stringify(before));
  after.components = [
    ...(Array.isArray(after.components) ? after.components : []),
    { id: 'comp_rb_' + Date.now(), type: 'rigidBody', enabled: true, rigidBody: { mode: 'dynamic', mass: 2, linearDamping: 0.05, angularDamping: 0.05, gravityScale: 1, ccd: true, lockRotation: false, upright: false } },
    { id: 'comp_col_' + Date.now(), type: 'collider', enabled: true, collider: { shape: 'sphere', autoSize: true, size: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, friction: 0.6, restitution: 0.1, isSensor: false, resolution: 128 } },
  ];
  after.transform.scale = { x: 2, y: 2, z: 2 };
  after.transform.position = { x: 0, y: 120, z: 0 };
  engine.patchNode(bid, before, after, '干净球组件');
  await sleep(400);

  const obj = () => engine.synchronizer.getObjectMap().get(bid);
  const objY = () => { const o = obj(); const y = o?.position.y; return typeof y === 'number' && Number.isFinite(y) ? Number(y.toFixed(2)) : null; };
  const rayT = () => { const o0 = obj(); const bx = o0 ? Number(o0.position.x.toFixed(1)) : 0; const bz = o0 ? Number(o0.position.z.toFixed(1)) : 0;
    const hits = engine.physics.castRay({ origin: { x: bx, y: 150, z: bz }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 400, excludeNodeIds: [bid] });
    return hits.length ? Number(hits[0].point.y.toFixed(2)) : null;
  };
  // 落稳：先等 y 低于 40（真的在落），再等连续 1.2s 变化 < 0.2
  const waitLand = async () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 12000) {
      await sleep(250);
      const y = objY();
      if (y == null) continue;
      if (y < 40) {
        let last = y, hold = 0;
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          const y2 = objY();
          if (y2 == null) return { landed: false, y };
          if (Math.abs(y2 - last) < 0.2) hold++; else hold = 0;
          last = y2;
          if (hold >= 4) return { landed: true, y: objY() };
        }
        return { landed: false, y: last };
      }
    }
    return { landed: false, y: objY() };
  };

  const setHS = async (v) => {
    const tn = engine.graph.get(engine.graph.all().find((n) => n.name === '评测地形')?.id);
    const b4 = tn.toJSON();
    const af = JSON.parse(JSON.stringify(b4));
    af.terrain.heightScale = v;
    engine.patchNode(tn.id, b4, af, 'heightScale=' + v);
    await sleep(400);
  };

  engine.physics.play();
  await sleep(2500);
  await setHS(45);
  const r1 = await waitLand();
  out.tall = { ...r1, surface: r1.landed ? rayT() : null, rayY: r1.landed ? objY() : null };
  await setHS(8);
  // 高度骤降后球悬空 → 自由落体到新面
  const r2 = await waitLand();
  out.short = { ...r2, surface: r2.landed ? rayT() : null };
  engine.physics.stop();
  await sleep(300);
  out.fit1 = r1.landed && Math.abs(r1.y - out.tall.surface - 1) < 0.6;
  out.fit2 = r2.landed && Math.abs(r2.y - out.short.surface - 1) < 0.6;
  out.dropped = r1.landed && r2.landed && r1.y > r2.y + 8;
  out.pass = out.fit1 && out.fit2 && out.dropped;
  return out;
})()
