#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""强制对齐：把台本的每个字定位到音频的真实时刻，输出时间轴与字幕。

原理
----
1. 台本、转写都归一化（只保留汉字/字母/数字，转小写，繁体转简体）；
2. difflib 在两条字符串上找公共块，逐字符得到 (字符位置, 时间) 锚点；
3. 任意字符的时间 = 锚点线性插值；
4. 场景边界 = 该场景首字时间 - lead（画面比人声略提前）。

两个决定成败的细节
------------------
* 锚点时间用「字起始时刻」a + (b-a)*k/n，不能用字中心 (k+0.5)/n。
  whisper 常把单字拉长（一个字 0.6s），用中心会让边界系统性偏晚 0.2~0.4s。
* ASR 经常输出繁体，必须先 zhconv 转简体，否则公共块会大量断裂。

用法:
  python align.py --script 字幕.txt --scenes scenes.json \
                  --words words.json --audio voice.wav --outdir build

输出: timeline.json / timeline.js / subs.ass / subs.srt / anchors.json
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys

import numpy as np

try:
    import zhconv
except ImportError:                     # 没有也能跑，只是匹配率会低一些
    zhconv = None


def keep(c):
    return bool(re.match(r"[0-9A-Za-z\u4e00-\u9fff]", c))


def norm_map(text):
    """返回 (归一化串, 原字符下标 -> 归一化下标)。"""
    out, pos = [], []
    for c in text:
        if keep(c):
            pos.append(len(out))
            out.append(c.lower())
        else:
            pos.append(len(out))
    return "".join(out), pos


def build_hyp(words):
    hn, ht = [], []
    for w in words:
        s = "".join(c.lower() for c in w["w"] if keep(c))
        if s and zhconv:
            s = "".join(c.lower() for c in zhconv.convert(s, "zh-cn") if keep(c))
        if not s:
            continue
        n = len(s)
        for k, c in enumerate(s):
            hn.append(c)
            ht.append(w["a"] + (w["b"] - w["a"]) * k / n)   # 字起始时刻
    return "".join(hn), np.array(ht, dtype=float)


def anchors_from(Sn, Hn, Ht):
    sm = difflib.SequenceMatcher(None, Sn, Hn, autojunk=False)
    raw = []
    for a, b, size in sm.get_matching_blocks():
        for j in range(size):
            raw.append((a + j, float(Ht[b + j])))
    raw.sort()
    clean, last_t = [], -1.0
    for c, t in raw:
        if t <= last_t or (clean and c <= clean[-1][0]):
            continue
        clean.append((c, t))
        last_t = t
    return clean


def tw(t):
    """字幕宽度单位：汉字 1.0，ASCII 0.55。"""
    return sum(0.55 if ord(c) < 128 else 1.0 for c in t)


def split_subs(text, budget=18.0):
    parts = [p.strip() for p in re.split(r"(?<=[，。、！？；：])", text) if p.strip()]
    out = []
    for p in parts:
        if tw(p) <= budget:
            out.append(p)
            continue
        tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9\.\+%\-]*|\s+|.", p)
        cur = ""
        for tk in tokens:
            if tw(cur + tk) > budget and cur.strip():
                out.append(cur.strip())
                cur = tk
            else:
                cur += tk
        if cur.strip():
            out.append(cur.strip())
    fixed = []
    for p in out:
        if fixed and re.match(r"^[，。、！？；：]", p):
            fixed[-1] += p
        else:
            fixed.append(p)
    merged = []
    for p in fixed:
        if merged and tw(p) < 5 and tw(merged[-1]) + tw(p) <= budget + 1.5:
            merged[-1] += p
        else:
            merged.append(p)
    return merged


def fmt_ass(t):
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return "%d:%02d:%05.2f" % (h, m, s)


