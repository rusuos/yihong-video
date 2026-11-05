#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""整段文案 -> 单条配音（本地 edge-tts），可选变速到目标时长。

与 tts_gemini.py 的输出契约完全一致，通常由统一入口 tts.py 在缺少
GEMINI_API_KEY 时自动调用，不必直接跑。

用法:
  python tts_edge.py --text script.txt --out voice.wav --target 105
  python tts_edge.py --text script.txt --out voice.wav --voice zh-CN-XiaoxiaoNeural
  python tts_edge.py --text script.txt --out voice.wav --words words.json

输出:
  <out>            最终音频（44.1k 立体声 wav；给了 --target 则已整体变速）
  <out>.raw.wav    未变速母版（24k 单声道 wav），换目标时长时从它重算
  <out>.raw.mp3    edge-tts 原始音频，排查用
  --words PATH     可选：直接产出 align.py 需要的词级时间戳，可跳过 asr_words.py

edge-tts 是本地 Python 包、不需要 API Key，但合成时要联网访问微软语音服务；
完全离线的环境两条 TTS 路线都不可用，需人工提供 voice.wav 从步骤 3 继续。
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys

DEFAULT_VOICE = "zh-CN-YunxiNeural"
TICKS_PER_SECOND = 10_000_000  # edge-tts 的 offset/duration 单位是 100ns tick


def read_script(path):
    with open(path, encoding="utf-8") as f:
        return "".join(line.strip() for line in f if line.strip())


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


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


async def synth(text, voice, rate, volume, pitch, proxy, out_mp3, want_words):
    """一次性把全文交给 edge-tts；不要按场景切分，理由见 pipeline.md 步骤 1。"""
    try:
        import edge_tts
    except ImportError:
        sys.exit("缺少 edge-tts：pip install edge-tts")

    kwargs = dict(voice=voice, rate=rate, volume=volume, pitch=pitch,
                  boundary="WordBoundary" if want_words else "SentenceBoundary")
    if proxy:
        kwargs["proxy"] = proxy
    try:
        comm = edge_tts.Communicate(text, **kwargs)
    except TypeError:
        # 旧版 edge-tts 没有 proxy / boundary 参数，降级到最小参数集
        for k in ("proxy", "boundary"):
            kwargs.pop(k, None)
        comm = edge_tts.Communicate(text, **kwargs)

    words = []
    audio = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            a = chunk["offset"] / TICKS_PER_SECOND
            b = (chunk["offset"] + chunk["duration"]) / TICKS_PER_SECOND
            words.append({"w": chunk["text"], "a": a, "b": b})

    if not audio:
        sys.exit("edge-tts 没有返回音频：检查网络、--proxy 和 --voice 是否有效")
    with open(out_mp3, "wb") as f:
        f.write(audio)
    return words


def main():
    ap = argparse.ArgumentParser(description="整段配音（edge-tts，无需 API Key）")
    ap.add_argument("--text", required=True, help="文案 txt，逐字即为配音内容")
    ap.add_argument("--out", required=True, help="输出 wav")
    ap.add_argument("--target", type=float, default=0, help="目标时长（秒），0=不调速")
    ap.add_argument("--voice", default=DEFAULT_VOICE, help="edge-tts 音色，默认 zh-CN-YunxiNeural")
    ap.add_argument("--rate", default="+0%", help="语速，如 +10%% / -5%%")
    ap.add_argument("--volume", default="+0%", help="音量，如 +10%%")
    ap.add_argument("--pitch", default="+0Hz", help="音高，如 +20Hz")
    ap.add_argument("--proxy", default="", help="如 http://127.0.0.1:7897，访问微软语音服务需要时用")
    ap.add_argument("--words", default="", help="可选：直接写词级时间戳 words.json，跳过 asr_words.py")
    args = ap.parse_args()

    outdir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(outdir, exist_ok=True)
    text = read_script(args.text)
    if not text:
        sys.exit("文案为空：" + args.text)
    print("文案 %d 字" % len(text), flush=True)
    print("edge-tts 音色 %s 语速 %s（整段一次性合成）" % (args.voice, args.rate), flush=True)

    raw_mp3 = args.out + ".raw.mp3"
    try:
        words = asyncio.run(synth(text, args.voice, args.rate, args.volume, args.pitch,
                                  args.proxy, raw_mp3, bool(args.words)))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        sys.exit("edge-tts 合成失败：%r\n"
                 "该引擎需要联网访问微软语音服务。检查网络/代理（--proxy）、系统时间，"
                 "或改用 --engine gemini 并提供 GEMINI_API_KEY；"
                 "完全离线时请人工提供 voice.wav 并从步骤 3 继续。" % e)

    # 转成与 tts_gemini.py 一致的 24k 单声道母版，后续变速/对齐全部基于它
    raw = args.out + ".raw.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw_mp3,
                    "-ar", "24000", "-ac", "1", raw], check=True)
    d0 = probe(raw)
    print("原始时长 %.2fs -> %s" % (d0, raw))

    ratio = d0 / args.target if args.target and args.target > 0 else 1.0
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", raw]
    if ratio != 1.0:
        print("变速比 %.6f（%s）" % (ratio, atempo_chain(ratio)))
        cmd += ["-filter:a", atempo_chain(ratio)]
    cmd += ["-ar", "44100", "-ac", "2", args.out]
    subprocess.run(cmd, check=True)
    print("最终时长 %.3fs -> %s" % (probe(args.out), args.out))

    if args.words:
        if not words:
            print("警告：edge-tts 未返回 WordBoundary，请改用 asr_words.py 生成 words.json",
                  flush=True)
        else:
            # 时间轴是最终音频的；整体变速后按 1/ratio 缩放
            scale = args.target / d0 if ratio != 1.0 else 1.0
            scaled = [{"w": w["w"], "a": round(w["a"] * scale, 3),
                       "b": round(w["b"] * scale, 3)} for w in words]
            with open(args.words, "w", encoding="utf-8") as f:
                json.dump(scaled, f, ensure_ascii=False, indent=1)
            print("词级时间戳 %d 条 -> %s（可直接喂给 align.py）" % (len(scaled), args.words))


if __name__ == "__main__":
    main()
