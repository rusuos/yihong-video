# 完整流水线

八步，前四步做声音，后四步做画面。**顺序不能颠倒**：时间轴必须由真实音频反推，
不能先定时间轴再让配音去凑。

```
文案 → 配音(wav) → 场景切分 → 逐词转写(words.json) → 强制对齐(timeline+字幕)
                                                          ↓
                                              搭舞台(HTML/JS) → 逐帧录制 → 合成
```

---

## 0. 准备

需要 `ffmpeg`/`ffprobe` 在 PATH 里，以及：

```bash
pip install playwright faster-whisper numpy requests zhconv edge-tts
python -m playwright install chromium
```

`zhconv` 只在台本是简体、ASR 输出繁体时才起作用，但装上更保险。
`edge-tts` 是**没有 Gemini API Key 时的配音回退引擎**（步骤 1）；确定始终有
`GEMINI_API_KEY` 可以不装。用步骤 1 的 `--words` 捷径时 `faster-whisper` 也可跳过。

---

## 1. 配音

**统一入口 `scripts/tts.py` 自动选引擎**，一般不要直接调 `tts_gemini.py`：

```bash
python scripts/tts.py --text script.txt --out build/voice.wav --target 105
# 走 Gemini 且需要代理时追加 --proxy http://127.0.0.1:7897
# 只想确认走哪条路、不合成：加 --dry-run
python scripts/tts.py --text script.txt --out build/voice.wav --engine edge \
       --voice zh-CN-XiaoxiaoNeural --rate +10% --words build/words.json
```

| 判定 | 引擎 | 前置条件 |
|---|---|---|
| 有 `--api-key` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini TTS | 联网，通常需要 `--proxy` |
| 三者都没有 | 本地 edge-tts | `pip install edge-tts` + 联网（微软语音服务），**无需 Key** |

- **整段一次性合成，绝对不要切分**。切分后每段语气重新起势、段间停顿不可控，
  后面做对齐会被这些人为停顿坑死。两个引擎都一样；edge-tts 内部按块传输只是
  网络分片，音频是连续拼接的，不要自己按场景切。
- `--target` 会给整体变速（atempo 串联，单级上限 2.0）。1.2 倍以内基本无损，
  超过 1.4 倍会有明显机械感；edge-tts 优先用 `--rate` 调语速，宁可改文案。
- 输出 `<out>` 是可用音频，`<out>.raw.wav` 是未变速母版——换目标时长时从母版重算，
  不用重新合成。edge-tts 另留 `<out>.raw.mp3` 供排查。
- `--engine edge --words build/words.json` 会直接产出词级时间戳（覆盖率通常 100%），
  可以跳过步骤 3 的 `asr_words.py`；变速后脚本已按 `1/ratio` 缩放词时间。
- **edge-tts 不是离线引擎**：本地包、无需 Key，但合成要联网访问微软语音服务；
  完全离线时两条路都不通，需人工提供 `voice.wav` 从步骤 3 继续。

Gemini 失败（额度、代理、模型不可用）时不要反复重试：直接 `--engine edge` 重跑配音，
后续步骤不变。只有完全离线才请求人工协助。

---

## 2. 文案与场景切分

先定**文案**（`script.txt`，一行一段，会被拼成一段连续文本）。文案就是字幕，
必须与配音逐字一致——不要为了顺口改字，改了就等着字幕对不上。

再定**场景切分**（`scenes.json`）。一个场景 = 一屏画面，建议 8~12 秒、20~60 字。
太短画面来不及看懂，太长会闷。

```json
[
  {"id": 1, "section": "开场", "text": "来啦来啦！每年给 Office 交的订阅费，心疼不心疼？"},
  {"id": 2, "section": "项目", "text": "今天这个 GitHub 热门开源项目……"}
]
```

**硬校验**：`"".join(s["text"] for s in scenes) == 全文`。`align.py` 会自己断言这一条，
但最好在切分时就用脚本比一遍——错一个字（比如句号写成逗号）后面全崩。

---

## 3. 逐词转写

```bash
python scripts/asr_words.py --audio build/voice.wav --out build/words.json
```

