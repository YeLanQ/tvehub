// 评测①v2：编辑器视口空闲降帧 + 活动恢复全速（版本化 URL 动态发现）
(async () => {
  // 找页面已加载的版本化模块 URL（保证与页面同一单例实例）
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    if (!hit) throw new Error('未找到模块: ' + needle);
    return hit;
  };
  const cmdUrl = vurl('/src/app/commands/index.ts');
  const storeUrl = vurl('/src/app/stores/editor.ts');
  const cmds = await import(cmdUrl);
  const engine = (await import(storeUrl)).getEditorStore().engine;
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });

  const out = {};
  // 显示器刷新率参照
  out.displayHz = await new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const loop = () => {
      n++;
      if (performance.now() - t0 < 1000) requestAnimationFrame(loop);
      else res(Math.round((n * 1000) / (performance.now() - t0)));
    };
    requestAnimationFrame(loop);
  });

  const doc = await run('scene.doc', {});
  const PID = (doc.root?.children ?? []).find((c) => c.name === '评测粒子').id;
  const SID = (doc.root?.children ?? []).find((c) => c.name === '评测平行光').id;

  const sample = async (ms) => {
    const a = engine.renderer.getStats().fps;
    await new Promise((r) => setTimeout(r, ms));
    return engine.renderer.getStats().fps;
  };

  // —— A. 空闲（停粒子 → 等 6s → 采样 4s）——
  engine.particles.stop(PID);
  await new Promise((r) => setTimeout(r, 6000));
  out.idleFps = await sample(4000);

  // —— B. 活动（播粒子 → 全速）——
  out.played = engine.particles.play(PID);
  await new Promise((r) => setTimeout(r, 1500));
  out.activeFps = await sample(4000);

  // —— C. 交互标记（停粒子 → 空闲 → 选中标记 → 立即恢复全速）——
  engine.particles.stop(PID);
  await new Promise((r) => setTimeout(r, 6000));
  out.idleAgainFps = await sample(1500);
  await run('node.select', { id: SID });
  await new Promise((r) => setTimeout(r, 400));
  out.afterSelectFps = engine.renderer.getStats().fps;

  // —— D. 统计按需遍历（getStats 拉取侧 500ms 缓存）——
  const st = engine.renderer.getStats();
  out.statsMeshes = st.meshes;
  out.statsVertices = st.vertices;

  // 收尾：停粒子留静态场景（预览评测用），播放态交给宿主自行体验
  engine.particles.stop(PID);
  return out;
})()
