#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""整段文案 -> 单条配音（Gemini TTS），可选变速到目标时长。

关键点：必须一次性把全文喂给 TTS，不要切分。切分会导致每段语气重新起势、
段间停顿不可控，后面做音画对齐会非常痛苦。

一般不要直接调用本脚本：统一入口 `tts.py` 会在有 Key 时调它、没有 Key 时
自动改用本地 edge-tts（scripts/tts_edge.py）。

用法:
  python tts_gemini.py --text script.txt --out voice.wav --target 105
  python tts_gemini.py --text script.txt --out voice.wav            # 不调速

输出:
  <out>            最终音频（若给了 --target 则为变速后的 44.1k 立体声 wav）
  <out>.raw.wav    原始音频（未变速，24k 单声道），留着以便换目标时长时重算
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"
DEFAULT_MODEL = "gemini-3.8-flash-tts"
DEFAULT_VOICE = "Kore"


def read_script(path):
    with open(path, encoding="utf-8") as f:
        return "".join(line.strip() for line in f if line.strip())


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def gen(text, key, model, voice, proxies, tries=4):
    try:
        import requests
    except ImportError:
        sys.exit("需要 requests: pip install requests")
    url = ENDPOINT % model
    body = {"contents": [{"parts": [{"text": text}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
    last = None
    for i in range(tries):
        try:
            r = requests.post(url, headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                              json=body, proxies=proxies, timeout=600)
            if r.status_code == 200:
                d = r.json()
                for p in d["candidates"][0]["content"]["parts"]:
                    inl = p.get("inlineData")
                    if inl and inl.get("mimeType", "").startswith("audio"):
                        return base64.b64decode(inl["data"])
                raise RuntimeError("响应里没有音频: " + json.dumps(d)[:400])
            last = "%s %s" % (r.status_code, r.text[:300])
        except Exception as e:                      # noqa: BLE001
            last = repr(e)
        print("  retry %d: %s" % (i + 1, last), flush=True)
        time.sleep(4 + i * 4)
    sys.exit("TTS 失败: %s" % last)


def atempo_chain(ratio):
    """atempo 单级只能 0.5~2.0，超出要串联。"""
    parts = []
    r = ratio
    while r > 2.0:
        parts.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        parts.append("atempo=0.5")
        r /= 0.5
    parts.append("atempo=%.6f" % r)
    return ",".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True, help="文案 txt，逐字即为配音内容")
    ap.add_argument("--out", required=True, help="输出 wav")
    ap.add_argument("--target", type=float, default=0, help="目标时长（秒），0=不调速")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--proxy", default="", help="如 http://127.0.0.1:7897，访问 Google 需要")
    ap.add_argument("--api-key", default=os.environ.get("GEMINI_API_KEY")
                    or os.environ.get("GOOGLE_API_KEY") or "")
    args = ap.parse_args()

    if not args.api_key:
        sys.exit("缺少 API Key：用 --api-key 或环境变量 GEMINI_API_KEY / GOOGLE_API_KEY；"
                 "没有 Key 请改用统一入口 scripts/tts.py（自动走 edge-tts）")
    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None

    text = read_script(args.text)
    print("文案 %d 字" % len(text), flush=True)
    audio = gen(text, args.api_key, args.model, args.voice, proxies)

    raw = args.out + ".raw.wav"
    with open(raw, "wb") as f:
        f.write(audio)
    d0 = probe(raw)
    print("原始时长 %.2fs -> %s" % (d0, raw))

    if args.target and args.target > 0:
        ratio = d0 / args.target
        print("变速比 %.6f（%s）" % (ratio, atempo_chain(ratio)))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw,
                        "-filter:a", atempo_chain(ratio),
                        "-ar", "44100", "-ac", "2", args.out], check=True)
        print("最终时长 %.3fs -> %s" % (probe(args.out), args.out))
    else:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw,
                        "-ar", "44100", "-ac", "2", args.out], check=True)
        print("最终时长 %.3fs -> %s" % (probe(args.out), args.out))


if __name__ == "__main__":
    main()
