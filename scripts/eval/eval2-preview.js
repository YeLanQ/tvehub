// 评测②a：预览 iframe 内部 rAF 帧率（可见态；默认 frameRate=60 上限）
(async () => {
  const measure = (label, ms) => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const loop = () => {
      n++;
      if (performance.now() - t0 < ms) requestAnimationFrame(loop);
      else res({ label, fps: Math.round((n * 1000) / (performance.now() - t0)), frames: n });
    };
    requestAnimationFrame(loop);
  });
  const out = {};
  out.raf = await measure('preview-visible', 4000);
  out.hidden = document.hidden;
  out.size = { w: innerWidth, h: innerHeight };
  return out;
})()
