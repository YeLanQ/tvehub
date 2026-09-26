// 评测⑧：属性面板快速连续编辑竞态——12 连发交替编辑（不等回显），验证终值不丢不跳
(async () => {
  const vurl = (n) => (performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(n)) || ('http://localhost:1420' + n));
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const engine = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore().engine;
  const sceneApi = (await import(vurl('/src/lib/scene-api.ts'))).sceneApi;
  const dispatch = (id, args) => cmds.dispatchCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { rounds: [] };

  // 清场 + 建节点
  const doc0 = await sceneApi.doc();
  for (const c of (doc0.root?.children ?? [])) await dispatch('node.delete', { id: c.id });
  const n = await dispatch('node.add', { kind: 'mesh', subtype: 'box', name: '快编验证' });
  const id = (n && typeof n === 'object' && 'value' in n) ? n.value?.id : (n?.id ?? n);
  if (!id || typeof id !== 'string') return { error: '建节点失败', raw: JSON.stringify(n)?.slice(0, 200) };
  await sleep(400);

  for (let round = 1; round <= 3; round++) {
    // 12 连发：x/y 交替推进，间隔 8ms（回显不断到达中继续编辑）
    const N = 12;
    for (let i = 1; i <= N; i++) {
      void dispatch('node.set', { id, position: { x: i * round, y: i * round, z: 0 } });
      await sleep(8);
    }
    await sleep(1500); // 回显全部落定
    const node = engine.graph.get(id);
    const t = node.transform.position;
    const doc = await sceneApi.doc();
    const back = (doc.root?.children ?? []).find((c) => c.id === id);
    const bt = back?.transform?.position;
    const expectV = N * round;
    const roundResult = {
      round,
      local: { x: Number(t.x.toFixed(3)), y: Number(t.y.toFixed(3)) },
      backend: bt ? { x: Number(bt.x.toFixed(3)), y: Number(bt.y.toFixed(3)) } : null,
    };
    roundResult.ok = roundResult.local.x === expectV && roundResult.local.y === expectV &&
      roundResult.backend != null && roundResult.backend.x === expectV && roundResult.backend.y === expectV;
    out.rounds.push(roundResult);
  }
  out.pass = out.rounds.every((r) => r.ok);
  await dispatch('node.delete', { id });
  return out;
})()
