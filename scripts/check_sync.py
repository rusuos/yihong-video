#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""音画同步自检：打印每个场景边界处的真实语音，一眼看出错位。

指标（边界时刻 t）：
  tail  上一个词在 t 之后还剩多少（理想 ≈ 0.10，即画面比人声早 0.10s）
        > 0.30 说明边界切进了上一句，要往前挪
  lead  到下一个词起点的距离（理想 0~0.35）
        > 0.45 说明画面会先空转，要往后挪

注意：whisper 的词尾时间偏松（会把字拉长、把停顿吞进去），所以 tail 略大于 0
是正常的，不能据此判错；只有明显超出阈值才算问题。

用法:
  python check_sync.py --timeline timeline.json --words words.json
退出码：0 = 全部通过，1 = 有可疑边界。
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--words", required=True)
    ap.add_argument("--tail", type=float, default=0.30, help="tail 上限")
    ap.add_argument("--lead", type=float, default=0.45, help="lead 上限")
    args = ap.parse_args()

    with open(args.timeline, encoding="utf-8") as f:
        tl = json.load(f)
    with open(args.words, encoding="utf-8") as f:
        words = sorted(json.load(f), key=lambda w: w["a"])

    bad = 0
    print("%-4s %7s  %-28s %6s %6s  %s" % ("场景", "边界", "边界附近", "tail", "lead", "判定"))
    for s in tl["scenes"]:
        t = s["start"]
        prev = [w for w in words if w["a"] < t]
        nxt = [w for w in words if w["a"] >= t]
        # 词起点紧贴边界（<0.05s）说明它就是本场景的第一个词，whisper 把单字拉长而已，
        # 不算"切进上一句"，tail 记 0。
        if prev and t - prev[-1]["a"] >= 0.05:
            tail = prev[-1]["b"] - t
        else:
            tail = 0.0
        lead = (nxt[0]["a"] - t) if nxt else None
        near = (prev[-2:] + nxt[:2]) if prev else nxt[:3]

        if lead is None and not prev:
            verdict, bad = "<< 没有任何语音", bad + 1
        elif tail > args.tail:
            verdict, bad = "<< 切进上一句 %.2fs" % tail, bad + 1
        elif lead is not None and lead > args.lead:
            verdict, bad = "<< 画面空转 %.2fs" % lead, bad + 1
        else:
            verdict = "ok"

        print("S%02d  %7.2f  %-28s %+6.2f %6s  %s" % (
            s["id"], t,
            " ".join("%s@%.2f" % (w["w"], w["a"]) for w in near) or "-",
            tail, "%+.2f" % lead if lead is not None else "-", verdict))

    print("\n可疑边界 %d / %d" % (bad, len(tl["scenes"])))
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
