#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把帧序列 + 配音 + ASS 字幕合成最终 MP4。

用法:
  python mux.py --frames frames --audio voice.wav --ass subs.ass --out demo.mp4
  python mux.py --frames frames --audio voice.wav --ass subs.ass --out demo.mp4 --crf 18

注意: --ass 用相对路径时请先 cd 到字幕所在目录，libass 对含盘符的绝对路径
（D:\\...）解析不稳定，容易报 "Unable to open" 并静默丢字幕。
"""
import argparse
import json
import os
import subprocess
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True, help="帧目录，文件名为 %05d.png")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--ass", default="", help="ASS 字幕，留空则不烧字幕")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--crf", type=int, default=19)
    ap.add_argument("--audio-bitrate", default="192k")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    frames = os.path.abspath(args.frames)
    audio = os.path.abspath(args.audio)
    cwd = os.path.dirname(os.path.abspath(args.ass)) if args.ass else os.path.dirname(frames)

    cmd = ["ffmpeg", "-y",
           "-framerate", str(args.fps), "-i", os.path.join(frames, "%05d.png"),
           "-i", audio]
    if args.ass:
        # 在字幕目录下执行，只传文件名，避开 libass 的路径解析问题
        cmd += ["-vf", "ass=%s" % os.path.basename(args.ass)]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
            "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
            "-r", str(args.fps), "-g", str(args.fps * 2),
            "-c:a", "aac", "-b:a", args.audio_bitrate, "-ar", "44100",
            "-shortest", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True, cwd=cwd)

    r = subprocess.run(["ffprobe", "-v", "error",
                        "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames",
                        "-show_entries", "format=duration,size", "-of", "json", out],
                       capture_output=True, text=True)
    print(json.dumps(json.loads(r.stdout), ensure_ascii=False, indent=1))
    print("OUT:", out)


if __name__ == "__main__":
    main()
