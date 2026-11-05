#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配音统一入口：有 Gemini API Key 走 Gemini TTS，没有则自动改用本地 edge-tts。

判定顺序：--api-key > 环境变量 GEMINI_API_KEY > GOOGLE_API_KEY；三者都没有就用
edge-tts（本地 Python 包，无需任何 Key）。用 --engine gemini|edge 可强制指定。

用法:
  python tts.py --text script.txt --out build/voice.wav --target 105
  python tts.py --text script.txt --out build/voice.wav --target 105 \
         --api-key AIza... --proxy http://127.0.0.1:7897
  python tts.py --text script.txt --out build/voice.wav --engine edge \
         --voice zh-CN-XiaoxiaoNeural --rate +10%
  python tts.py --text script.txt --out build/voice.wav --engine edge \
         --words build/words.json          # 直接出词级时间戳，可跳过 asr_words.py
  python tts.py --text script.txt --out build/voice.wav --dry-run  # 只看会走哪条路

输出契约与 tts_gemini.py / tts_edge.py 完全一致：<out>、<out>.raw.wav，
后续步骤（场景切分 → 逐词转写 → 强制对齐）无需任何改动。
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser(description="整段配音，无 Gemini API Key 时自动回退 edge-tts")
    ap.add_argument("--text", required=True, help="文案 txt，逐字即为配音内容")
    ap.add_argument("--out", required=True, help="输出 wav")
    ap.add_argument("--target", type=float, default=0, help="目标时长（秒），0=不调速")
    ap.add_argument("--engine", choices=("auto", "gemini", "edge"), default="auto",
                    help="auto=有 Key 用 Gemini、无 Key 用 edge-tts（默认）")
    ap.add_argument("--api-key", default="", help="Gemini API Key；不传则读环境变量")
    ap.add_argument("--proxy", default="", help="如 http://127.0.0.1:7897")
    ap.add_argument("--model", default="", help="仅 Gemini：模型名")
    ap.add_argument("--voice", default="", help="音色；Gemini 默认 Kore，edge 默认 zh-CN-YunxiNeural")
    ap.add_argument("--rate", default="+0%", help="仅 edge-tts：语速，如 +10%%")
    ap.add_argument("--volume", default="+0%", help="仅 edge-tts：音量")
    ap.add_argument("--pitch", default="+0Hz", help="仅 edge-tts：音高")
    ap.add_argument("--words", default="", help="仅 edge-tts：直接输出词级时间戳 words.json")
    ap.add_argument("--dry-run", action="store_true", help="只打印选择的引擎和命令，不合成")
    args = ap.parse_args()

    key = (args.api_key or os.environ.get("GEMINI_API_KEY", "")
           or os.environ.get("GOOGLE_API_KEY", ""))
    if args.engine == "auto":
        engine = "gemini" if key else "edge"
    else:
        engine = args.engine
    if engine == "gemini" and not key:
        sys.exit("指定了 --engine gemini 但没有 API Key：用 --api-key / GEMINI_API_KEY 提供，"
                 "或改用 --engine edge")
    if args.words and engine != "edge":
        sys.exit("--words 仅 edge-tts 引擎支持；Gemini 引擎请用 asr_words.py 做逐词转写")
    if engine == "gemini" and args.voice and "neural" in args.voice.lower():
        print("警告：%s 看起来是 edge-tts 音色，Gemini 可能不认；"
              "去掉 --voice 用默认 Kore，或改用 --engine edge" % args.voice, flush=True)

    if engine == "gemini":
        script = os.path.join(HERE, "tts_gemini.py")
        cmd = [sys.executable, script, "--text", args.text, "--out", args.out,
               "--api-key", key]
        if args.model:
            cmd += ["--model", args.model]
    else:
        script = os.path.join(HERE, "tts_edge.py")
        cmd = [sys.executable, script, "--text", args.text, "--out", args.out,
               "--rate", args.rate, "--volume", args.volume, "--pitch", args.pitch]
        if args.voice:
            cmd += ["--voice", args.voice]
        if args.words:
            cmd += ["--words", args.words]

    if args.target and args.target > 0:
        cmd += ["--target", str(args.target)]
    if args.proxy:
        cmd += ["--proxy", args.proxy]

    reason = ("检测到 API Key" if key else "未提供 Gemini API Key") if args.engine == "auto" \
        else "由 --engine 强制指定"
    print("配音引擎: %s（%s）" % (engine, reason), flush=True)
    if engine == "edge":
        print("提示：edge-tts 无需 Key，但合成需联网访问微软语音服务；"
              "完全离线时请人工提供 voice.wav 并从步骤 3 继续。", flush=True)

    if args.dry_run:
        print("命令: " + " ".join(cmd))
        return
    sys.exit(subprocess.call(cmd))


if __name__ == "__main__":
    main()
