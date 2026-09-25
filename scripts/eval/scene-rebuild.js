// 重建评测场景：显式 parentId=root 平铺结构
(async () => {
  const m = await import('/src/app/commands/registry.ts');
  const run = (id, args) => m.runCommand(id, args, { logError: false });
  const doc = await run('scene.doc', {});
  const rootKid = (doc.root?.children ?? [])[0];
  if (rootKid) await run('node.delete', { ids: [rootKid.id] });
  await run('node.delete', { ids: ['test_node_1'] }).catch(() => {});

  const out = {};
  const add = async (args) => {
    const r = await run('node.add', { ...args, parentId: 'root' });
    return r.id;
  };

  out.ground = await add({ kind: 'mesh', subtype: 'box', name: '评测地面' });
  await run('node.set', { id: out.ground, scale: { x: 24, y: 0.2, z: 24 } });

  out.sun = await add({ kind: 'light', subtype: 'directional', name: '评测平行光' });
  await run('node.set', { id: out.sun, castShadow: true, position: { x: 8, y: 12, z: 6 }, rotation: { x: -50, y: 30, z: 0 } });

  out.cubes = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const id = await add({ kind: 'mesh', subtype: 'box', name: `方块${i}${j}` });
      await run('node.set', { id, position: { x: (i - 1) * 3.2, y: 0.8, z: (j - 1) * 3.2 } });
      out.cubes.push(id);
    }
  }

  out.sphere = await add({ kind: 'mesh', subtype: 'sphere', name: '评测球' });
  await run('node.set', { id: out.sphere, position: { x: 0, y: 1.4, z: 0 } });

  out.particles = await add({ kind: 'particle', name: '评测粒子' });
  await run('node.set', { id: out.particles, position: { x: 5, y: 2, z: 0 } });

  out.camera = await add({ kind: 'camera', name: '评测相机' });
  await run('node.set', { id: out.camera, position: { x: 10, y: 7, z: 12 }, rotation: { x: -25, y: -38, z: 0 } });

  await run('node.select', { id: null });
  await run('scene.save', {});
  out.state = await run('editor.state', {});
  return out;
})()
