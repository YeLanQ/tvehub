// ---------------------------------------------------------------------------
// 白板放映页脚本（发布出去的站点的内联 JS）。
//
// 行为对齐编辑器里的放映（slide-show.ts + WhiteboardStage）：
// - 一页 = 一个可见图层，页面顺序 = 图层顺序；
// - 切页动画种类/方向/时长与编辑器一致（关键帧在 viewer-css.ts）；
// - 过渡期间旧页要压在新页下面（DOM 顺序），后退翻页时把旧页挪到新页之前；
// - 元素动画（文档自带 <style> 里的 keyframes）用根节点 tve-paused class 暂停；
// - 全屏 = 纯净放映：画布满幅、浮动栏默认隐藏（H 临时唤出），退出全屏还原窗口态。
//
// 用 ES5 写法（var/function）：分享出去的页面要在各种老旧手机浏览器里能跑，
// 不做语法转译也不引依赖。字符串里避免反引号与 ${，否则会破坏外层模板。
// ---------------------------------------------------------------------------
export const VIEWER_JS = `
(function () {
  var board = window.__TVE_BOARD__ || {};
  var stage = document.getElementById('tv-stage');
  var svg = stage ? stage.querySelector('svg') : null;
  if (!stage || !svg) return;

  var DURATION = 520;
  var layers = {};
  var order = [];
  var list = svg.querySelectorAll('g[data-tve-layer]');
  for (var i = 0; i < list.length; i++) {
    var id = list[i].getAttribute('data-tve-layer');
    layers[id] = list[i];
    order.push(id);
  }

  // 只保留 DOM 里确实存在的页（理论上不会缺，缺了也不该整页崩）
  var pages = (board.pages || []).filter(function (p) { return layers[p.id]; });
  var transition = board.transition === 'fade' || board.transition === 'stack' || board.transition === 'pushY'
    ? board.transition
    : 'pushX';
  var easing = board.easing || '';
  var auto = !!board.auto;
  var interval = Math.max(1, Math.round(board.interval || 5)) * 1000;
  var index = Math.max(0, Math.min(pages.length - 1, board.start || 0));

  var paused = false;
  var animTimer = null;
  var autoTimer = null;

  var elPage = document.getElementById('tv-page');
  var elName = document.getElementById('tv-name');
  var btnPrev = document.getElementById('tv-prev');
  var btnNext = document.getElementById('tv-next');
  var btnAuto = document.getElementById('tv-auto');
  var btnPause = document.getElementById('tv-pause');
  var btnFull = document.getElementById('tv-full');
  // 浮动栏（顶/底）与其收缩把手、收缩态摘要；DOM 引用集中在这里，
  // 后面正文只写逻辑，避免"靠 var 提升才不报错"的隐式顺序依赖
  var topbar = document.getElementById('tv-topbar');
  var footbar = document.getElementById('tv-footbar');
  var btnToggleTop = document.getElementById('tv-toggle-top');
  var btnToggleFoot = document.getElementById('tv-toggle-foot');
  var miniFoot = document.getElementById('tv-mini-foot');

  // 画板尺寸 → 位移量（与编辑器一致：整块画板宽度/高度，方向带符号）
  var dx = board.w || 1280;
  var dy = board.h || 720;

  function setVar(node, dir) {
    node.style.setProperty('--sv-dx', (dir >= 0 ? dx : -dx) + 'px');
    node.style.setProperty('--sv-dy', (dir >= 0 ? dy : -dy) + 'px');
    node.style.setProperty('--tv-dur', DURATION + 'ms');
    if (easing) node.style.setProperty('--tv-slide-ease', easing);
  }

  function clearAnim(node) {
    node.removeAttribute('class');
  }

  function applyAnim(node, role, dir) {
    var cls;
    if (transition === 'fade') cls = role === 'in' ? 'tv-fade-in' : 'tv-fade-out';
    else if (transition === 'stack') cls = role === 'in' ? 'tv-in-x' : 'tv-stack-out';
    else if (transition === 'pushY') cls = role === 'in' ? 'tv-in-y' : 'tv-out-y';
    else cls = role === 'in' ? 'tv-in-x' : 'tv-out-x';
    setVar(node, dir);
    node.setAttribute('class', cls);
  }

  function showOnly(target) {
    for (var k = 0; k < pages.length; k++) {
      var g = layers[pages[k].id];
      var on = g === target;
      g.style.visibility = on ? 'visible' : 'hidden';
      // display 交给文档本身（不可见图层本就 display:none），这里只控 visibility
    }
  }

  function label() {
    if (elPage) elPage.textContent = (index + 1) + ' / ' + pages.length;
    if (elName) elName.textContent = pages[index] ? (pages[index].name || '') : '';
    // 收缩态的底栏只剩页码，这里同步过去（展开态由 elPage 显示）
    if (miniFoot && elPage) miniFoot.textContent = elPage.textContent;
    if (btnPrev) btnPrev.disabled = pages.length < 2;
    if (btnNext) btnNext.disabled = pages.length < 2;
  }

  var inFlight = null;

  function settle() {
    if (inFlight) {
      clearTimeout(inFlight.timer);
      clearAnim(inFlight.from);
      clearAnim(inFlight.to);
      inFlight.from.style.visibility = 'hidden';
      inFlight = null;
    }
  }

  function go(dir) {
    if (pages.length < 2) return;
    var next = (index + dir + pages.length) % pages.length;
    jump(next, dir);
  }

  function jump(next, dir) {
    settle();
    var from = layers[pages[index].id];
    var to = layers[pages[next].id];
    index = next;

    // 过渡期间两页同时可见，旧页必须压在新页下面：后退时把旧页挪到新页之前
    if (from && to && from !== to) {
      var fromIdx = order.indexOf(from.getAttribute('data-tve-layer'));
      var toIdx = order.indexOf(to.getAttribute('data-tve-layer'));
      if (fromIdx > toIdx) to.parentNode.insertBefore(from, to);
    }

    if (!from || from === to) {
      showOnly(to);
      label();
      return;
    }

    to.style.visibility = 'visible';
    applyAnim(to, 'in', dir);
    applyAnim(from, 'out', dir);
    inFlight = {
      from: from,
      to: to,
      timer: setTimeout(function () {
        clearAnim(from);
        clearAnim(to);
        from.style.visibility = 'hidden';
        inFlight = null;
      }, DURATION)
    };
    label();
  }

  // -------------------------------------------------------------------------
  // 浮动栏：收缩隐藏 + 给画布让位
  //
  // 两栏是覆盖在画布上的浮动元素（不占布局），必须显式把高度写进 --tv-pad-*，
  // 否则画板会被栏压住；窄屏下底栏会换行变高，所以按实测矩形算而不是写死常量。
  // 收缩状态存 localStorage：看的人收起过一次，下次打开不该又被撑开。
  // （元素引用见文件开头那组 getElementById）
  // -------------------------------------------------------------------------
  var STORE_KEY = 'tve:board-viewer:bars';

  function readBars() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {}; // 隐私模式等场景下 localStorage 不可用：不持久化，功能不受影响
    }
  }

  function writeBars(state) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      /* 存不了就算了，本次会话内仍然有效 */
    }
  }

  var bars = readBars();

  /** 把两栏占用的高度写进画布内边距（含栏与画板之间的视觉间隔）；全屏时归零（满幅放映） */
  function reserveChrome() {
    if (inFullscreen()) {
      stage.style.setProperty('--tv-pad-top', '0px');
      stage.style.setProperty('--tv-pad-bottom', '0px');
      return;
    }
    var gap = 12;
    var topPad = gap;
    var bottomPad = gap;
    if (topbar) {
      var tr = topbar.getBoundingClientRect();
      topPad = tr.bottom + gap;
    }
    if (footbar) {
      var fr = footbar.getBoundingClientRect();
      bottomPad = window.innerHeight - fr.top + gap;
    }
    stage.style.setProperty('--tv-pad-top', Math.round(topPad) + 'px');
    stage.style.setProperty('--tv-pad-bottom', Math.round(bottomPad) + 'px');
  }

  function applyBar(bar, toggle, collapsed) {
    if (!bar || !toggle) return;
    bar.className = 'tv-bar ' + (bar === topbar ? 'tv-bar-top' : 'tv-bar-foot') + (collapsed ? ' collapsed' : '');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute(
      'aria-label',
      (bar === topbar ? '标题栏' : '播放栏') + (collapsed ? '：展开' : '：收起'),
    );
  }

  function syncBars() {
    applyBar(topbar, btnToggleTop, !!bars.top);
    applyBar(footbar, btnToggleFoot, !!bars.foot);
    reserveChrome();
  }

  function toggleBar(which) {
    bars[which] = !bars[which];
    writeBars(bars);
    syncBars();
  }

  /** H：一次收起/展开全部浮动栏（放映时把画面还给内容）；全屏中改为临时唤出/隐藏 */
  function toggleChrome() {
    if (inFullscreen()) {
      fsChrome = !fsChrome;
      if (fsChrome) document.body.classList.add('tv-fs-chrome');
      else document.body.classList.remove('tv-fs-chrome');
      return;
    }
    var hide = !(bars.top && bars.foot);
    bars.top = hide;
    bars.foot = hide;
    writeBars(bars);
    syncBars();
  }

  if (btnToggleTop) btnToggleTop.onclick = function () { toggleBar('top'); };
  if (btnToggleFoot) btnToggleFoot.onclick = function () { toggleBar('foot'); };

  // 栏尺寸变化（换行、字号、收缩）后重新让位
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(function () { reserveChrome(); });
    if (topbar) ro.observe(topbar);
    if (footbar) ro.observe(footbar);
  }
  window.addEventListener('resize', reserveChrome);
  window.addEventListener('orientationchange', reserveChrome);

  // -------------------------------------------------------------------------
  // 全屏（纯净放映）：画布满幅（reserveChrome 归零让位，黑边即源于让位），
  // 两栏默认隐藏（CSS 随 body.tv-fs 生效）。H 临时唤出时覆盖在画面上——
  // 只改会话标志、不写 localStorage，退出全屏自动还原窗口态的收展偏好。
  // -------------------------------------------------------------------------
  var fsChrome = false;

  function inFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function applyFs() {
    var fs = inFullscreen();
    if (fs) {
      document.body.classList.add('tv-fs');
      if (fsChrome) document.body.classList.add('tv-fs-chrome');
      else document.body.classList.remove('tv-fs-chrome');
    } else {
      fsChrome = false;
      document.body.classList.remove('tv-fs');
      document.body.classList.remove('tv-fs-chrome');
    }
    reserveChrome();
  }

  document.addEventListener('fullscreenchange', applyFs);
  document.addEventListener('webkitfullscreenchange', applyFs);

  function syncAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (auto && pages.length > 1) {
      autoTimer = setInterval(function () { go(1); }, interval);
    }
    if (btnAuto) btnAuto.className = 'tv-btn' + (auto ? ' on' : '');
  }

  function togglePause() {
    paused = !paused;
    if (paused) svg.classList.add('tve-paused');
    else svg.classList.remove('tve-paused');
    if (btnPause) btnPause.textContent = paused ? '继续动画' : '暂停动画';
  }

  function fullscreen() {
    var el = document.documentElement;
    if (inFullscreen()) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (el.requestFullscreen) {
      el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  }

  if (btnPrev) btnPrev.onclick = function () { go(-1); };
  if (btnNext) btnNext.onclick = function () { go(1); };
  if (btnAuto) btnAuto.onclick = function () { auto = !auto; syncAuto(); };
  if (btnPause) btnPause.onclick = togglePause;
  if (btnFull) btnFull.onclick = fullscreen;

  // 点画布：左半上一页、右半下一页（手机上最顺手）
  stage.addEventListener('click', function (e) {
    var rect = stage.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) go(-1);
    else go(1);
  });

  // 左右滑
  var touchX = null;
  stage.addEventListener('touchstart', function (e) {
    touchX = e.touches[0] ? e.touches[0].clientX : null;
  }, { passive: true });
  stage.addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var end = e.changedTouches[0] ? e.changedTouches[0].clientX : touchX;
    var delta = end - touchX;
    touchX = null;
    if (Math.abs(delta) > 40) go(delta < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'f' || e.key === 'F') {
      fullscreen();
    } else if (e.key === 'p' || e.key === 'P') {
      togglePause();
    } else if (e.key === 'h' || e.key === 'H') {
      toggleChrome();
    }
  });

  // 初始页：先全部落定，再显示起始页（页面尚未 ready 时图层都是隐藏的）
  showOnly(pages[index] ? layers[pages[index].id] : null);
  stage.classList.add('tv-ready');
  label();
  syncAuto();
  syncBars(); // 恢复上次的收缩状态，并按两栏实际高度给画布让位
})();
`;
