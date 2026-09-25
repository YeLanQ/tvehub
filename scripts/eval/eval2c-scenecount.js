// 评测②c：player 实际渲染频率（Object3D.prototype.updateMatrixWorld + isScene 过滤）
// renderer.render 每帧对 scene 恰好调用一次 updateMatrixWorld；refitShadowCameras
// 每 20 帧额外 +1（≈3/s 偏置）。隐藏 → 暂停 → 计数停止。
(async () => {
  const THREE = await import('/engine/core/three.module.min.js');
  const proto = THREE.Object3D.prototype;
  if (proto.__tveProbe) return { err: 'already patched' };
  let count = 0;
  const orig = proto.updateMatrixWorld;
  const patched = function (force) {
    if (this.isScene === true) count++;
    return orig.call(this, force);
  };
  patched.__tveProbe = true;
  proto.updateMatrixWorld = patched;

  const rate = async (label, ms) => {
    const a = count;
    await new Promise((r) => setTimeout(r, ms));
    const d = count - a;
    return { label, perSec: +(d / (ms / 1000)).toFixed(1), frames: d };
  };

  const out = {};
  out.visible4s = await rate('visible', 4000);
  document.documentElement.style.display = 'none';
  out.hidden4s = await rate('display-none', 4000);
  document.documentElement.style.display = '';
  out.resumed3s = await rate('resumed', 3000);
  out.total = count;
  return out;
})()
