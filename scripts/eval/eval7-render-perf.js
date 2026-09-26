// 评测⑦：渲染性能基线/对比 —— 压力场景（地形+投影灯+200盒+50球）采样
// drawCalls/triangles/geometries/fps（静态 3s + 交互模拟 3s）。改动前后各跑一次对比。
(async () => {
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    return hit || ('http://localhost:1420' + needle);
  };
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const store = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore();
  const engine = store.engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { stamp: new Date().toISOString() };

  // —— 压力场景 ——
  engine.graph.removeNodes(engine.graph.all().map((n) => n.id));
  const patch = async (id, mut) => {
    const before = engine.graph.get(id).toJSON();
    const after = JSON.parse(JSON.stringify(before));
    mut(after);
    engine.patchNode(id, before, after, '性能评测');
  };
  const t = await run('node.add', { kind: 'terrain', name: '压测地形' });
  await patch(t.id, (n) => Object.assign(n.terrain, { seed: 5, size: 400, segments: 128, heightScale: 45 }));
  const sun = await run('node.add', { kind: 'light', subtype: 'directional', name: '压测平行光' });
  await run('node.set', { id: sun.id, castShadow: true, position: { x: 60, y: 90, z: 40 }, rotation: { x: -50, y: 30, z: 0 } });
  let added = 0;
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 20; j++) {
      const b = await run('node.add', { kind: 'mesh', subtype: 'box', name: `b${i}${j}` });
      await run('node.set', { id: b.id, position: { x: (j - 10) * 8, y: 1, z: (i - 5) * 8 } });
      added++;
    }
  }
  for (let k = 0; k < 50; k++) {
    const s = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: `s${k}` });
    await run('node.set', { id: s.id, position: { x: (k % 10) * 9 - 45, y: 6, z: 100 + Math.floor(k / 10) * 9 } });
    added++;
  }
  out.nodes = engine.graph.all().length;

  const sample = () => {
    const s = engine.renderer.getStats();
    return { fps: Number(s.fps.toFixed(1)), drawCalls: s.drawCalls, triangles: s.triangles, geometries: s.geometries, programs: s.programs };
  };
  const avg = (list, k) => Number((list.reduce((a, b) => a + b[k], 0) / list.length).toFixed(1));

  // —— 静态采样（3s；空闲降帧生效时 fps 会落向 12）——
  await sleep(2500);
  const idle = [];
  for (let i = 0; i < 6; i++) { await sleep(500); idle.push(sample()); }
  out.idle = { fps: avg(idle, 'fps'), drawCalls: idle[3].drawCalls, triangles: idle[3].triangles, geometries: idle[3].geometries, programs: idle[3].programs };

  // —— 交互采样（3s；持续 pointermove 保持活动全速，帧率应接近刷新率）——
  const canvas = engine.renderer.domElement ?? document.querySelector('canvas');
  const active = [];
  const move = setInterval(() => {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: r.left + r.width * (0.4 + 0.2 * Math.random()), clientY: r.top + r.height * (0.4 + 0.2 * Math.random()),
    }));
  }, 16);
  await sleep(1500);
  for (let i = 0; i < 6; i++) { await sleep(500); active.push(sample()); }
  clearInterval(move);
  out.active = { fps: avg(active, 'fps'), drawCalls: active[3].drawCalls, triangles: active[3].triangles };

  // —— 几何内存口径：重复基元的几何对象数（共享缓存应显著下降）——
  out.geometriesAtEnd = engine.renderer.getStats().geometries;
  out.pass = out.nodes >= 250 && out.idle.drawCalls > 0;
  return out;
})()
