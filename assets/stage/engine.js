/* 演示视频引擎（通用，不要改这个文件；场景逻辑写在 scenes.js）
 *
 * 核心约定：页面上的一切视觉状态都是时间 t 的纯函数。
 *   window.seek(t)  把整页渲染成 t 时刻的样子
 *   window.__total  总时长（来自 timeline.js）
 * Playwright 逐帧 seek(f/fps) 后截图，再由 ffmpeg 定帧合成 —— 音画天然同步。
 *
 * 因此：styles.css 里禁止 transition / animation；场景里不要用 setTimeout / requestAnimationFrame。
 */
(function () {
  const S = (id) => document.getElementById(id);
  const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => { t = cl(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const easeOut = (t) => { t = cl(t); return 1 - Math.pow(1 - t, 3); };
  const easeIn = (t) => { t = cl(t); return t * t * t; };
  const win = (t, a, b) => cl((t - a) / (b - a || 1e-6));
  const money = (n) => "¥" + Math.round(n).toLocaleString("en-US");
  const pulse = (t, f) => 0.5 + 0.5 * Math.sin(t * f);

  /* ---- 元素中心：光标目标用真实布局坐标，避免手算 ----
     惰性缓存；元素不可见（display:none / 尺寸为 0）时不缓存，等可见后重取。 */
  const CC = {};
  function C(sel) {
    if (CC[sel]) return CC[sel];
    const el = document.querySelector(sel);
    if (!el) { console.warn("C(): 找不到", sel); return [400, 500]; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return [400, 500];
    CC[sel] = [r.left + r.width / 2, r.top + r.height / 2];
    return CC[sel];
  }

  /* ---- 光标 ---- */
  const cursorEl = S("cursor"), rippleEl = S("ripple");
  const CUR = { x: 400, y: 760 };

  function cursorUpdate(t, path, clicks) {
    let x = path[0][1], y = path[0][2];
    const last = path[path.length - 1];
    if (t >= last[0]) { x = last[1]; y = last[2]; }
    else if (t > path[0][0]) {
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        if (t >= a[0] && t <= b[0]) {
          const k = ease(win(t, a[0], b[0]));
          x = lerp(a[1], b[1], k); y = lerp(a[2], b[2], k);
          break;
        }
      }
    }
    CUR.x = x; CUR.y = y;

    let sc = 1, rip = null;
    for (const c of clicks) {
      if (t >= c && t < c + 0.18) sc = 1 - 0.18 * Math.sin(((t - c) / 0.18) * Math.PI);
      if (t >= c && t < c + 0.5) rip = (t - c) / 0.5;
    }
    cursorEl.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px) scale(" + sc.toFixed(3) + ")";
    if (rip !== null) {
      rippleEl.style.left = x + "px"; rippleEl.style.top = y + "px";
      rippleEl.style.opacity = (1 - rip) * 0.9;
      rippleEl.style.transform = "scale(" + (0.5 + rip * 2.4).toFixed(2) + ")";
    } else rippleEl.style.opacity = 0;
  }

  /* ---- 悬停 / 按下：用 elementFromPoint 反查，不依赖 CSS :hover ---- */
  const HOVER_SEL = ".card,.btn,.node,.chip,.row,.tab,.file,.badge,.sw";
  let hovered = null;
  function hoverUpdate(t, clicks) {
    const el = document.elementFromPoint(CUR.x, CUR.y);
    let target = null, n = el;
    for (let i = 0; i < 6 && n; i++) {
      if (n.matches && n.matches(HOVER_SEL)) { target = n; break; }
      n = n.parentElement;
    }
    if (target !== hovered) {
      if (hovered) hovered.classList.remove("cur-hover", "press");
      hovered = target;
    }
    if (hovered) {
      hovered.classList.add("cur-hover");
      let pressing = false;
      for (const c of clicks) if (t >= c && t < c + 0.16) pressing = true;
      hovered.classList.toggle("press", pressing);
    }
  }

  /* ---- 场景常用小工具 ---- */
  function fade(el, k, dy) {
    if (!el) return;
    el.style.opacity = k;
    if (dy !== undefined) el.style.transform = "translateY(" + (1 - k) * dy + "px)";
  }
  function typeInto(el, full, p) {
    if (el) el.textContent = full.slice(0, Math.max(0, Math.round(full.length * cl(p))));
  }
  function flowDash(sel, t, speed) {
    document.querySelectorAll(sel).forEach((p) => { p.style.strokeDashoffset = -(t * (speed || 40)); });
  }

  window.DV = { S, cl, lerp, ease, easeOut, easeIn, win, money, pulse, C, fade, typeInto, flowDash };
  window.SC = [];

  /* ---- 主循环 ---- */
  const TL = window.TIMELINE;
  const scenes = TL.scenes;
  const nodes = scenes.map((s) => S("sc" + s.id));
  let curIdx = -1;
  const NOOP = { path: () => [[0, 400, 760]], clicks: () => [], render: () => {} };

  window.seek = function (t) {
    let i = 0;
    for (let k = 0; k < scenes.length; k++) if (t >= scenes[k].start) i = k;
    if (i !== curIdx) {
      nodes.forEach((n, k) => { if (n) n.style.display = k === i ? "block" : "none"; });
      curIdx = i;
      const idxEl = S("sceneIdx");
      if (idxEl) idxEl.textContent = String(i + 1).padStart(2, "0") + " / " + String(scenes.length).padStart(2, "0");
    }
    const s = scenes[i];
    const lt = t - s.start;
    const d = s.dur;
    const spec = window.SC[i] || NOOP;
    const clicks = spec.clicks(d);
    cursorUpdate(lt, spec.path(d), clicks);
    spec.render(lt, d);
    hoverUpdate(lt, clicks);

    const nd = nodes[i];
    if (nd) {
      const k = i === 0 ? 1 : easeOut(cl(lt / 0.45));
      const hd = nd.querySelector(".head"), hb = nd.querySelector(".hdr");
      if (hd) { hd.style.opacity = k; hd.style.transform = "translateY(" + (1 - k) * 14 + "px)"; }
      if (hb) hb.style.opacity = 0.4 + 0.6 * k;
    }
    window.__idx = i;
  };

  window.__total = TL.total;
  window.__scenes = scenes;
  document.addEventListener("DOMContentLoaded", () => window.seek(0));
})();