def fmt_srt(x):
    h, m, s = int(x // 3600), int(x % 3600 // 60), int(x % 60)
    ms = int(round((x - int(x)) * 1000))
    if ms == 1000:
        ms, s = 0, s + 1
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


ASS_HEAD = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,{font},{size},&H002E2114,&H002E2114,&H00FFFFFF,&H50000000,1,0,0,0,100,100,0.6,0,1,3.2,1.4,5,24,24,100,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def load_scenes(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    return d["scenes"] if isinstance(d, dict) else d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True, help="全文文案 txt")
    ap.add_argument("--scenes", required=True, help="场景切分 json")
    ap.add_argument("--words", required=True, help="asr_words.py 产出的 words.json")
    ap.add_argument("--audio", required=True, help="用于取总时长")
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--lead", type=float, default=0.10, help="画面比人声提前多少秒")
    ap.add_argument("--min-dur", type=float, default=1.2, help="单场景最短时长")
    ap.add_argument("--budget", type=float, default=18.0, help="单条字幕最大宽度单位")
    ap.add_argument("--width", type=int, default=800)
    ap.add_argument("--height", type=int, default=1000)
    ap.add_argument("--font", default="Microsoft YaHei")
    ap.add_argument("--size", type=int, default=32)
    ap.add_argument("--sub-y", type=int, default=900, help="字幕中心 y")
    args = ap.parse_args()

    out = args.outdir
    os.makedirs(out, exist_ok=True)

    with open(args.script, encoding="utf-8") as f:
        full = "".join(l.strip() for l in f if l.strip())
    SCENES = load_scenes(args.scenes)
    joined = "".join(s["text"] for s in SCENES)
    if full != joined:
        sys.exit("场景切分与文案不一致：请逐字校验（文案 %d 字，切分 %d 字）"
                 % (len(full), len(joined)))

    with open(args.words, encoding="utf-8") as f:
        words = json.load(f)

    Sn, _ = norm_map(full)
    Hn, Ht = build_hyp(words)
    anc = anchors_from(Sn, Hn, Ht)
    cov = len(anc) / max(1, len(Sn))
    print("锚点 %d / 台本 %d 字（覆盖率 %.0f%%）" % (len(anc), len(Sn), cov * 100))
    if cov < 0.55:
        print("!! 覆盖率偏低，检查：ASR 语言/模型、台本与音频是否同一份文案", file=sys.stderr)

    T = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", args.audio],
                             capture_output=True, text=True).stdout)

    xs = np.array([0.0] + [a[0] for a in anc] + [float(len(Sn))])
    ys = np.array([0.0] + [a[1] for a in anc] + [T])
    # 首尾用平均语速线性外推，避免 np.interp 在两端做常数延拓
    cps = (ys[-1] - ys[1]) / max(1.0, xs[-1] - xs[1]) if len(xs) > 2 else 6.0
    ys[0] = max(0.0, min(ys[1] - 0.05, ys[1] - xs[1] / max(cps, 0.1)))
    ys[-1] = max(ys[-1], ys[-2] + 0.05)

    def t_of(p):
        return float(np.interp(p, xs, ys))

    offs, p = [], 0
    for s in SCENES:
        offs.append(p)
        p += len(norm_map(s["text"])[0])

    tv = [0.0] + [t_of(offs[k]) for k in range(1, len(SCENES))] + [T]
    b = [0.0] + [tv[k] - args.lead for k in range(1, len(SCENES))] + [T]
    for k in range(1, len(b) - 1):
        b[k] = max(b[k], b[k - 1] + args.min_dur)
        b[k] = min(b[k], b[k + 1] - args.min_dur)

    print(" 场景   首字时间   边界    时长   字/秒")
    for k in range(1, len(b) - 1):
        d = b[k + 1] - b[k]
        print("  S%02d  %8.2f  %7.2f  %5.2f  %5.2f" %
              (k + 1, tv[k], b[k], d, len(SCENES[k]["text"]) / max(0.01, d)))

    scenes = []
    for k, s in enumerate(SCENES):
        scenes.append({"id": s["id"], "section": s.get("section", ""), "text": s["text"],
                       "start": round(b[k], 3), "dur": round(b[k + 1] - b[k], 3),
                       "end": round(b[k + 1], 3)})
    tl = {"total": round(T, 3), "scenes": scenes}
    with open(os.path.join(out, "timeline.json"), "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "timeline.js"), "w", encoding="utf-8") as f:
        f.write("window.TIMELINE=" + json.dumps(tl, ensure_ascii=False) + ";")
    with open(os.path.join(out, "anchors.json"), "w", encoding="utf-8") as f:
        json.dump({"xs": [float(x) for x in xs], "ys": [float(y) for y in ys], "total": T}, f)

    events = []
    for k, s in enumerate(SCENES):
        _, pos = norm_map(s["text"])
        cur = 0
        for c in split_subs(s["text"], args.budget):
            i = s["text"].find(c, cur)
            if i < 0:
                i = cur
            j = i + len(c)
            ns = offs[k] + pos[i]
            ne = offs[k] + (pos[j - 1] + (1 if keep(s["text"][j - 1]) else 0))
            a = max(scenes[k]["start"], t_of(ns) - 0.08)
            bb = min(scenes[k]["end"], t_of(ne) - 0.02)
            if bb - a < 0.45:
                bb = a + 0.45
            events.append([a, bb, c])
            cur = j
    for i in range(len(events) - 1):
        if events[i][1] > events[i + 1][0]:
            events[i][1] = max(events[i][0] + 0.2, events[i + 1][0] - 0.01)

    with open(os.path.join(out, "subs.ass"), "w", encoding="utf-8") as f:
        f.write(ASS_HEAD.format(w=args.width, h=args.height, font=args.font, size=args.size))
        for a, bb, c in events:
            f.write("Dialogue: 0,%s,%s,Sub,,0,0,0,,{\\pos(%d,%d)}%s\n"
                    % (fmt_ass(a), fmt_ass(bb), args.width // 2, args.sub_y, c))
    with open(os.path.join(out, "subs.srt"), "w", encoding="utf-8") as f:
        for i, (a, bb, c) in enumerate(events, 1):
            f.write("%d\n%s --> %s\n%s\n\n" % (i, fmt_srt(a), fmt_srt(bb), c))
    print("字幕 %d 条 -> %s/{subs.ass,subs.srt}" % (len(events), out))


if __name__ == "__main__":
    main()
