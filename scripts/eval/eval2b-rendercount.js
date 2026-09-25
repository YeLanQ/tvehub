// 评测②b：预览 player 实际渲染频率（patch WebGLRenderer.prototype.render 计数）
(async () => {
  const THREE = await import('/engine/core/three.module.min.js');
  const orig = THREE.WebGLRenderer.prototype.render;
  if (orig.__patched) return { err: 'already patched' };
  let count = 0;
  const patched = function (...a) { count++; return orig.apply(this, a); };
  patched.__patched = true;
  THREE.WebGLRenderer.prototype.render = patched;

  const rate = async (label, ms) => {
    const a = count;
    await new Promise((r) => setTimeout(r, ms));
    const d = count - a;
    return { label, renderFps: Math.round((d * 1000) / ms), frames: d };
  };

  const out = {};
  out.visible = await rate('visible', 4000);
  // 隐藏自身 documentElement：IntersectionObserver 应报不可见 → 调度层暂停；
  // 页面 rAF 浏览器侧仍可能跑，但 player 渲染计数应停止
  document.documentElement.style.display = 'none';
  out.hidden = await rate('display-none-4s', 4000);
  document.documentElement.style.display = '';
  out.resumed = await rate('resumed', 3000);
  out.count = count;
  return out;
})()
