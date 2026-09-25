// 搭建性能评测场景：地面 + 投影平行光 + 方块阵 + 球体 + 粒子 + 相机
(async () => {
  const m = await import('/src/app/commands/registry.ts');
  const run = (id, args) => m.runCommand(id, args, { logError: false });
  const out = {};

  // 地面
  const ground = await run('node.add', { kind: 'mesh', subtype: 'box', name: '评测地面' });
  out.ground = ground?.id ?? ground;
  await run('node.set', { id: out.ground, scale: { x: 24, y: 0.2, z: 24 }, position: { x: 0, y: 0, z: 0 } });

  // 投影平行光（场景优化评测的主 GPU 负载源）
  const sun = await run('node.add', { kind: 'light', subtype: 'directional', name: '评测平行光' });
  out.sun = sun?.id ?? sun;
  await run('node.set', { id: out.sun, castShadow: true, position: { x: 8, y: 12, z: 6 }, rotation: { x: -50, y: 30, z: 0 } });

  // 方块阵 3×3（投射/接收阴影）
  out.cubes = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = await run('node.add', { kind: 'mesh', subtype: 'box', name: `方块${i}${j}` });
      const id = c?.id ?? c;
      await run('node.set', { id, position: { x: (i - 1) * 3.2, y: 0.8, z: (j - 1) * 3.2 } });
      out.cubes.push(id);
    }
  }

  // 球体
  const sphere = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: '评测球' });
  out.sphere = sphere?.id ?? sphere;
  await run('node.set', { id: out.sphere, position: { x: 0, y: 1.4, z: 0 } });

  // 粒子系统（空闲评测的活动开关：默认 looping 发射）
  const part = await run('node.add', { kind: 'particle', name: '评测粒子' });
  out.particles = part?.id ?? part;
  await run('node.set', { id: out.particles, position: { x: 5, y: 2, z: 0 } });

  // 渲染相机（预览用）
  const cam = await run('node.add', { kind: 'camera', name: '评测相机' });
  out.camera = cam?.id ?? cam;
  await run('node.set', { id: out.camera, position: { x: 10, y: 7, z: 12 }, rotation: { x: -25, y: -38, z: 0 } });

  await run('scene.save', {});
  const st = await run('editor.state', {});
  out.saved = { scene: st.state.scene, dirty: st.state.dirty };
  return out;
})()
