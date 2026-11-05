#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Playwright 逐帧录制：把 seek(t) 驱动的演示页面逐帧截成 PNG 序列。

为什么逐帧截而不是录屏
----------------------
页面所有视觉状态都是 t 的纯函数（window.seek(t)），CSS 禁用 transition。
逐帧截图 + ffmpeg 定帧合成 = 天然音画同步，不会掉帧、不会因为机器卡顿漂移。

用法:
  python record.py --url "file:///D:/proj/site/index.html" --out frames
  python record.py --url ... --out frames --fps 25 --width 800 --height 1000
  python record.py --url ... --out frames --only 0 1 2 100    # 只录指定帧（调试）
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--width", type=int, default=800)
    ap.add_argument("--height", type=int, default=1000)
    ap.add_argument("--only", type=int, nargs="*", default=[], help="只录这些帧号")
    ap.add_argument("--skip-existing", action="store_true", help="跳过已存在的帧，便于断点续录")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("需要 playwright: pip install playwright && python -m playwright install chromium")

    os.makedirs(args.out, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        pg = b.new_page(viewport={"width": args.width, "height": args.height}, device_scale_factor=1)
        pg.on("console", lambda m: print("PAGE", m.type, m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: print("EXC", e))
        pg.goto(args.url)
        pg.wait_for_function("() => window.__total > 0", timeout=30000)
        pg.evaluate("() => document.fonts.ready")     # 等字体，否则首帧会用到 fallback
        total = pg.evaluate("() => window.__total")
        n = int(round(total * args.fps))
        print("总时长 %.3fs -> %d 帧" % (total, n), flush=True)

        frames = args.only or list(range(n))
        for i, f in enumerate(frames):
            path = os.path.join(args.out, "%05d.png" % f)
            if args.skip_existing and os.path.exists(path):
                continue
            pg.evaluate("(t) => window.seek(t)", f / args.fps)
            pg.screenshot(path=path)
            if i % 100 == 0:
                print("  frame %d/%d" % (f, n), flush=True)
        b.close()
    print("done", len(frames))


if __name__ == "__main__":
    main()
