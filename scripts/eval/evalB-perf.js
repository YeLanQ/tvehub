// 完整评测 B（全部走项目流）：碰撞贴合 + 渲染性能（drawcalls/阴影门控）+ 空闲降帧/活动恢复 + 数据网格镜像
(async () => {
  const vurl = (n) => (performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(n)) || ('http://localhost:1420' + n));
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // —— 补齐压测网格（带间隔避免 id 同毫秒冲突；只补缺的）——
  const names = new Set(engine.graph.all().map((n) => n.name));
  const need = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 20; j++) if (!names.has('b' + i + j)) need.push(['b' + i + j, 'box', (j - 10) * 8, 1, (i - 5) * 8]);
  for (let k = 0; k < 50; k++) if (!names.has('s' + k)) need.push(['s' + k, 'sphere', (k % 10) * 9 - 45, 6, 100 + Math.floor(k / 10) * 9]);
  for (const [name, sub, x, y, z] of need) {
    const n = await run('node.add', { kind: 'mesh', subtype: sub, name });
    if (n?.id) await run('node.set', { id: n.id, position: { x, y, z } });
    await sleep(15);
  }
  out.meshTotal = engine.graph.all().filter((n) => /^[bs]\d+$/.test(n.name)).length;

  // —— 碰撞贴合：地形高度场 + 动力学球（模拟中改 heightScale → 碰撞随 DEM 夸张重建）——
  const doc = await run('scene.doc', {});
  const find = (name) => (doc.root?.children ?? []).find((c) => c.name === name);
  const tid = find('评测地形')?.id;
  await run('node.component.add', { id: tid, type: 'collider' });
  const tNode = engine.graph.get(tid);
  {
    const before = tNode.toJSON();
    const after = JSON.parse(JSON.stringify(before));
    const col = after.components.find((c) => c.type === 'collider');
    col.collider = { ...col.collider, shape: 'heightfield', resolution: 128 };
    engine.patchNode(tid, before, after, '挂高度场');
  }
  const ball = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: '碰撞球' });
  await run('node.set', { id: ball.id, position: { x: 0, y: 120, z: 0 }, scale: { x: 2, y: 2, z: 2 } });
  await run('node.component.add', { id: ball.id, type: 'rigidBody' });
  await run('node.component.add', { id: ball.id, type: 'collider' });
  {
    const bn = engine.graph.get(ball.id);
    const before = bn.toJSON();
    const after = JSON.parse(JSON.stringify(before));
    after.components.find((c) => c.type === 'collider').collider = { ...after.components.find((c) => c.type === 'collider').collider, shape: 'sphere' };
    engine.patchNode(ball.id, before, after, '球改球形');
  }
  const objY = () => { const o = engine.synchronizer.getObjectMap().get(ball.id); return o ? Number(o.position.y.toFixed(2)) : null; };
  const rayAt = (x) => {
    const hits = engine.physics.castRay({ origin: { x, y: 150, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 400 });
    return hits.length ? Number(hits[0].point.y.toFixed(2)) : null;
  };
  engine.physics.play();
  // 等球落稳（两次读差 < 0.3）
  let lastY = 120, stable = false;
  for (let i = 0; i < 40 && !stable; i++) { await sleep(300); const y = objY(); if (y != null && Math.abs(y - lastY) < 0.3) stable = true; lastY = y ?? lastY; }
  out.ballOnTall = { y: objY(), ray: rayAt(0) };
  // 模拟中改 heightScale 45 → 8（DEM 夸张变化 → terrainSig 变 → 碰撞重建）
  {
    const before = tNode.toJSON();
    const after = JSON.parse(JSON.stringify(before));
    after.terrain.heightScale = 8;
    engine.patchNode(tid, before, after, '降地形');
  }
  await sleep(4500);
  out.ballOnShort = { y: objY(), ray: rayAt(0) };
  engine.physics.stop();
  out.colliderFit = out.ballOnTall.y > 20 && out.ballOnShort.y != null &&
    Math.abs((out.ballOnShort.y ?? 0) - (out.ballOnShort.ray ?? 0) - 1) < 1.2; // 球心 = 面 + 半径1

  // —— 静态渲染统计（阴影门控：静态帧 drawCalls 恒定）——
  const gl = engine.renderer.glRenderer;
  await sleep(2500);
  const frames = [];
  let on = true;
  const tick = () => { if (!on) return; frames.push(gl ? gl.info.render.calls : -1); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await sleep(2000);
  out.staticCalls = [...new Set(frames)];
  out.geometries = engine.renderer.getStats().geometries;
  // 移动一个方块 → 单帧阴影重画尖峰 → 回落
  frames.length = 0;
  const b00 = engine.graph.all().find((n) => n.name === 'b00');
  {
    const before = b00.toJSON();
    const after = JSON.parse(JSON.stringify(before));
    after.transform.position.y = 3;
    engine.patchNode(b00.id, before, after, '阴影尖峰探针');
  }
  await sleep(1000);
  on = false;
  out.maxFrameAfterMove = Math.max(...frames);
  out.shadowGate = out.staticCalls.length <= 2 && out.maxFrameAfterMove > 200;

  // —— 空闲降帧（8.5s 无活动 → ~12fps）+ 活动恢复 ——
  await sleep(8500);
  const idleA = engine.renderer.getStats().fps;
  await sleep(1500);
  const idleB = engine.renderer.getStats().fps;
  out.idleFps = Number(((idleA + idleB) / 2).toFixed(1));
  const canvas = engine.renderer.domElement;
  const r = canvas.getBoundingClientRect();
  for (let i = 0; i < 30; i++) {
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * Math.random(), clientY: r.top + r.height * Math.random() }));
    await sleep(16);
  }
  await sleep(800);
  out.activeFps = engine.renderer.getStats().fps;
  out.idleGate = out.idleFps < 25 && out.activeFps > 60;

  // —— 数据网格：镜像几何 vs 运行时产物逐点一致 ——
  const dmNode = engine.graph.all().find((n) => n.source === 'data');
  const obj = engine.synchronizer.getObjectMap().get(dmNode?.id);
  const rt = await import('http://localhost:1420/engine/runtime/mesh.mjs');
  const rtObj = rt.createMesh(dmNode.toJSON(), { materialParams: new Map() });
  const a = obj.geometry.getAttribute('position'), b = rtObj.geometry.getAttribute('position');
  let diff = -1;
  if (a && b && a.count === b.count) { diff = 0; for (let i = 0; i < a.count * 3; i++) diff = Math.max(diff, Math.abs(a.array[i] - b.array[i])); }
  out.dataMesh = { verts: a?.count ?? 0, rtVerts: b?.count ?? 0, maxDiff: Number(diff.toFixed(4)) };

  await run('scene.save', {});
  out.pass = out.meshTotal >= 250 && out.colliderFit && out.shadowGate && out.idleGate && out.dataMesh.maxDiff === 0;
  return out;
})()
