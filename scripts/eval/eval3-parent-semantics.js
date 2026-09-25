// 折中方案实机复测：隐式父级只认容器型节点
(async () => {
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    if (!hit) throw new Error('未找到模块: ' + needle);
    return hit;
  };
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const out = {};

  const doc = async () => await run('scene.doc', {});
  const kidsFlat = (d) => (d.root?.children ?? []).map((c) => ({ name: c.name, kids: (c.children ?? []).length }));
  const find = (d, name) => (d.root?.children ?? []).find((c) => c.name === name);

  // —— 场景①：选中实体（方块00）→ 不带 parentId 加球 → 应挂根 ——
  const d1 = await doc();
  const cube = find(d1, '方块00');
  await run('node.select', { id: cube.id });
  const added = await run('node.add', { kind: 'mesh', subtype: 'sphere', name: '复测-实体选中加球' });
  const d2 = await doc();
  const atRoot = !!find(d2, '复测-实体选中加球');
  out.entitySelected = { addedId: added.id, landedAtRoot: atRoot, cubeChildren: (find(d2, '方块00')?.children ?? []).length };

  // —— 场景②：建空组并选中 → 不带 parentId 加方块 → 应进组 ——
  const grp = await run('node.add', { kind: 'group', name: '复测-空组', parentId: 'root' });
  await run('node.select', { id: grp.id });
  const m2 = await run('node.add', { kind: 'mesh', subtype: 'box', name: '复测-组内方块' });
  const d3 = await doc();
  const g = find(d3, '复测-空组');
  out.groupSelected = { groupId: grp.id, boxInGroup: (g?.children ?? []).some((c) => c.name === '复测-组内方块'), boxAtRoot: !!find(d3, '复测-组内方块') };

  // —— 场景③：无选中 → 不带 parentId 加灯 → 应挂根 ——
  await run('node.select', { id: null });
  await run('node.add', { kind: 'light', subtype: 'point', name: '复测-无选中加灯' });
  const d4 = await doc();
  out.noSelection = { lightAtRoot: !!find(d4, '复测-无选中加灯') };

  // —— 清理复测节点，恢复评测项目原貌 ——
  const d5 = await doc();
  const toRemove = ['复测-空组', '复测-实体选中加球', '复测-无选中加灯']
    .map((n) => find(d5, n)?.id).filter(Boolean);
  await run('node.delete', { ids: toRemove });
  await run('node.select', { id: null });
  await run('scene.save', {});
  out.cleaned = toRemove;
  const st = await run('editor.state', {});
  out.dirty = st.dirty ?? st.state?.dirty;
  return out;
})()
