---
name: yihong-video
description: 制作带配音、烧录字幕与鼠标操作的演示视频（MP4 成片）。画面由程序化图形承载旁白内容——等距装置、流程图、数据看板、界面操作——而不是几个方块配文字。当用户要求"做一个演示视频""根据这份文案生成介绍视频""把脚本做成视频""给产品/项目做一条讲解片"，或需要给已有视频重新配音、重新对齐音画、重新生成字幕，或觉得已有视频画面太粗糙需要重做图形时使用。覆盖从文案切分、TTS 配音、强制对齐、HTML 舞台与图形搭建、逐帧录制到 ffmpeg 合成的完整链路；配音默认走 Gemini TTS，未提供 Gemini API Key 时自动回退到本地 edge-tts，后续流程不变。开源地址：https://github.com/rusuos/yihong-video
agent_created: true
---

# 配音演示视频制作

## 适用场景

- 从一份文案（脚本 / 字幕文本）产出竖屏或横屏的演示视频成片
- 需要旁白与画面严格同步、字幕逐字对应
- 需要展示软件界面操作（鼠标移动、点击、悬停）
- 已有视频但配音要换、要重新对齐

**不适用**：真人出镜拍摄、纯 PPT 转视频（用 pptx 技能）、纯动画无旁白。

## 核心原理

页面的一切视觉状态都是时间 `t` 的纯函数，暴露 `window.seek(t)`；CSS 禁用
transition，Playwright 逐帧 `seek(f/fps)` 后截图，ffmpeg 定帧合成。

这样音画同步是**结构上保证**的，不依赖录屏时的机器性能。代价是必须先把时间轴
算准——而时间轴只能从真实音频反推，所以流程是「先做声音，再做画面」。

```
文案 → 配音 → 场景切分 → 逐词转写 → 强制对齐(时间轴+字幕) → 舞台 → 逐帧录制 → 合成
```

详细步骤、命令、参数见 `references/pipeline.md`。

## 快速开始

```bash
# 1. 配音（整段，不切分；有 Gemini API Key 走 Gemini，没有则自动用本地 edge-tts）
python scripts/tts.py --text script.txt --out build/voice.wav --target 105
# 2. 文案与场景切分：script.txt + scenes.json（文本逐字一致）
# 3. 逐词转写（若第 1 步用 --engine edge --words 产出了 words.json，本步可跳过）
python scripts/asr_words.py --audio build/voice.wav --out build/words.json
# 4. 强制对齐 → timeline.json/js + subs.ass/srt
python scripts/align.py --script script.txt --scenes scenes.json --words build/words.json --audio build/voice.wav --outdir build
# 5. 拷贝 assets/stage/ 到项目，用第 4 步的 timeline.js 覆盖，写 index.html 与 scenes.js
# 6. 逐帧录制
python scripts/record.py --url "file:///D:/proj/site/index.html" --out build/frames
# 7. 合成（先 cd 到字幕目录）
cd build && python ../scripts/mux.py --frames frames --audio voice.wav --ass subs.ass --out ../demo.mp4
# 8. 自检
python scripts/check_sync.py --timeline build/timeline.json --words build/words.json
```

## 三个不能妥协的决定

1. **TTS 必须整段一次性合成**（Gemini 与 edge-tts 都一样）。切分会让人为停顿混进音频，后续对齐全部失真。edge-tts 内部按块传输只是网络分片，音频仍是连续拼接的，不要自己按场景切。
   语速不够快就整体 `atempo` 变速（1.2 倍内无损），或改文案，不要靠切分凑时长。

2. **时间轴必须靠强制对齐，不能靠"标点停顿 + 语速均分"**。后者误差 0.3~1s，
   肉眼可见。做法：本地 whisper 拿词级时间戳 → 归一化后 difflib 找公共块 →
   逐字符得到 (位置, 时间) 锚点 → 插值。覆盖率低于 55% 说明台本和音频不是同一份。

