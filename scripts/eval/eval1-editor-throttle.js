// 评测①：编辑器视口空闲降帧 + 活动恢复全速
// 数据源：engine.renderer.getStats().fps（引擎自身渲染循环的 EMA，只统计实际渲染帧）
(async () => {
  const es = await import('/src/app/stores/editor.ts');
  const engine = es.getEditorStore().engine;
  const doc0 = await (await import('/src/app/commands/index.ts')).runCommand('scene.doc',{},{logError:false});
  const PID = (doc0.root?.children??[]).find(c=>c.name==='评测粒子').id;
  const SID = (doc0.root?.children??[]).find(c=>c.name==='评测平行光').id;
  const out = { displayHz: null };

  // 显示器刷新率参照（独立 rAF 计数，1s 窗口）
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

  const sampleFps = async (ms) => {
    const a = engine.renderer.getStats().fps;
    await new Promise((r) => setTimeout(r, ms));
    const b = engine.renderer.getStats().fps;
    return { start: a, end: b };
  };

  // —— A. 空闲：停掉粒子（唯一活动源），等 6s（> 800ms 空闲窗口）——
  
  // 退路：粒子节点 id 由名称反查
  if (!engine.particles.stop) {
    /* API 缺失时跳过 */
  }
  await new Promise((r) => setTimeout(r, 6000));
  out.idle = await sampleFps(4000);

  // —— B. 活动：播放粒子 → 应恢复全速 ——
  const played = engine.particles.play(PID);
  out.played = played;
  await new Promise((r) => setTimeout(r, 1500));
  out.active = await sampleFps(4000);

  // —— C. 交互标记：停粒子 → 空闲 → 选中节点标记活动 ——
  engine.particles.stop(PID);
  await new Promise((r) => setTimeout(r, 6000));
  out.idleAgain = await sampleFps(2000);
  // select:changed → markActivity（一次性窗口）
  const m = await import('/src/app/commands/index.ts');
  await m.runCommand('node.select', { id: SID }, { logError: false }).catch(() => {});
  // 用场景里真实节点再选一次
  const doc = await m.runCommand('scene.doc', {}, { logError: false });
  const sun = (doc.root?.children ?? []).find((c) => c.name === '评测平行光');
  await m.runCommand('node.select', { id: sun.id }, { logError: false });
  await new Promise((r) => setTimeout(r, 300));
  out.afterSelect = engine.renderer.getStats().fps;

  // —— D. 统计按需：getStats 返回网格/顶点数（遍历已挪到拉取侧） ——
  const stats = engine.renderer.getStats();
  out.statsMeshes = stats.meshes;
  out.statsVertices = stats.vertices;
  // 再等 1.2s 拉第二次（>500ms 缓存窗）：应重新遍历（数值一致即正确）
  await new Promise((r) => setTimeout(r, 1200));
  const stats2 = engine.renderer.getStats();
  out.statsMeshesCached = stats2.meshes;

  // 收尾：恢复粒子播放态留给宿主看效果
  engine.particles.play(PID);
  return out;
})()