`small` 模型在 CPU 上转 100 秒音频约 30 秒，够用。产出 `[{w,a,b}, ...]`，每个词的真实起止。

**捷径**：edge-tts 配音时可在步骤 1 加 `--engine edge --words build/words.json`，
直接拿到词级时间戳喂给 `align.py`（覆盖率通常 100%），本步整个跳过，也省掉
whisper 模型下载。若覆盖率异常，再回到这条 ASR 路径。

不要用在线 ASR 做这件事：免费额度小、按窗口切会截断词、返回文本噪音大。

---

## 4. 强制对齐 → 时间轴 + 字幕

```bash
python scripts/align.py --script script.txt --scenes scenes.json \
       --words build/words.json --audio build/voice.wav --outdir build
```

产出：

| 文件 | 用途 |
|---|---|
| `timeline.json` | 权威时间轴（场景 start/dur/end、total） |
| `timeline.js` | 同上，给页面 `window.TIMELINE` 用 |
| `subs.ass` / `subs.srt` | 字幕，时间已对齐到真实语音 |
| `anchors.json` | 字符位置→时间锚点，调试用 |

看输出的覆盖率：**≥ 80% 才算可信**。低于 55% 说明台本和音频不是同一份文案，
或者 ASR 语言设错了。

场景边界 = 该场景首字时间 − `--lead`（默认 0.10s）。画面比人声略早一点点，
观感上是"画面引出声音"，反过来会觉得画面在追赶。

---

## 5. 搭舞台

把 `assets/stage/` 整个拷到项目里（`index.html` + `styles.css` + `engine.js` + `kit.js` + `scenes.js` + `timeline.js`），
用第 4 步的 `timeline.js` 覆盖占位文件，然后：

1. 在 `index.html` 里按场景数写 `<section class="scene" id="scN">`，**id 必须等于 timeline 的 id**；
2. 在 `scenes.js` 里按同样顺序 `SC.push({path, clicks, render})`；
3. 直接浏览器打开 `index.html` 调 `window.seek(t)` 逐时刻看效果。

元素布局、字号、配色、防溢出规则见 `design-rules.md`；
图形怎么画得像样、怎么和旁白对上，见 `scene-graphics.md`。

**每个场景至少 3 种交互元素**（卡片 / 按钮 / 表格 / 进度 / 连线 / 光标点击…），
否则整片看下来像幻灯片。

**画复杂图形前先打开 `assets/stage/kit-demo.html`**，四块样张分别是基础图元、
数据图元、等距体块、组合场景。里面的代码可以直接抄进 `scenes.js` 改。

一条经验：先用 `K.canvas()` 画静态一帧，确认构图（位置、比例、有没有重叠），
再把它包进 `render(t, d)` 接状态。反过来做（一边接状态一边调布局）会返工两三次。

---

## 6. 逐帧录制

```bash
python scripts/record.py --url "file:///D:/proj/site/index.html" --out build/frames
```

800×1000、25fps，105 秒 = 2625 帧，约 5 分钟。只改某个场景时可以
`--only 1200 1201 1202` 补帧，或 `--skip-existing` 断点续录。

---

## 7. 合成

```bash
cd build && python ../scripts/mux.py --frames frames --audio voice.wav \
       --ass subs.ass --out ../demo.mp4
```

`mux.py` 会在字幕目录下执行 ffmpeg 并只传文件名——libass 对 `D:\...` 这种带盘符的
绝对路径解析不稳，容易静默丢字幕。

---

## 8. 自检

```bash
python scripts/check_sync.py --timeline build/timeline.json --words build/words.json
```

每个场景打印边界前后的真实语音 + lead。全部 `lead` 在 0.05~0.35s 且无"切进上一句"
才算过。再抽几帧目检：

```bash
ffmpeg -ss 25.4 -i demo.mp4 -frames:v 1 /tmp/f1.png
```

看四件事：字幕文字是否与配音逐字一致、元素有没有重叠或溢出、数字动画是否跑完、
鼠标是否落在它要点的元素上。

---

## 交付时回报

分辨率、帧率、时长、帧数、场景数、字幕条数、文件大小、绝对路径。
