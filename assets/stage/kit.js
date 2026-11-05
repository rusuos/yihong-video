/* kit.js — 通用画面工具箱（与题材无关）
 *
 * 解决的问题：手写 SVG 坐标只会得到"几个方块 + 箭头"，细节加不上去，
 * 换个场景又要重画一遍。这个文件把"细节"变成参数：
 *   - 一套色阶：给一个主色，自动派生 5 级明暗；材质从色阶里取，全片不会脏
 *   - 分层画布：bg / struct / content / fx / annot 五层 + 层内 z 排序，
 *     元素再多也不会互相压错
 *   - 图元：卡片、节点、正交连线、引导线标签、柱/折线/环/刻度
 *   - 等距体块：任意 2D 轮廓挤出成实体（盒子、圆柱、齿形、地图板块、分层台），
 *     带法线光照 + 按零件中心的深度排序
 *   - 时间函数：K.key(t, 关键帧) 把"某段旁白对应的状态"写成纯函数
 *
 * 用法：
 *   var c = K.canvas(712, 600, { acc: "#2563eb" });
 *   c.rect({x:0, y:0, w:300, h:120, r:16, mat:"card"});
 *   c.text({x:18, y:40, s:"标题", size:16, weight:700});
 *   document.getElementById("slot").innerHTML = c.svg();
 *
 * 每个 API 的参数说明见 references/scene-graphics.md。
 */
