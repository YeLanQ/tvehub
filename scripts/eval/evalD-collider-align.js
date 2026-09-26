// 复现：真实 UI 流导入 complex-dem.asc（文件注入 DataTransfer → DEM 卡 onFile）
// → 自动适配 → 高度场碰撞（自动档）→ 截图；再切存量 128 档复现用户状态 → 截图。
(async () => {
  const vurl = (n) => (performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(n)) || ('http://localhost:1420' + n));
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // 清场
  const doc0 = await run('scene.doc', {});
  for (const c of (doc0.root?.children ?? [])) await run('node.delete', { id: c.id });

  // 建地形 + 选中（DEM 卡渲染）
  const t = await run('node.add', { kind: 'terrain', name: '贴齐复现地形' });
  const tid = t?.id ?? t;
  await run('node.select', { id: tid });
  await sleep(600);

  // 真实 UI 注入：DataTransfer → file input → change
  const input = document.querySelector('.dem-section input[type=file]');
  if (!input) return { error: 'DEM 卡文件输入未找到（选中态未渲染？）' };
  const dt = new DataTransfer();
  dt.items.add(new File([window.__DEM_TEXT], 'complex-dem.asc'));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await sleep(2500);

  const node = engine.graph.get(tid);
  out.autoFit = { size: node.terrain.size, heightScale: node.terrain.heightScale, hasDem: !!node.dem, demGridN: node.dem?.gridN };

  // 高度场碰撞（默认=自动档）：补形状 + 灯光
  await run('node.component.add', { id: tid, type: 'collider' });
  await sleep(300);
  {
    const n0 = engine.graph.get(tid);
    const before = n0.toJSON();
    const after = JSON.parse(JSON.stringify(before));
    after.components.find((c) => c.type === 'collider').collider.shape = 'heightfield';
    engine.patchNode(tid, before, after, '高度场');
  }
  await run('node.add', { kind: 'light', subtype: 'directional', name: '复现平行光' });
  await sleep(600);
  const colComp = node.components.find((c) => c.type === 'collider');
  out.storedResolution = colComp.collider.resolution; // 期望 0（自动）

  // desc 验证：采样对齐网格（257 → 256）
  const cs = await import(vurl('/src/framework/physics/colliderShape.ts'));
  const obj = engine.synchronizer.getObjectMap().get(tid);
  obj.updateWorldMatrix(true, false);
  const desc = cs.computeColliderShapeDesc({ ...colComp.collider, enabled: true }, obj);
  out.desc = { samples: desc.samples, sizeX: desc.terrainSizeX, minH: Number(desc.minHeight.toFixed(1)), maxH: Number(desc.maxHeight.toFixed(1)) };

  // 数值贴地检查：desc 采样高度（最近邻）在其 XZ 处 vs 网格双线性插值——应相等（同源）；
  // 真正有意义的是线框顶点是否落在网格表面：抽 200 个线框采样点比较
  const H = obj.children.find((c) => c.name === '__terrainMesh').userData.terrainHeights;
  const gridN = obj.children.find((c) => c.name === '__terrainMesh').userData.terrainGridSize;
  const meshHAt = (gx, gz) => H[gz * gridN + gx]; // 网格顶点真值
  const sxIdx = (i) => Math.round((i * (gridN - 1)) / (desc.samples - 1));
  let maxDiff = 0;
  for (let i = 0; i < desc.samples; i += 16) {
    for (let j = 0; j < desc.samples; j += 16) {
      const d = Math.abs(desc.heights[j * desc.samples + i] - meshHAt(sxIdx(i), sxIdx(j)));
      if (d > maxDiff) maxDiff = d;
    }
  }
  out.wireVsMeshMaxDiff = Number(maxDiff.toFixed(4));

  // 相机摆位：近景坡面（能看到线框贴地与否）
  const cam = engine.renderer.getActiveCamera();
  const orbit = engine.renderer.orbitControls;
  cam.position.set(420, 780, 620);
  orbit.target.set(0, 300, 0);
  orbit.update();
  await sleep(800);
  const shot1 = await run('preview.screenshot', {});
  out.shotAuto = shot1.saved;

  // 切存量 128 档（复现用户 collider 存量状态）
  {
    const before = node.toJSON();
    const after = JSON.parse(JSON.stringify(before));
    after.components.find((c) => c.type === 'collider').collider.resolution = 128;
    engine.patchNode(tid, before, after, '切128档');
  }
  await sleep(900);
  const desc128 = cs.computeColliderShapeDesc({ ...colComp.collider, resolution: 128, enabled: true }, obj);
  out.desc128 = { samples: desc128.samples };
  const shot2 = await run('preview.screenshot', {});
  out.shot128 = shot2.saved;
  await run('scene.save', {});
  return out;
})()
