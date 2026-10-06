#!/usr/bin/env python3
"""把 .shots/ 里的真实界面截图合成 README 演示动图 docs/demo.gif。

截图不是手绘的：用 headless Chrome 直接加载 extension/popup.html 与 content.js，
驱动脚本负责真点击（勾选、切页、按空格），所以每一帧都是扩展真实渲染出来的界面。
截图步骤见 docs/CONTRIBUTING.md 的「更新演示动图」一节。

用法：python3 docs/gen_demo_gif.py
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, ".shots")
OUT = os.path.join(ROOT, "docs", "demo.gif")

W, H = 900, 620          # 画布
BAR = 38                 # 浏览器标题栏高度
PAD = 28                 # 画布留白
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
# 主字体只画到 ⑩：⑪ 之后的带圈序号会落成豆腐块（v1.9~v1.10 的动图里 ⑪⑫⑬⑭ 就是这么发出去的）。
# 缺哪个字就单独换这套兜底字体补哪个，整句换过去中文反而难看。
FONT_FALLBACK = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
_TOFU = "\ue000"  # 私用区：任何字体都画不出真字形，拿它当「缺字长什么样」的参照

INK = (17, 24, 39)
MUTED = (107, 114, 128)
LINE = (226, 229, 234)
BG = (244, 245, 248)
CARD = (255, 255, 255)
BLUE = (37, 99, 235)


def f(sz, bold=False):
    try:
        return ImageFont.truetype(FONT, sz, index=(1 if bold else 0))
    except Exception:
        return ImageFont.truetype(FONT, sz)


def f_alt(sz, bold=False):
    """兜底字体；机器上没有这个文件（比如 Linux）就返回 None，说明文字退回主字体画。"""
    try:
        return ImageFont.truetype(FONT_FALLBACK, sz)
    except Exception:
        return None


def _sig(font, ch):
    m = font.getmask(ch)
    return (m.size, bytes(m))


def _has(font, ch):
    """这个字体画不画得出这个字：跟私用区的豆腐块一模一样就算画不出。"""
    cache = getattr(font, "_cov", None)
    if cache is None:
        cache = font._cov = {}
    if "_tofu" not in cache:
        cache["_tofu"] = _sig(font, _TOFU)
    if ch not in cache:
        cache[ch] = _sig(font, ch)
    return cache[ch] != cache["_tofu"]


def draw_caption(d, xy, text, sz, fill):
    """一行说明文字，逐字挑字体：主字体缺的字（⑪ 之后的序号）交给兜底字体。"""
    main = f(sz, True)
    alt = None
    x, y = xy
    for ch in text:
        font = main
        if not _has(main, ch):
            if alt is None:
                alt = f_alt(sz, True)
            if alt is not None and _has(alt, ch):
                font = alt
        d.text((x, y), ch, font=font, fill=fill)
        x += font.getlength(ch)


def load(name):
    path = os.path.join(SHOTS, name + ".png")
    if not os.path.exists(path):
        sys.exit("缺少截图 " + path + "（先按 CONTRIBUTING 里的说明抓帧）")
    im = Image.open(path).convert("RGB")
    # 截图是 @2x 抓的，等比缩回 CSS 尺寸（裁一半只会留下左上角，别这么干）
    return im.resize((im.size[0] // 2, im.size[1] // 2), Image.LANCZOS)


def base(url, caption, step, total):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = PAD, 18, W - PAD, H - 62
    d.rounded_rectangle([x0, y0, x1, y1], radius=12, fill=CARD, outline=LINE, width=1)
    # 标题栏
    d.rounded_rectangle([x0, y0, x1, y0 + BAR], radius=12, fill=(248, 250, 252))
    d.rectangle([x0, y0 + BAR - 12, x1, y0 + BAR], fill=(248, 250, 252))
    d.line([x0, y0 + BAR, x1, y0 + BAR], fill=LINE, width=1)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([x0 + 16 + i * 20, y0 + 13, x0 + 28 + i * 20, y0 + 25], fill=c)
    d.rounded_rectangle([x0 + 88, y0 + 8, x1 - 60, y0 + 30], radius=11, fill=(238, 240, 244))
    d.text([x0 + 102, y0 + 10], url, font=f(12), fill=MUTED)
    # 工具栏上的扩展图标：弹窗就是从这儿掉下来的
    d.rounded_rectangle([x1 - 50, y0 + 6, x1 - 28, y0 + 32], radius=7, fill=(229, 237, 255), outline=BLUE)
    d.text([x1 - 45, y0 + 8], "★", font=f(15), fill=BLUE)
    # 底部说明
    draw_caption(d, (x0 + 2, y1 + 14), caption, 15, INK)
    d.text([x1 - 46, y1 + 16], "%d / %d" % (step, total), font=f(12), fill=MUTED)
    return im, d, (x0, y0 + BAR, x1, y1)


def paste_fit(im, shot, box, anchor_right=False, dim=0):
    """等比缩放后贴进 box；anchor_right 用于模拟挂在工具栏右侧的弹窗"""
    bw, bh = box[2] - box[0], box[3] - box[1]
    sc = min(bw / shot.width, bh / shot.height)
    w, h = int(shot.width * sc), int(shot.height * sc)
    pic = shot.resize((w, h), Image.LANCZOS)
    if dim:
        black = Image.new("RGB", pic.size, (255, 255, 255))
        pic = Image.blend(pic, black, dim)
    x = box[2] - w - 4 if anchor_right else box[0] + (bw - w) // 2
    y = box[1] + 4
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([x - 2, y - 2, x + w + 2, y + h + 2], radius=8, fill=(255, 255, 255), outline=LINE)
    im.paste(pic, (x, y))
    return pic


# 帧序：(截图名, 地址栏, 说明文字)
FRAMES = [
    ("w_sel", "example.com/quantum-computing", "① 网页上划选文字，工具条浮出：收藏 / 高亮 / 批注 / 净化阅读"),
    ("w_card", "example.com/quantum-computing", "② 点「★ 收藏」，顺手写下备注和标签——只存本地，不传服务器"),
    ("w_ov", "example.com/quantum-computing", "③ 两条高亮区间重叠时按边界分段，交集套两层颜色，一条都不会丢"),
    ("w_anchor", "example.com/quantum-computing", "④ 划选跨过了 <strong> 边界：按文本节点存锚点，刷新后三段一字不差"),
    ("p_clips", "example.com/quantum-computing", "⑤ 弹窗里统一管理：搜索、标签筛选、复制、导出 Markdown、删除"),
    ("p_filter", "example.com/quantum-computing", "⑥ 类型与站点筛选：只看图片、只看这个站，和搜索标签取交集"),
    ("p_batchall", "example.com/quantum-computing", "⑦ 全选跟的是当前筛选结果，导出的就是看到的这一批"),
    ("p_focus", "example.com/quantum-computing", "⑧ 列表键盘流：↑ / ↓ 移焦点，x 勾选，Enter 展开全文"),
    ("p_keys", "example.com/quantum-computing", "⑨ 按 ? 随时查键位，浮层里列的就是真能按的那几个"),
    ("p_marks", "example.com/quantum-computing", "⑩ 高亮按页面归组，四色轮转，批注跟着原文一起留档"),
    ("p_review", "example.com/quantum-computing", "⑪ 每日回顾：间隔重复排期 + 打卡热力图，收藏不再是黑洞"),
    ("p_reveal", "example.com/quantum-computing", "⑫ 空格翻答案，1 / 2 / 3 打分，整批删除也能一次撤销"),
    ("p_trash", "example.com/quantum-computing", "⑬ 回收站明细：撤销只管最近一批，想捞哪一条就点哪一条"),
    ("p_dark", "example.com/quantum-computing", "⑭ 深色模式一键切换，Chrome / Edge / Safari 同一份代码"),
    ("p_en", "example.com/quantum-computing", "⑮ 界面语言跟着偏好走：中文 / English 用的是同一份代码"),
]


def main():
    total = len(FRAMES)
    page = load("w_sel")
    frames = []
    for i, (name, url, caption) in enumerate(FRAMES, 1):
        shot = load(name)
        im, _, box = base(url, caption, i, total)
        if name.startswith("w_"):
            paste_fit(im, shot, box)
        else:
            paste_fit(im, page, box, dim=0.55)          # 后面的网页：真实页面，压暗当背景
            paste_fit(im, shot, box, anchor_right=True)  # 弹窗挂在右侧
        frames.append(im.convert("P", palette=Image.ADAPTIVE, colors=200))
    frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=1900, loop=0,
                   optimize=True)
    print("wrote", OUT, "%.1f KB" % (os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
