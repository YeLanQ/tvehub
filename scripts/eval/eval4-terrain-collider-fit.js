// 评测④：地形高度场碰撞随地形变化实时重建（模拟中改 heightScale，动力学球应随新地形下落）
// 注：经引擎内存图读写（engine.graph/patchNode），不依赖后端场景会话。
(async () => {
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    if (!hit) throw new Error('未找到模块: ' + needle);
    return hit;
  };
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const store = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore();
  const engine = store.engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // 清场（内存图直删）
  engine.graph.removeNodes(engine.graph.all().map((n) => n.id));

  const nodeJson = (id) => {
    const n = engine.graph.get(id);
    return n ? n.toJSON() : null;
  };
  const patch = async (id, mut) => {
    const before = nodeJson(id);
    if (!before) throw new Error('节点不存在: ' + id);
    const after = JSON.parse(JSON.stringify(before));
    mut(after);
    engine.patchNode(id, before, after, '碰撞贴合评测');
  };

  // 地形（size 200 / segments 64 / heightScale 40）+ 高度场碰撞体
  const t = await run('node.add', { kind: 'terrain', name: '碰撞验证地形' });
  const tid = t?.id ?? t;
  await patch(tid, (n) => Object.assign(n.terrain, { seed: 11, size: 200, segments: 64, heightScale: 40, talusPasses: 0 }));
  await run('node.component.add', { id: tid, type: 'collider' });
  await patch(tid, (n) => {
    const col = (n.components ?? []).find((c) => c.type === 'collider');
    col.collider = { ...col.collider, shape: 'heightfield', resolution: 256 };
  });

  // 动力学球（scale 2 → 半径 1）
  const b = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: '碰撞验证球' });
  const bid = b?.id ?? b;
  await run('node.set', { id: bid, position: { x: 0, y: 60, z: 0 }, scale: { x: 2, y: 2, z: 2 } });
  await run('node.component.add', { id: bid, type: 'rigidBody' });
  await run('node.component.add', { id: bid, type: 'collider' });
  await patch(bid, (n) => {
    const col = n.components.find((c) => c.type === 'collider');
    col.collider = { ...col.collider, shape: 'sphere' };
  });

  const objY = () => {
    const o = engine.synchronizer.getObjectMap().get(bid);
    return o ? Number(o.position.y.toFixed(3)) : null;
  };
  const terrainSig = () => {
    const o = engine.synchronizer.getObjectMap().get(tid);
    const g = o?.children?.find((c) => c.name === '__terrainMesh');
    return g ? String(g.userData.terrainSig ?? '') : null;
  };

  engine.physics.play();
  // 轮询等球落到 40 尺度地形上并趋于稳定（两次读数差 <0.3；上限 9s）
  let lastY = 60;
  let stable = false;
  for (let i = 0; i < 30 && !stable; i++) {
    await sleep(300);
    const y = objY();
    if (y != null && Math.abs(y - lastY) < 0.3) stable = true;
    lastY = y ?? lastY;
  }
  out.settleMs = stable ? 'stable' : 'timeout';
  out.y1b = objY();
  out.sig1 = terrainSig();
  out.ballXZ = (() => {
    const o = engine.synchronizer.getObjectMap().get(bid);
    return o ? [Number(o.position.x.toFixed(1)), Number(o.position.z.toFixed(1))] : null;
  })();

  // 模拟中：heightScale 40 → 4（几何重建；碰撞体须随 terrainSig 重建，否则球悬在旧高度）
  let patchErr = null;
  try {
    await patch(tid, (n) => { n.terrain.heightScale = 4; });
  } catch (e) { patchErr = String(e); }
  out.patchErr = patchErr;
  await sleep(1000);
  out.terrainBodyAfterPatch = !!engine.physics.bodyFor(tid);
  try {
    const hits = engine.physics.castRay(
      { origin: { x: 0, y: 60, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 200 },
    );
    out.rayHit = hits.length ? { y: Number(hits[0].point.y.toFixed(3)), nodeId: hits[0].nodeId ?? null } : null;
  } catch (e) { out.rayErr = String(e); }
  await sleep(4000);
  out.sig2 = terrainSig();
  out.y2a = objY();
  await sleep(600);
  out.y2b = objY();
  out.terrainBodyEnd = !!engine.physics.bodyFor(tid);

  out.drop = Number(((out.y1b ?? 0) - (out.y2b ?? 0)).toFixed(3));
  // 山地形（heightScale 40）陡坡球可能持续缓滚：只要求球停在高处（>6，40 尺度地形中部）；
  // 平缓判据只对变化后的低地形（heightScale 4）生效（须稳定停在新地表 ±0.5）
  out.highOnTall = out.y1b != null && out.y1b > 6;
  out.settled2 = out.y2a != null && Math.abs(out.y2a - out.y2b) < 0.5;
  out.sigChanged = out.sig1 != null && out.sig2 != null && out.sig1 !== out.sig2;
  out.pass = out.highOnTall && out.settled2 && out.sigChanged && out.drop > 8;
  engine.physics.stop();
  return out;
})()
