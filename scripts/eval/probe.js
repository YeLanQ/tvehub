(async () => {
  const m = await import('/src/app/commands/registry.ts');
  const run = (id, args) => m.runCommand(id, args, { logError: false });
  const probe = {};
  probe.sun = await run('node.add', { kind: 'light', subtype: 'directional', name: '评测平行光' }).catch((e) => 'ERR:' + e.message);
  if (typeof probe.sun === 'object' && probe.sun) {
    const sid = probe.sun.id ?? probe.sun.node?.id;
    probe.sid = sid;
    probe.setLight = await run('node.set', { id: sid, castShadow: true, position: { x: 8, y: 12, z: 6 }, rotation: { x: -50, y: 30, z: 0 } }).catch((e) => 'ERR:' + e.message);
  }
  const doc = await run('scene.doc', {});
  probe.kids = (doc.root?.children ?? []).map((c) => c.name ?? c.type);
  return probe;
})()