(function (global) {
  "use strict";

  var PI2 = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v) { return String(parseFloat(parseFloat(v).toFixed(2))); }

  /* ==================== 1. 颜色 ==================== */
  function toRGB(c) {
    if (Array.isArray(c)) return c;
    var h = String(c).trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function css(a) { return "rgb(" + (a[0] | 0) + "," + (a[1] | 0) + "," + (a[2] | 0) + ")"; }

  var K = {};
  K.clamp = clamp;
  K.rgb = toRGB;

  /* k<1 变暗，k>1 提亮（不会过曝） */
  K.shade = function (c, k) {
    var a = toRGB(c), t;
    if (k <= 1) return css([a[0] * k, a[1] * k, a[2] * k]);
    t = k - 1;
    return css([a[0] + (255 - a[0]) * t, a[1] + (255 - a[1]) * t, a[2] + (255 - a[2]) * t]);
  };
  K.mix = function (c1, c2, t) {
    var a = toRGB(c1), b = toRGB(c2);
    return css([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  };
  K.alpha = function (c, a) {
    var x = toRGB(c);
    return "rgba(" + (x[0] | 0) + "," + (x[1] | 0) + "," + (x[2] | 0) + "," + a + ")";
  };

  /* 一套完整的语义色阶：全片只用这一套，材质就不会花 */
  K.palette = function (acc) {
    acc = acc || "#2563eb";
    return {
      acc: acc,
      accD: K.shade(acc, 0.76), accL: K.shade(acc, 1.62), accF: K.alpha(acc, 0.10),
      ink: "#16233b", sub: "#5d7391", weak: "#8ea1bd",
      line: "#e3ecfa", edge: "#cfe0f4",
      surface: "#ffffff", bg0: "#ffffff", bg1: "#eef4ff", bg2: "#dbeafe",
      ok: "#0f9d70", warn: "#e08c1a", bad: "#d94a44",
      steel: "#96b8dc", steelL: "#cfe2f7", steelD: "#5c7699",
      sand: "#c8a664", slate: "#7d8fa6"
    };
  };

  /* ==================== 2. 随机 / 文本度量 ==================== */
  K.rng = function (seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a += 0x6D2B79F5;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* 估算字宽：CJK 1em，大写/数字 .62em，小写 .52em。够用来排版，不要拿去对齐像素 */
  K.tw = function (s, size) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === " ") w += 0.3;
      else if (ch.charCodeAt(0) > 255) w += 1;
      else if (/[A-Z0-9]/.test(ch)) w += 0.62;
      else w += 0.52;
    }
    return w * size;
  };

  K.wrap = function (s, maxW, size) {
    s = String(s == null ? "" : s);
    var lines = [], cur = "", curW = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "\n") { lines.push(cur); cur = ""; curW = 0; continue; }
      var w = K.tw(ch, size);
      if (curW + w > maxW && cur) {
        var sp = cur.lastIndexOf(" ");
        if (sp > 2 && /[A-Za-z0-9]/.test(ch) && cur.length - sp < 16) {
          lines.push(cur.slice(0, sp));
          cur = cur.slice(sp + 1) + ch;
          curW = K.tw(cur, size);
          continue;
        }
        lines.push(cur); cur = ch; curW = w;
      } else { cur += ch; curW += w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };

  /* 数字格式化：9200 -> 9,200；1.2e8 -> 1.2 亿 */
  K.fmt = function (v, o) {
    o = o || {};
    if (o.cn && Math.abs(v) >= 1e8) return parseFloat((v / 1e8).toFixed(2)) + " 亿";
    if (o.cn && Math.abs(v) >= 1e4) return parseFloat((v / 1e4).toFixed(1)) + " 万";
    if (o.pct != null) return (v * 100).toFixed(o.pct) + "%";
    var d = o.dec == null ? 0 : o.dec;
    var s = Math.abs(v).toFixed(d);
    var p = s.split(".");
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (v < 0 ? "-" : "") + p.join(".") + (o.suffix || "");
  };

  /* ==================== 3. 时间函数 ==================== */
  var ease = function (t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  var easeOut = function (t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); };
  var easeIn = function (t) { t = clamp(t, 0, 1); return t * t * t; };
  var win = function (t, a, b) { return clamp((t - a) / (b - a || 1e-6), 0, 1); };

  K.ease = ease; K.easeOut = easeOut; K.easeIn = easeIn; K.win = win;
  K.lerp = function (a, b, t) { return a + (b - a) * t; };

  /* 关键帧插值：K.key(t, [[0, .2], [3, .9]]) —— 把"旁白推进"写成状态曲线 */
  K.key = function (t, frames, fn) {
    fn = fn || easeOut;
    if (!frames || !frames.length) return 0;
    if (t <= frames[0][0]) return frames[0][1];
    for (var i = 0; i < frames.length - 1; i++) {
      var a = frames[i], b = frames[i + 1];
      if (t >= a[0] && t <= b[0]) return a[1] + (b[1] - a[1]) * fn(win(t, a[0], b[0]));
    }
    return frames[frames.length - 1][1];
  };

  /* 错峰入场：第 i 个元素在 start + i*gap 起，dur 秒内完成 */
  K.seq = function (t, i, start, gap, dur) {
    return easeOut(win(t, start + i * gap, start + i * gap + dur));
  };

  /* ==================== 4. 画布 ==================== */
  var LAYERS = { bg: 0, struct: 1, content: 2, fx: 3, annot: 4 };

  function Canvas(w, h, o) {
    o = o || {};
    this.w = w; this.h = h;
    this.P = K.palette(o.acc);
    this.items = [];
    this.defs = [];
    this._layer = "content";
    this._z = 0;
    this._uid = 0;
    this.id = "k" + (Canvas._n = (Canvas._n || 0) + 1);
  }
  Canvas.prototype.pal = function () { return this.P; };

  Canvas.prototype.res = function (c) {
    if (c == null) return null;
    if (typeof c !== "string") return c;
    if (c[0] === "#" || c.indexOf("rgb") === 0 || c === "none" || c === "transparent") return c;
    return this.P[c] != null ? this.P[c] : c;
  };

  Canvas.prototype.layer = function (name, fn) {
    if (fn) { var p = this._layer; this._layer = name; fn(this); this._layer = p; return this; }
    this._layer = name;
    return this;
  };

  Canvas.prototype._push = function (svg, o) {
    o = o || {};
    var li = LAYERS[o.layer || this._layer] || 0;
    this.items.push({ li: li, z: o.z == null ? this._z : o.z, s: svg, q: this.items.length });
    return this;
  };

  Canvas.prototype._attrs = function (o) {
    var a = "";
    if (o.fill) a += ' fill="' + this.res(o.fill) + '"';
    if (o.stroke) {
      a += ' stroke="' + this.res(o.stroke) + '"';
      a += ' stroke-width="' + num(o.sw == null ? 1 : o.sw) + '"';
      if (o.dash) a += ' stroke-dasharray="' + o.dash + '"';
      a += ' stroke-linecap="' + (o.cap || "round") + '" stroke-linejoin="' + (o.join || "round") + '"';
    }
    if (o.op != null && o.op !== 1) a += ' opacity="' + num(o.op) + '"';
    if (o.transform) a += ' transform="' + o.transform + '"';
    if (o.blur) a += ' filter="' + this._soft() + '"';
    return a;
  };

  Canvas.prototype._soft = function () {
    var id = "ks" + this.id;
    if (!this._hasSoft) {
      this._hasSoft = 1;
      this.defs.push('<filter id="' + id + '" x="-40%" y="-40%" width="180%" height="180%">' +
        '<feDropShadow dx="0" dy="10" stdDeviation="11" flood-color="#1b3b6f" flood-opacity="0.14"/></filter>');
    }
    return "url(#" + id + ")";
  };

  /* ---- 基础图元 ---- */
  Canvas.prototype.rect = function (o) {
    var r = o.r == null ? (o.radius == null ? 12 : o.radius) : o.r;
    var a = this._attrs(o) + (o.blur ? "" : (o.shadow ? ' filter="' + this._soft() + '"' : ""));
    return this._push('<rect x="' + num(o.x || 0) + '" y="' + num(o.y || 0) + '" width="' + num(o.w) +
      '" height="' + num(o.h) + '" rx="' + num(r) + '"' + a + '/>', o);
  };

  Canvas.prototype.circle = function (o) {
    return this._push('<circle cx="' + num(o.x) + '" cy="' + num(o.y) + '" r="' + num(o.r) + '"' + this._attrs(o) + '/>', o);
  };

  Canvas.prototype.ellipse = function (o) {
    return this._push('<ellipse cx="' + num(o.x) + '" cy="' + num(o.y) + '" rx="' + num(o.rx) + '" ry="' + num(o.ry) +
      '"' + this._attrs(o) + '/>', o);
  };

  /* pts: [[x,y],...] 或 "x,y x,y" */
  Canvas.prototype.poly = function (o) {
    var pts = typeof o.pts === "string" ? o.pts : o.pts.map(function (p) { return num(p[0]) + "," + num(p[1]); }).join(" ");
    var tag = o.closed === false ? "polyline" : "polygon";
    return this._push("<" + tag + ' points="' + pts + '"' + this._attrs(o) +
      (o.closed === false ? ' fill="none"' : "") + "/>", o);
  };

  Canvas.prototype.line = function (o) {
    return this.poly({ pts: o.pts, closed: false, stroke: o.stroke || "line", sw: o.sw, dash: o.dash,
      op: o.op, layer: o.layer, z: o.z, cap: o.cap });
  };

  Canvas.prototype.path = function (o) {
    return this._push('<path d="' + o.d + '"' + this._attrs(o) + '/>', o);
  };

  /* 胶囊/标签底 */
  Canvas.prototype.pill = function (o) {
    var padX = o.padX == null ? 12 : o.padX;
    var w = o.w == null ? K.tw(o.s || "", o.size || 11.5) + padX * 2 : o.w;
    var h = o.h == null ? 26 : o.h;
    this.rect({ x: o.x, y: o.y, w: w, h: h, r: h / 2, fill: o.fill || "accF", stroke: o.stroke, sw: o.sw,
      layer: o.layer, z: o.z, op: o.op });
    if (o.s) this.text({ x: o.x + w / 2, y: o.y + h / 2 + 4, s: o.s, size: o.size || 11.5,
      weight: 700, fill: o.color || "acc", anchor: "middle", ls: o.ls, layer: o.layer, z: (o.z || 0) + 0.1 });
    return w;
  };

  /* 多行文本；s 可以是字符串（按 \n 或自动换行）或字符串数组（每项一行）；返回占据高度 */
  Canvas.prototype.text = function (o) {
    var raw = o.s == null ? "" : o.s;
    var size = o.size == null ? 13.5 : o.size;
    var lines;
    if (Array.isArray(raw)) lines = raw.map(String);
    else if (o.nowrap) lines = [String(raw)];
    else lines = String(raw).split("\n");
    var lh = o.lh == null ? size * (o.loose ? 1.75 : 1.55) : o.lh;
    var anchor = o.anchor || "start";
    var x = o.x, y0 = o.y;
    var extra = "";
    if (o.ls) extra += ' letter-spacing="' + o.ls + '"';
    if (o.italic) extra += ' font-style="italic"';
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      out.push('<text x="' + num(x) + '" y="' + num(y0 + i * lh) + '" font-size="' + num(size) +
        '" font-weight="' + (o.weight || 400) + '" text-anchor="' + anchor + '"' + extra + this._attrs(o) +
        ' xml:space="preserve">' + esc(lines[i]) + "</text>");
    }
    this._push(out.join(""), o);
    return lines.length * lh;
  };

  Canvas.prototype.raw = function (svg, o) { return this._push(svg, o); };

  /* ==================== 5. 语义化图元 ==================== */

  /* 卡片：白底 + 细边 + 投影 + 顶部高光，和 styles.css 的 .card 视觉一致 */
  Canvas.prototype.card = function (o) {
    var r = o.r == null ? 16 : o.r;
    this.rect({ x: o.x, y: o.y, w: o.w, h: o.h, r: r, fill: o.fill || "surface",
      stroke: o.stroke || "line", sw: o.sw == null ? 1 : o.sw, shadow: o.shadow !== false,
      op: o.op, layer: o.layer, z: o.z, blur: o.blur });
    if (o.glow) {
      this.rect({ x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2, r: r - 1,
        fill: "none", stroke: "acc", sw: 1.4, op: o.glow, layer: o.layer, z: (o.z || 0) + 0.1 });
    }
    return this;
  };

  /* 左侧强调条：短竖条 + 圆角端头，上下让开卡片的圆角区。
   * 直接拿 rect 画会在圆角处露出方角；跟着圆角裁形又会在描边上多出一道"钩"，
   * 两种都很显廉价。让开圆角是最省事、也最稳的画法。
   * accent({ x, y, w, h, r, thick, color, inset, insetY, z })  —— x/y/w/h/r 传卡片的 */
  Canvas.prototype.accent = function (o) {
    var t = o.thick == null ? 4 : o.thick;
    var ip = o.inset == null ? 1 : o.inset;
    var r = o.r == null ? 14 : o.r;
    var iy = o.insetY == null ? Math.min(r, o.h * 0.25) : o.insetY;
    var bh = Math.max(t, o.h - iy * 2);
    return this.rect({ x: o.x + ip, y: o.y + (o.h - bh) / 2, w: t, h: bh, r: t / 2,
      fill: o.color || "acc", op: o.op, layer: o.layer, z: o.z == null ? 5 : o.z });
  };

  /* 节点：流程图/架构图用。自动按文字撑高，返回实际高度。
   * 有 icon 时正文与标题共用同一条左基准线（否则正文会比标题左凸 29px）。
   * 基线按字高算，不按行盒算，卡片上下留白才对称。 */
  Canvas.prototype.node = function (o) {
    var padX = o.padX == null ? 16 : o.padX;
    var padY = o.padY == null ? 14 : o.padY;
    var ts = o.titleSize || 14.5, bs = o.bodySize || 12.5;
    var ind = o.icon ? 29 : 0;
    var innerW = o.w - padX * 2 - ind;
    var body = o.body ? K.wrap(o.body, innerW, bs) : [];
    var tLH = ts * 1.42, bLH = bs * 1.62;
    var bTail = body.length ? bLH - bs * 1.15 : 0;          // 末行行盒的下半留白不算高度
    var innerH = padY * 2 + (o.title ? tLH : 0) + body.length * bLH - bTail;
    var h = o.h || innerH;
    /* 显式给了 h：内容垂直居中，否则文字全挤在顶上、下半截空着 */
    var dy = h > innerH ? (h - innerH) / 2 : 0;
    var z = o.z == null ? 0 : o.z;
    var accent = o.accent || "acc";
    var r = o.r == null ? 13 : o.r;

    this.card({ x: o.x, y: o.y, w: o.w, h: h, r: r,
      fill: o.fill, stroke: o.active ? accent : (o.stroke || "line"),
      sw: o.active ? 1.6 : 1, op: o.op, layer: o.layer, z: z, shadow: o.shadow });
    if (o.active) {
      this.accent({ x: o.x, y: o.y, w: o.w, h: h, r: r, thick: 3.6, color: accent,
        op: o.op, layer: o.layer, z: z + 0.2 });
    }
    var tx = o.x + padX + ind;
    var cy = o.y + padY + dy + ts * 0.80;
    if (o.icon) {
      this.circle({ x: o.x + padX + 11, y: cy - ts * 0.42, r: 11, fill: K.alpha(accent, 0.12), layer: o.layer, z: z + 0.2 });
      this.text({ x: o.x + padX + 11, y: cy - ts * 0.42 + 4.4, s: o.icon, size: 12, weight: 700,
        fill: accent, anchor: "middle", layer: o.layer, z: z + 0.3 });
    }
    if (o.title) {
      this.text({ x: tx, y: cy, s: o.title, size: ts, weight: 700,
        fill: o.titleColor || "ink", layer: o.layer, z: z + 0.3 });
    }
    if (body.length) {
      this.text({ x: tx, y: o.y + padY + dy + (o.title ? tLH : 0) + bs * 0.80,
        s: body, size: bs, lh: bLH, fill: o.bodyColor || "sub", layer: o.layer, z: z + 0.3 });
    }
    return h;
  };

  /* 正交连线：自动避开两端、拐直角、末端箭头。p 为 0..1 生长进度 */
  Canvas.prototype.edge = function (o) {
    var a = o.from, b = o.to, p = o.p == null ? 1 : clamp(o.p, 0, 1);
    if (p <= 0.001) return this;
    var mode = o.route || "auto";
    var pts;
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (mode === "straight" || (mode === "auto" && Math.abs(dx) < 6)) {
      pts = [a, b];
    } else if (mode === "v" || (mode === "auto" && Math.abs(dy) > Math.abs(dx) * 1.6)) {
      var my = (a[1] + b[1]) / 2;
      pts = [a, [a[0], my], [b[0], my], b];
    } else if (mode === "curve") {
      var c1 = [a[0] + dx * 0.5, a[1]], c2 = [b[0] - dx * 0.5, b[1]];
      return this._edgePath(o, "M" + num(a[0]) + "," + num(a[1]) + " C" + num(c1[0]) + "," + num(c1[1]) + " " +
        num(c2[0]) + "," + num(c2[1]) + " " + num(b[0]) + "," + num(b[1]), a, b, p);
    } else {
      var mx = (a[0] + b[0]) / 2;
      pts = [a, [mx, a[1]], [mx, b[1]], b];
    }
    var d = "M" + pts.map(function (q) { return num(q[0]) + "," + num(q[1]); }).join(" L");
    return this._edgePath(o, d, a, b, p, pts);
  };

  Canvas.prototype._edgePath = function (o, d, a, b, p, pts) {
    var col = o.color || "steel";
    var z = o.z == null ? 0 : o.z;
    var dash = o.dash;
    var sw = o.sw == null ? 2 : o.sw;
    var grow = p < 1 ? ' stroke-dasharray="' + num(1) + '" pathLength="1" stroke-dashoffset="' + num(1 - p) + '"' : "";
    if (dash && p >= 1) grow = ' stroke-dasharray="' + dash + '"';
    this._push('<path d="' + d + '" fill="none" stroke="' + this.res(col) + '" stroke-width="' + num(sw) +
      '" stroke-linecap="round" stroke-linejoin="round"' + grow +
      (o.op != null ? ' opacity="' + num(o.op) + '"' : "") + ' data-edge="1"/>', { layer: o.layer, z: z });

    if (o.arrow !== false && p > 0.85) {
      var ang;
      if (pts && pts.length > 1) {
        var q1 = pts[pts.length - 2], q2 = pts[pts.length - 1];
        ang = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
      } else ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      var s = o.head || 7.5;
      var x = b[0], y = b[1];
      var p1 = [x - s * Math.cos(ang - 0.42), y - s * Math.sin(ang - 0.42)];
      var p2 = [x - s * Math.cos(ang + 0.42), y - s * Math.sin(ang + 0.42)];
      this.poly({ pts: [[x, y], p1, p2], fill: col, layer: o.layer, z: z + 0.1 });
    }
    /* 标签落在线的"侧面"而不是线上：竖线放右边、横线放上方，
       否则文字会被线穿过去（最常见的是竖连线的 label） */
    if (o.label) {
      var vert = Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]);
      var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      var lx = mx + (o.labelDx == null ? (vert ? 7 : 0) : o.labelDx);
      var ly = my + (o.labelDy == null ? (vert ? 4 : -7) : o.labelDy);
      this.text({ x: lx, y: ly, s: o.label, size: 11, weight: 600, fill: o.labelColor || "sub",
        anchor: vert ? "start" : "middle", layer: o.layer, z: z + 0.2 });
    }
    return this;
  };

  /* 引导线标签：文字贴边，一条细线指向目标点。线自动接到离目标最近的那条边 */
  Canvas.prototype.callout = function (o) {
    var anchor = o.anchor || "start";
    var tw = K.tw(o.s, o.size || 12);
    var padX = 9, h = 24;
    var bw = tw + padX * 2;
    var bx = anchor === "end" ? o.x - bw : anchor === "middle" ? o.x - bw / 2 : o.x;
    var z = o.z == null ? 10 : o.z;
    var my = o.y + h / 2;
    var ax = o.to[0] < bx + bw / 2 ? bx : bx + bw;
    this.line({ pts: [o.to, [ax, my]], stroke: o.color || "acc", sw: 1.2, dash: "3 4",
      op: o.op == null ? 0.75 : o.op, layer: o.layer || "annot", z: z });
    this.circle({ x: o.to[0], y: o.to[1], r: 2.6, fill: o.color || "acc", layer: o.layer || "annot", z: z + 0.1 });
    this.rect({ x: bx, y: o.y, w: bw, h: h, r: 7, fill: "surface", stroke: "edge", sw: 1,
      op: o.op, layer: o.layer || "annot", z: z + 0.2 });
    this.text({ x: bx + padX, y: o.y + 16.2, s: o.s, size: o.size || 12, weight: 600,
      fill: o.color || "ink", op: o.op, layer: o.layer || "annot", z: z + 0.3 });
    return this;
  };

  /* ==================== 6. 图表 ==================== */
  /* 柱状：数据驱动，p 控制生长；自动刻度与数值 */
  Canvas.prototype.bars = function (o) {
    var d = o.data || [], n = d.length;
    if (!n) return this;
    var p = o.p == null ? 1 : clamp(o.p, 0, 1);
    var gap = o.gap == null ? 10 : o.gap;
    var bw = (o.w - gap * (n - 1)) / n;
    var max = o.max != null ? o.max : Math.max.apply(null, d.map(function (x) { return x.v; })) * 1.12;
    var base = o.y + o.h;
    var z = o.z == null ? 0 : o.z;
    if (o.grid !== false) {
      for (var g = 0; g <= 3; g++) {
        var gy = o.y + o.h * g / 3;
        this.line({ pts: [[o.x, gy], [o.x + o.w, gy]], stroke: "line", sw: 1,
          dash: g === 3 ? "" : "3 5", op: g === 3 ? 1 : 0.85, layer: o.layer, z: z });
      }
    }
    for (var i = 0; i < n; i++) {
      var item = d[i];
      var k = K.seq(p, i, 0, 0.06, 0.4) * p / (p || 1);
      k = clamp(k, 0, 1);
      var hh = Math.max(2, (item.v / max) * o.h * k);
      var x = o.x + i * (bw + gap);
      var col = item.color || o.color || "acc";
      var br = Math.min(o.barR == null ? 5 : o.barR, hh / 2, bw / 2);
      this.rect({ x: x, y: base - hh, w: bw, h: hh, r: br,
        fill: col, op: item.op == null ? 0.92 : item.op, layer: o.layer, z: z + 0.1 });
      /* 顶部高光只在柱子够高时画：矮柱子上那道白线会变成一根悬空的杂线 */
      if (hh > 14) {
        this.rect({ x: x, y: base - hh, w: bw, h: Math.min(4, hh * 0.3), r: 2, fill: "#ffffff",
          op: 0.35, layer: o.layer, z: z + 0.2 });
      }
      if (o.showValue !== false && k > 0.55) {
        this.text({ x: x + bw / 2, y: base - hh - 8, s: item.label != null ? item.label : K.fmt(item.v),
          size: 11.5, weight: 700, fill: item.hl ? "acc" : "ink", anchor: "middle",
          op: clamp((k - 0.55) / 0.3, 0, 1), layer: o.layer, z: z + 0.3 });
      }
      if (item.k) this.text({ x: x + bw / 2, y: base + 16, s: item.k, size: 11,
        fill: "sub", anchor: "middle", layer: o.layer, z: z + 0.3 });
    }
    return this;
  };

  /* 折线 / 面积图；series: [{pts:[v,v,...], color, area}] */
  Canvas.prototype.lineChart = function (o) {
    var p = o.p == null ? 1 : clamp(o.p, 0, 1);
    var base = o.y + o.h;
    var max = o.max != null ? o.max : Math.max.apply(null, [].concat.apply([], (o.series || []).map(function (s) { return s.pts; })));
    var min = o.min != null ? o.min : 0;
    if (max === min) max = min + 1;
    var z = o.z == null ? 0 : o.z;
    var self = this;
    if (o.grid !== false) {
      for (var g = 0; g <= 3; g++) {
        this.line({ pts: [[o.x, o.y + o.h * g / 3], [o.x + o.w, o.y + o.h * g / 3]], stroke: "line", sw: 1,
          dash: g === 3 ? "" : "3 5", op: 0.9, layer: o.layer, z: z });
      }
    }
    (o.series || []).forEach(function (s, si) {
      var pts = s.pts, n = pts.length, xy = [];
      for (var i = 0; i < n; i++) {
        var x = o.x + (n === 1 ? 0 : o.w * i / (n - 1));
        var y = base - ((pts[i] - min) / (max - min)) * o.h;
        xy.push([x, y]);
      }
      var shown = Math.max(2, Math.round(n * p));
      var sub = xy.slice(0, shown);
      if (s.area) {
        var ap = sub.concat([[sub[sub.length - 1][0], base], [sub[0][0], base]]);
        self.poly({ pts: ap, fill: K.alpha(s.color || self.P.acc, 0.12), op: 1, layer: o.layer, z: z });
      }
      self.poly({ pts: sub, closed: false, stroke: s.color || "acc", sw: s.sw || 2.4,
        layer: o.layer, z: z + 0.1 });
      var lastP = sub[sub.length - 1];
      self.circle({ x: lastP[0], y: lastP[1], r: 3.6, fill: "surface", stroke: s.color || "acc", sw: 2.2,
        layer: o.layer, z: z + 0.2 });
      if (s.name) self.text({ x: lastP[0] + 7, y: lastP[1] + 4, s: s.name, size: 11, weight: 700,
        fill: s.color || "acc", layer: o.layer, z: z + 0.3 });
    });
    if (o.xs) (o.xs).forEach(function (t, i) {
      if (i % (o.xStep || 1)) return;
      self.text({ x: o.x + (o.xs.length === 1 ? 0 : o.w * i / (o.xs.length - 1)), y: base + 16,
        s: t, size: 10.5, fill: "sub", anchor: "middle", layer: o.layer, z: z + 0.3 });
    });
    return this;
  };

  /* 环形进度：p 控制扫过角度 */
  Canvas.prototype.donut = function (o) {
    var r = o.r, sw = o.sw == null ? 12 : o.sw;
    var p = clamp(o.p == null ? 1 : o.p, 0, 1);
    var start = (o.start == null ? -90 : o.start) * Math.PI / 180;
    var z = o.z == null ? 0 : o.z;
    var circ = PI2 * r;
    this.circle({ x: o.x, y: o.y, r: r, fill: "none", stroke: o.track || "line", sw: sw, layer: o.layer, z: z });
    if (p > 0.002) {
      var c2 = circ * (o.sweep == null ? 1 : o.sweep);
      this._push('<circle cx="' + num(o.x) + '" cy="' + num(o.y) + '" r="' + num(r) + '" fill="none" stroke="' +
        this.res(o.color || "acc") + '" stroke-width="' + num(sw) + '" stroke-linecap="round" ' +
        'stroke-dasharray="' + num(c2 * p) + ' ' + num(circ) + '" transform="rotate(' +
        num(start * 180 / Math.PI) + ' ' + num(o.x) + ' ' + num(o.y) + ')"/>',
        { layer: o.layer, z: z + 0.1 });
    }
    /* 读数与说明的间距按字号推，不按 r 推：小环里 sub 会顶到环内壁上 */
    var vs = o.size || 20;
    var vb = o.y + vs * 0.34;
    if (o.s) this.text({ x: o.x, y: vb, s: o.s, size: vs,
      weight: 800, fill: o.color || "ink", anchor: "middle", layer: o.layer, z: z + 0.3 });
    if (o.sub) this.text({ x: o.x, y: vb + Math.max(14, vs * 0.88), s: o.sub,
      size: o.subSize || (r < 46 ? 9.5 : 11), fill: "sub", anchor: "middle", layer: o.layer, z: z + 0.3 });
    return this;
  };

  /* 刻度尺：小图元，但"精细感"很大一部分来自它。dir:"h" 朝上，"v" 朝右 */
  Canvas.prototype.ticks = function (o) {
    var n = o.n || 10, z = o.z == null ? 0 : o.z;
    var vertical = o.dir === "v";
    var len = vertical ? o.h : o.w;
    if (o.baseline) {
      this.line({ pts: vertical ? [[o.x, o.y], [o.x, o.y + len]] : [[o.x, o.y], [o.x + len, o.y]],
        stroke: o.color || "weak", sw: 1, op: 0.5, layer: o.layer, z: z });
    }
    for (var i = 0; i <= n; i++) {
      var major = i % (o.major || 5) === 0;
      var t = i / n;
      var x1 = vertical ? o.x : o.x + len * t;
      var y1 = vertical ? o.y + len * t : o.y;
      var x2 = vertical ? o.x + (major ? 9 : 5) : x1;
      var y2 = vertical ? y1 : o.y - (major ? 9 : 5);
      this.line({ pts: [[x1, y1], [x2, y2]], stroke: o.color || "weak", sw: major ? 1.5 : 1,
        op: major ? 0.9 : 0.55, layer: o.layer, z: z });
      /* 首尾刻度也要有数字，并且首尾贴齐尺端：anchor 用 start/end，
         否则两端各空半个字宽，标尺看起来是断的 */
      if (major && o.label) {
        var anc = i === 0 ? "start" : (i === n ? "end" : "middle");
        if (vertical) this.text({ x: o.x + 13, y: y1 + 4, s: o.label(i), size: 10, fill: "weak",
          layer: o.layer, z: z });
        else this.text({ x: x1, y: o.y + 19, s: o.label(i), size: 10, fill: "weak", anchor: anc,
          layer: o.layer, z: z });
      }
    }
    return this;
  };

  /* 输出 */
  Canvas.prototype.svg = function () {
    var items = this.items.slice().sort(function (a, b) {
      return a.li - b.li || a.z - b.z || a.q - b.q;
    });
    var d = this.defs.length ? "<defs>" + this.defs.join("") + "</defs>" : "";
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + this.w + " " + this.h +
      '" width="' + this.w + '" height="' + this.h + '" preserveAspectRatio="xMidYMid meet" ' +
      'font-family="Microsoft YaHei UI,Microsoft YaHei,PingFang SC,Noto Sans SC,sans-serif">' +
      d + items.map(function (i) { return i.s; }).join("") + "</svg>";
  };

  Canvas.prototype.mount = function (el) {
    if (typeof el === "string") el = document.getElementById(el);
    if (el) { el.innerHTML = this.svg(); el.style.lineHeight = 0; }
    return this;
  };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  K.canvas = function (w, h, o) { return new Canvas(w, h, o); };
  K.Canvas = Canvas;

  /* ==================== 7. 等距体块 ==================== */
  /* 用途不限机械：服务器机柜、分层架构、数据立方、货架、地图板块、剖面体
   *   var f = K.iso({ yaw: 45 });
   *   f.box(0, 0, 0, 120, 80, 30, [198,216,238]);
   *   f.flush(c, {x:0, y:0, w:712, h:600});
   */
  function Iso(o) {
    o = o || {};
    this.yaw = o.yaw == null ? 45 : o.yaw;
    this.cx = o.cx == null ? 0 : o.cx;
    this.cy = o.cy == null ? 0 : o.cy;
    this.zs = o.zs == null ? 1 : o.zs;
    this.light = o.light || [-0.40, 0.36, 0.84];
    var m = Math.sqrt(this.light[0] * this.light[0] + this.light[1] * this.light[1] + this.light[2] * this.light[2]);
    this.light = [this.light[0] / m, this.light[1] / m, this.light[2] / m];
    this.a = this.yaw * Math.PI / 180;
    this.c = Math.cos(this.a); this.s = Math.sin(this.a);
    this.faces = [];
    this.def = 1.55;  // 环境光基数：越大越平
  }

  /* 标准等距：绕 Z 转 yaw，仰角 35.26°。返回 [屏x, 屏y, 深度] */
  Iso.prototype.p = function (x, y, z) {
    var X = x - this.cx, Y = y - this.cy;
    var xr = X * this.c - Y * this.s, yr = X * this.s + Y * this.c;
    return [xr * 1.2247, yr * 0.7071 - z * this.zs, yr];
  };
  Iso.prototype.dep = function (x, y) { return this.p(x, y, 0)[2]; };

  /* 核心：面。n 为法线（世界坐标），rgb 为底色，光照自动算 */
  Iso.prototype.face = function (pts, n, rgb, o) {
    o = o || {};
    var nx = n[0] * this.c - n[1] * this.s, ny = n[0] * this.s + n[1] * this.c;
    var dt = nx * this.light[0] + ny * this.light[1] + n[2] * this.light[2];
    var k = o.flat ? (o.k || 1) : Math.max(0.18, 0.5 + 0.5 * dt) * (o.k || 1);
    var rp = [], d = 0;
    for (var i = 0; i < pts.length; i++) {
      var q = this.p(pts[i][0], pts[i][1], pts[i][2]);
      rp.push(q); d += q[2];
    }
    d /= rp.length;
    var dd = d;
    if (o.cd != null) dd = o.cd + (d - o.cd) * 0.26;
    dd += (o.bias || 0);
    this.faces.push({
      d: dd, raw: rp, col: o.col || (rgb ? K.shade(rgb, k) : null), part: o.part || "",
      key: o.key || "", sw: o.sw || 0, op: o.op == null ? 1 : o.op,
      line: !!o.line, ns: !!o.ns, dash: o.dash || "", cx: o.cx, cy: o.cy
    });
    return this;
  };

  /* 长方体：五面（不含底面）。
   * ground:true 用于地板/台面这类大平板 —— 大面按"面平均深度"排序会把远处的零件整片盖住，
   * 必须强制排到最底层。症状：管子、地脚、零件的下半截凭空消失。 */
  Iso.prototype.box = function (x, y, z, w, d, h, rgb, o) {
    o = o || {};
    var cd = o.cd != null ? o.cd : this.dep(x + w / 2, y + d / 2);
    var bias = o.ground ? -9000 : o.bias;
    var base = { part: o.part, cd: cd, bias: bias, op: o.op, key: o.key };
    this.face([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], [0, 0, 1], rgb, merge(base, { k: o.topK || 1.06 }));
    this.face([[x, y, z], [x, y, z + h], [x + w, y, z + h], [x + w, y, z]], [0, -1, 0], rgb, base);
    this.face([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], [0, 1, 0], rgb, base);
    this.face([[x, y, z], [x, y + d, z], [x, y + d, z + h], [x, y, z + h]], [-1, 0, 0], rgb, base);
    this.face([[x + w, y, z], [x + w, y, z + h], [x + w, y + d, z + h], [x + w, y + d, z]], [1, 0, 0], rgb, base);
    return this;
  };

  /* 任意 2D 轮廓挤出（x,y 平面轮廓，z0..z1 拉伸）：圆柱、齿轮、异形块、地图板块都靠它 */
  Iso.prototype.prism = function (prof, z0, z1, rgb, o) {
    o = o || {};
    var cd = o.cd != null ? o.cd : this.dep(avg(prof, 0), avg(prof, 1));
    var base = { part: o.part, cd: cd, bias: o.bias, op: o.op, key: o.key };
    var i, a, b, mx, my, dx, dy, L;
    for (i = 0; i < prof.length; i++) {
      a = prof[i]; b = prof[(i + 1) % prof.length];
      mx = (a[0] + b[0]) / 2; my = (a[1] + b[1]) / 2;
      dx = b[0] - a[0]; dy = b[1] - a[1]; L = Math.sqrt(dx * dx + dy * dy) || 1;
      this.face([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]],
        [dy / L, -dx / L, 0], rgb, base);
    }
    if (!o.noTop) {
      var top = prof.map(function (q) { return [q[0], q[1], z1]; });
      this.face(top, [0, 0, 1], rgb, merge(base, { flat: true, k: o.topK || 1.07 }));
    }
    if (!o.noBottom) {
      var bot = prof.slice().reverse().map(function (q) { return [q[0], q[1], z0]; });
      this.face(bot, [0, 0, -1], rgb, merge(base, { flat: true, k: 0.72 }));
    }
    return this;
  };

  Iso.prototype.cyl = function (cx, cy, z0, z1, r, rgb, o) {
    o = o || {};
    var n = o.n || 20, prof = [];
    for (var i = 0; i < n; i++) {
      var t = i / n * PI2;
      prof.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    return this.prism(prof, z0, z1, rgb, o);
  };

  /* 管路：三点描边模拟圆管，第四层是流动虚线（key:"flow" 由场景更新 dashoffset） */
  Iso.prototype.pipe = function (pts, r, o) {
    o = o || {};
    var rp = [], d = 0, i;
    for (i = 0; i < pts.length; i++) { var q = this.p(pts[i][0], pts[i][1], pts[i][2]); rp.push(q); d += q[2]; }
    d /= rp.length;
    var dd = o.cd != null ? o.cd + (d - o.cd) * 0.26 : d;
    dd += (o.bias || 0);
    var part = o.part || "";
    this.faces.push({ d: dd, raw: rp, col: o.dark || "#9dbbd9", part: part, line: true, sw: r * 2, op: 1 });
    this.faces.push({ d: dd + 0.3, raw: rp, col: o.mid || "#d3e5f8", part: part, line: true, sw: Math.max(1, r * 2 - 4), op: 1 });
    this.faces.push({ d: dd + 0.6, raw: rp, col: "#ffffff", part: part, line: true, sw: Math.max(1, r * 0.36), op: 0.4 });
    if (o.flow !== 0) {
      this.faces.push({ d: dd + 0.9, raw: rp, col: o.acc || "#6fa4e0", part: part, line: true,
        sw: Math.max(1.6, r * 0.5), op: 0.85, key: "flow", dash: "5 13" });
    }
    return this;
  };

  /* 环：法兰、垫圈、轨道 */
  Iso.prototype.ring = function (cx, cy, z, r, o) {
    o = o || {};
    var pts = [], d = 0, n = o.n || 18;
    for (var i = 0; i < n; i++) {
      var a = i / n * PI2, q = this.p(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
      pts.push(q); d += q[2];
    }
    this.faces.push({ d: d / n + (o.bias || 0), raw: pts, col: o.col || "#9ebfe2",
      part: o.part || "", line: true, sw: o.w || 3, op: 1, key: o.key || "" });
    return this;
  };

  /* 接地阴影 */
  Iso.prototype.shadow = function (cx, cy, rx, ry, o) {
    o = o || {};
    var p = this.p(cx, cy, 0);
    this.faces.push({ d: p[2] - 9999, raw: [[p[0] - rx, p[1]], [p[0], p[1] - ry * 0.5], [p[0] + rx, p[1]], [p[0], p[1] + ry * 0.5]],
      col: "rgba(40,74,120,.10)", ellipse: true, cx: p[0], cy: p[1], rx: rx, ry: ry, op: 1 });
    return this;
  };

  /* 排序 + 自动缩放 + 落到画布 */
  Iso.prototype.flush = function (c, box) {
    box = box || { x: 0, y: 0, w: c.w, h: c.h };
    var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    this.faces.forEach(function (f) {
      if (f.ellipse) {
        minx = Math.min(minx, f.cx - f.rx); maxx = Math.max(maxx, f.cx + f.rx);
        miny = Math.min(miny, f.cy - f.ry * 0.5); maxy = Math.max(maxy, f.cy + f.ry * 0.5);
        return;
      }
      f.raw.forEach(function (p) {
        if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
        if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
      });
    });
    if (minx > maxx) return this;
    var pad = box.pad == null ? 10 : box.pad;
    var k = Math.min((box.w - 2 * pad) / Math.max(1, maxx - minx), (box.h - 2 * pad) / Math.max(1, maxy - miny));
    var ox = box.x + (box.w - (maxx - minx) * k) / 2 - minx * k;
    var oy = box.y + (box.h - (maxy - miny) * k) / 2 - miny * k;
    this.faces.sort(function (a, b) { return a.d - b.d; });
    var out = [];
    this.faces.forEach(function (f) {
      var attr = (f.part ? ' data-p="' + f.part + '"' : "") + (f.key ? ' data-k="' + f.key + '"' : "");
      if (f.cx != null) attr += ' data-cx="' + num(f.cx) + '" data-cy="' + num(f.cy) + '"';
      if (f.op !== 1) attr += ' opacity="' + num(f.op) + '"';
      if (f.ellipse) {
        out.push('<ellipse cx="' + num(f.cx) + '" cy="' + num(f.cy) + '" rx="' + num(f.rx) + '" ry="' + num(f.ry) +
          '" fill="' + f.col + '"' + attr + "/>");
        return;
      }
      var pt = f.raw.map(function (p) { return num(p[0]) + "," + num(p[1]); }).join(" ");
      if (f.line) {
        out.push('<polyline points="' + pt + '" fill="none" stroke="' + f.col + '" stroke-width="' + num(f.sw) +
          '" stroke-linecap="round" stroke-linejoin="round"' + (f.dash ? ' stroke-dasharray="' + f.dash + '"' : "") +
          attr + "/>");
      } else {
        out.push('<polygon points="' + pt + '" fill="' + f.col + '"' + (f.ns ? "" :
          ' stroke="rgba(24,52,96,.18)" stroke-width=".7"') + ' stroke-linejoin="round"' + attr + "/>");
      }
    });
    this.fit = { ox: ox, oy: oy, k: k };
    c.raw('<g transform="translate(' + num(ox) + " " + num(oy) + ") scale(" + num(parseFloat(k.toFixed(4))) + ')" data-iso="1">' +
      out.join("") + "</g>", { z: this.faces.length ? 0 : 0 });
    return this;
  };

  /* 世界坐标 -> 画布坐标（flush 之后可用）。
   * 用来把 2D 标签/热点/引导线钉在 3D 体块的具体位置上，不用手算偏移。 */
  Iso.prototype.screen = function (x, y, z) {
    var p = this.p(x, y, z), f = this.fit || { ox: 0, oy: 0, k: 1 };
    return [f.ox + p[0] * f.k, f.oy + p[1] * f.k];
  };

  function avg(prof, i) {
    var s = 0;
    for (var j = 0; j < prof.length; j++) s += prof[j][i];
    return s / prof.length;
  }
  function merge(a, b) {
    var o = {};
    for (var k in a) o[k] = a[k];
    for (var k2 in b) o[k2] = b[k2];
    return o;
  }

  K.iso = function (o) { return new Iso(o); };
  K.Iso = Iso;

  /* ==================== 8. 常用小工具 ==================== */
  /* 圆角矩形路径（需要在已有 path 上拼时用） */
  K.roundPath = function (x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    return "M" + num(x + r) + "," + num(y) +
      "H" + num(x + w - r) + "A" + num(r) + "," + num(r) + " 0 0 1 " + num(x + w) + "," + num(y + r) +
      "V" + num(y + h - r) + "A" + num(r) + "," + num(r) + " 0 0 1 " + num(x + w - r) + "," + num(y + h) +
      "H" + num(x + r) + "A" + num(r) + "," + num(r) + " 0 0 1 " + num(x) + "," + num(y + h - r) +
      "V" + num(y + r) + "A" + num(r) + "," + num(r) + " 0 0 1 " + num(x + r) + "," + num(y) + "Z";
  };

  /* 描边流动：场景里给带 data-k="flow" 的元素用 */
  K.flow = function (root, t, speed, key) {
    (root || document).querySelectorAll('[data-k="' + (key || "flow") + '"]').forEach(function (el) {
      el.setAttribute("stroke-dashoffset", num(-((t * (speed || 34)) % 18)));
    });
  };

  /* 数字滚动：v 直接给当前值（用 K.key 算好），这里只管格式与写 DOM */
  K.num = function (el, v, o) {
    if (typeof el === "string") el = document.getElementById(el);
    if (el) el.textContent = K.fmt(v, o);
  };

  /* 呼吸：强调"正在运行"，amp 默认 0.25 */
  K.pulse = function (root, key, t, amp, speed) {
    amp = amp == null ? 0.25 : amp;
    var k = 1 - amp + amp * (0.5 + 0.5 * Math.sin(t * (speed || 3.4)));
    (root || document).querySelectorAll('[data-k="' + (key || "pulse") + '"]').forEach(function (el) {
      el.setAttribute("opacity", k.toFixed(2));
    });
  };

  /* 局部旋转：给带 data-cx/cy 的元素 */
  K.spin = function (root, key, deg) {
    (root || document).querySelectorAll('[data-k="' + key + '"]').forEach(function (el) {
      var cx = el.getAttribute("data-cx"), cy = el.getAttribute("data-cy");
      if (cx == null) return;
      el.setAttribute("transform", "rotate(" + num(deg) + " " + cx + " " + cy + ")");
    });
  };

  /* 聚焦：非聚焦零件压暗到 .5（压到 .2 会让整台东西消失） */
  K.focus = function (root, part) {
    if (!root) return;
    root.querySelectorAll("[data-p]").forEach(function (el) {
      var p = el.getAttribute("data-p");
      if (!p) return;
      var base = parseFloat(el.getAttribute("data-op") || "1");
      el.setAttribute("opacity", (!part || p === part) ? base : (base * 0.5).toFixed(2));
    });
  };

  global.K = K;
  if (typeof module === "object" && module.exports) module.exports = K;
})(typeof window !== "undefined" ? window : this);