3. **锚点时间取字起始时刻** `a + (b-a)*k/n`，不是字中心。whisper 会把单字拉长到
   0.5s 以上，用中心会让场景边界系统性偏晚 0.2~0.4s。

4. **不要修改水印文本和样式** 不得改动水印的文字、字体、大小、颜色、透明度或位置等任何属性。
   确有需要调整时，统一在 `styles.css` 里改（水印样式只定义在这一个文件），
   不要写进 `index.html` 的内联样式，也不要在 `scenes.js` 的 `render()` 里覆写。

场景边界 = 该场景首字时间 − 0.10s（画面略早于人声，观感上是"画面引出声音"）。


## 资源

| 路径 | 用途 |
|---|---|
| `references/pipeline.md` | 八步完整流程、命令参数、验收标准 |
| `references/scene-graphics.md` | **图形与动效**：四条硬规则、五种构图母版、图元词汇、动画动词、反模式、静帧测试 |
| `references/design-rules.md` | 800×1000 栅格、字号、配色、动画时序、密度上限 |
| `references/troubleshooting.md` | 按症状查原因：不同步、抖动、字幕丢失、环境报错 |
| `assets/stage/` | 可直接跑的最小舞台：`index.html` + `styles.css` + `engine.js` + `kit.js` + `scenes.js` |
| `assets/stage/kit.js` | 通用绘图内核：分层画布、节点连线、柱线环刻度、等距体块 |
| `assets/stage/kit-demo.html` | 图元样张（四块：基础 / 数据 / 等距 / 组合），浏览器直接打开 |
| `scripts/tts.py` | **配音统一入口**：有 Gemini API Key 走 Gemini，无 Key 自动回退本地 edge-tts |
| `scripts/tts_gemini.py` | Gemini 整段 TTS + 变速到目标时长（由 `tts.py` 调用） |
| `scripts/tts_edge.py` | edge-tts 整段 TTS + 变速 + 可选词级时间戳，无需 Key（由 `tts.py` 调用） |
| `scripts/asr_words.py` | 本地逐词转写（faster-whisper，绕过 PyAV 兼容问题） |
| `scripts/align.py` | 强制对齐，产出时间轴与字幕 |
| `scripts/record.py` | Playwright 逐帧录制 |
| `scripts/mux.py` | 合成 + 烧字幕 |
| `scripts/check_sync.py` | 音画同步自检 |

## 验收标准

交付前逐条确认：

- 时长与目标偏差 < 1s；帧数 = `round(total × fps)`
- `floor(总时长 / 11)` ≤ 场景数 ≤ `floor(总时长 / 9)`
- `check_sync.py` 报告 0 个可疑边界，lead 在 0.05~0.35s
- 字幕与配音逐字一致（不是"意思一致"）
- 每个场景至少 3 种交互元素，光标真的移动并点击
- 元素无重叠、无溢出（内容区 712×600，底边不越 850）
- 场景切换前所有动作已播完（留 0.45s 收尾）
- 抽帧目检 5~8 个关键画面，字幕清晰可读

图形的额外验收（详见 `scene-graphics.md` 第 10 节）：

- 每屏可见图元 40~120（`document.querySelectorAll("#scN *").length`），低于 40 是"几个方块"
- 每屏至少有 3 类细节词汇：刻度 / 纹理 / 编号 / 光影 / 标注
- 关掉字幕只看画面，能说出这一屏在讲什么；能指出哪里是重点
- 旁白的关键词都能在画面上找到对应变化（有一份状态表，逐条核过）
- 颜色全部出自同一套色阶，没有孤立的手写色值

回报时给出：分辨率、帧率、时长、帧数、场景数、字幕条数、文件大小、绝对路径。

## 收尾

成片交付后清理中间产物（帧序列、模型缓存、临时音频）通常能把目录清理到 50MB 内。
保留全部脚本，
删掉 `frames/`、`models/` 和临时切帧音频——前者重录即可再生，后者重跑即可再下。
