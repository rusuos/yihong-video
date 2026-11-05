/* 场景脚本：与 timeline.json 的 scenes 一一对应，顺序必须一致。
 *
 * 每个场景一个对象：
 *   path(d)   -> [[时间, x, y], ...]  光标轨迹，时间用 d 的比例表达，随场景时长自适应
 *   clicks(d) -> [t1, t2, ...]        点击时刻
 *   render(t, d)                      把这一帧的所有元素状态写出来
 *
 * 时序约定：F = d - 0.45，所有动作安排在 [0, F] 内，最后 0.45s 留白收尾，
 * 避免切场景时动作还没播完（这是最常见的"卡住"感来源）。
 */
(function () {
  const { S, win, ease, easeOut, cl, C, fade, typeInto } = window.DV;

  /* ---------- 场景 1 ---------- */
  window.SC.push({
    path: (d) => {
      const F = d - 0.45, P = (x) => x * F;
      const b = C("#c1btn");
      return [[0, 700, 830], [P(0.42), 640, 650], [P(0.58), b[0], b[1]]];
    },
    clicks: (d) => [(d - 0.45) * 0.60],
    render: (t, d) => {
      const F = d - 0.45, P = (x) => x * F;

      // 卡片从下往上浮入
      fade(S("c1"), easeOut(win(t, P(0.04), P(0.30))), 22);

      // 按钮弹性入场
      const kb = easeOut(win(t, P(0.22), P(0.44)));
      const btn = S("c1btn");
      btn.style.opacity = kb;
      btn.style.transform = "translateY(" + (1 - kb) * 18 + "px) scale(" + (0.94 + 0.06 * kb) + ")";

      // 点击后变色 + 文案切换（点击时刻必须与 clicks() 完全一致）
      const ct = (d - 0.45) * 0.60;
      btn.style.background = t > ct ? "#1d4ed8" : "#2563eb";
      btn.textContent = t > ct + 0.25 ? "已开始 ✓" : "立即开始";
    },
  });

  /* ---------- 场景 2：照抄上面结构，改 id ---------- */
  // window.SC.push({ ... });
})();
