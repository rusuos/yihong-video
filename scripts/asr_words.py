#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地逐词转写（faster-whisper），产出带词级时间戳的 words.json。

这一步是"音画同步"的基础：拿到每个词的真实起止时间，才能把台本的每个字
定位到音频里的真实时刻。不要用在线 ASR（配额、噪音、窗口截断都会坑你）。

用法:
  python asr_words.py --audio voice.wav --out words.json
  python asr_words.py --audio voice.wav --out words.json --model medium

输出 words.json: [{"w": "词", "a": 0.12, "b": 0.40}, ...]
"""
import argparse
import json
import os
import subprocess
import sys

# 国内直连 huggingface.co 常常不通，hf-mirror 可用；xet 传输要关掉，否则走 cas-server 401
os.environ["HF_ENDPOINT"] = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")
os.environ["HF_HUB_DISABLE_XET"] = "1"
for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
    os.environ.pop(k, None)


def pcm16k(path):
    """用 ffmpeg 自己解码。新版 PyAV 与 faster-whisper 的 metadata_errors 参数不兼容，
    传 numpy 数组可以完全绕过 av.open。"""
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le",
                        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-"],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--prompt", default="以下是普通话简体中文的逐字转写。")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("需要 faster-whisper: pip install faster-whisper")

    root = os.path.join(os.path.dirname(os.path.abspath(args.out)), "models")
    m = WhisperModel(args.model, device="cpu", compute_type="int8", download_root=root)
    segs, _ = m.transcribe(pcm16k(args.audio), language=args.lang, beam_size=5,
                           word_timestamps=True, vad_filter=False,
                           condition_on_previous_text=False, initial_prompt=args.prompt)

    words = []
    for s in segs:
        for w in (s.words or []):
            if w.word.strip():
                words.append({"w": w.word.strip(), "a": round(w.start, 3), "b": round(w.end, 3)})
        print("[%6.2f-%6.2f] %s" % (s.start, s.end, s.text.strip()), flush=True)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False, indent=1)
    print("words: %d -> %s" % (len(words), args.out))


if __name__ == "__main__":
    main()
