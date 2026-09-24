#!/usr/bin/env python3
# 生成 ClipKeep README 演示动图（界面示意 mockup）— v1.1：高亮/批注 + 回顾 + 备份入口
from PIL import Image, ImageDraw, ImageFont

W, H = 960, 600
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
def f(sz, bold=False):
    try:
        return ImageFont.truetype(FONT, sz, index=(1 if bold else 0))
    except Exception:
        return ImageFont.truetype(FONT, sz)

def rrect(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)

BLUE = (37, 99, 235)
INK = (17, 24, 39)
MUTED = (107, 114, 128)
LINE = (229, 231, 235)
BG = (245, 246, 248)
CARD = (255, 255, 255)
GREEN = (22, 163, 74)
RED = (239, 68, 68)
SOFT = (239, 246, 255)
HL_GREEN = (199, 245, 199)
HL_PINK = (255, 208, 224)
HL_YELLOW = (255, 243, 163)

def base():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    rrect(d, [24, 24, W-24, H-24], 16, fill=CARD, outline=LINE, width=1)
    d.rounded_rectangle([24, 24, W-24, 78], radius=16, fill=(248, 250, 252))
    d.rectangle([24, 60, W-24, 78], fill=(248, 250, 252))
    d.line([24, 78, W-24, 78], fill=LINE, width=1)
    for i, c in enumerate([(255,95,86),(255,189,46),(39,201,63)]):
        d.ellipse([44+i*22, 42, 58+i*22, 56], fill=c)
    rrect(d, [120, 38, 520, 64], 12, fill=(241, 243, 246))
    d.text([136, 42], "example.com/article/quantum-computing", font=f(15), fill=MUTED)
    rrect(d, [W-92, 36, W-64, 66], 8, fill=SOFT, outline=BLUE, width=1)
    d.text([W-84, 40], "★", font=f(18), fill=BLUE)
    d.text([60, 104], "量子计算入门：从比特到量子比特", font=f(26, True), fill=INK)
    d.text([60, 144], "2026-09-24 · 阅读约 8 分钟 · 科技前沿", font=f(14), fill=MUTED)
    y = 186
    widths = [840, 820, 860, 760, 0, 840, 830, 700]
    for wline in widths:
        if wline == 0:
            y += 16; continue
        d.rounded_rectangle([60, y, 60+wline, y+14], radius=7, fill=(236, 238, 241))
        y += 30
    return im, d, y

def selection(d):
    d.rectangle([60, 246, 900, 300], fill=(191, 219, 254))
    d.text([68, 250], "量子比特可以同时处于 0 和 1 的叠加态，", font=f(16), fill=INK)
    d.text([68, 274], "这是量子计算超越经典计算的根本原因。", font=f(16), fill=INK)

def toolbar(d, x, y):
    w = 320
    rrect(d, [x, y, x+w, y+40], 10, fill=CARD, outline=LINE, width=1)
    rrect(d, [x+8, y+7, x+96, y+33], 7, fill=BLUE)
    d.text([x+22, y+11], "★ 收藏", font=f(15), fill=(255,255,255))
    for i, label in enumerate(["高亮", "批注", "阅读"]):
        bx = x + 104 + i*70
        active = (i == 1)
        rrect(d, [bx, y+7, bx+62, y+33], 7, fill=HL_PINK if active else (243, 244, 246))
        d.text([bx+12, y+11], label, font=f(15), fill=INK)

def applied_marks(d):
    """高亮与批注落到页面上：一段绿色高亮 + 一段粉色批注（带气泡）"""
    d.rectangle([60, 246, 900, 300], fill=(255, 255, 255))
    rrect(d, [64, 246, 556, 270], 4, fill=HL_GREEN)
    d.text([68, 250], "量子比特可以同时处于 0 和 1 的叠加态，", font=f(16), fill=INK)
    rrect(d, [64, 274, 596, 298], 4, fill=HL_PINK)
    d.text([68, 274], "这是量子计算超越经典计算的根本原因。", font=f(16), fill=INK)
    for px in range(68, 592, 6):
        d.line([px, 297, px + 3, 297], fill=(90, 90, 90), width=1)
    bx, by, bw, bh = 606, 262, 288, 40
    rrect(d, [bx, by, bx+bw, by+bh], 9, fill=(17, 24, 39))
    d.polygon([(bx, by+12), (bx-10, by+20), (bx, by+28)], fill=(17, 24, 39))
    d.text([bx+12, by+11], "批注：记进今晚的回顾队列", font=f(14), fill=(255, 255, 255))

def save_card(d, filled=False):
    x, y, w, h = 300, 150, 380, 250
    rrect(d, [x, y, x+w, y+h], 14, fill=CARD, outline=LINE, width=1)
    d.text([x+20, y+16], "收藏内容", font=f(16, True), fill=INK)
    rrect(d, [x+20, y+46, x+w-20, y+120], 8, fill=(249, 250, 251))
    d.rectangle([x+20, y+46, x+23, y+120], fill=BLUE)
    d.text([x+34, y+54], "量子比特可以同时处于 0 和 1 的", font=f(14), fill=(55,65,81))
    d.text([x+34, y+78], "叠加态，这是量子计算超越经典…", font=f(14), fill=(55,65,81))
    rrect(d, [x+20, y+132, x+w-20, y+164], 8, outline=(209,213,219), width=1)
    if not filled:
        d.text([x+30, y+140], "标签，用逗号分隔（可选）", font=f(13), fill=(156,163,175))
    else:
        d.text([x+30, y+140], "量子计算, 重点", font=f(13), fill=INK)
    rrect(d, [x+w-180, y+180, x+w-100, y+212], 8, fill=(243,244,246))
    d.text([x+w-166, y+186], "取消", font=f(14), fill=INK)
    rrect(d, [x+w-92, y+180, x+w-20, y+212], 8, fill=BLUE)
    d.text([x+w-78, y+186], "保存", font=f(14), fill=(255,255,255))

def popup_shell(d):
    x, y, w, h = 560, 90, 360, 460
    rrect(d, [x+4, y+8, x+w+4, y+h+8], 14, fill=(222, 226, 232))
    rrect(d, [x, y, x+w, y+h], 14, fill=(250, 251, 253), outline=(203, 213, 225), width=2)
    d.rounded_rectangle([x, y, x+w, y+52], radius=14, fill=CARD)
    d.rectangle([x, y+36, x+w, y+52], fill=CARD)
    d.line([x, y+52, x+w, y+52], fill=LINE, width=1)
    d.text([x+16, y+14], "★ ClipKeep", font=f(18, True), fill=INK)
    d.text([x+w-40, y+16], "🌙", font=f(16))
    d.text([x+w-70, y+16], "⬇", font=f(16))
    return x, y, w, h

def popup_tabs(d, x, y, w, active):
    hy = y + 52
    x2, y2, h2 = x, y, 460
    d.rectangle([x, hy, x+w, hy+38], fill=CARD)
    d.line([x, hy+38, x+w, hy+38], fill=LINE, width=1)
    for i, label in enumerate(["收藏", "回顾"]):
        cx = x + 16 + i*164
        on = (i == active)
        d.text([cx+46, hy+9], label, font=f(14, on), fill=BLUE if on else MUTED)
        if on:
            d.rectangle([cx, hy+35, cx+150, hy+38], fill=BLUE)
    if active == 0:
        rrect(d, [x+266, hy+10, x+290, hy+28], 9, fill=RED)
        d.text([x+273, hy+12], "2", font=f(12), fill=(255,255,255))
    d.rounded_rectangle([x, y, x+w, y+460], radius=14, outline=(203, 213, 225), width=2)

def popup_footer(d, x, y, w, h, toast=None):
    fy = y + h - 40
    d.line([x, fy, x+w, fy], fill=LINE, width=1)
    d.rectangle([x, fy, x+w, y+h], fill=CARD)
    d.text([x+16, fy+13], "零账号 · 纯本地 · 跨浏览器", font=f(11), fill=MUTED)
    for i, (label, col) in enumerate([("备份", MUTED), ("恢复", MUTED), ("清空", RED)]):
        bx = x + w - 16 - (2 - i) * 58 - 24
        d.text([bx, fy+13], label, font=f(12), fill=col)
    if toast:
        rrect(d, [x+w/2-105, fy-42, x+w/2+105, fy-12], 15, fill=(17,24,39))
        d.text([x+w/2-88, fy-36], toast, font=f(14), fill=(255,255,255))

def popup_clips(d):
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 0)
    rrect(d, [x+16, y+100, x+w-16, y+130], 8, fill=CARD, outline=LINE, width=1)
    d.text([x+28, y+106], "搜索收藏内容…", font=f(13), fill=(156,163,175))
    for i, (t, act) in enumerate([("全部", True), ("量子计算", False), ("重点", False)]):
        cx = x+16 + i*90
        fill = BLUE if act else CARD
        col = (255,255,255) if act else MUTED
        rrect(d, [cx, y+142, cx+80, y+164], 11, fill=fill, outline=None if act else LINE, width=0 if act else 1)
        d.text([cx+16, y+146], t, font=f(13), fill=col)
    cy = y + 178
    rrect(d, [x+16, cy, x+w-16, cy+126], 12, fill=CARD, outline=LINE, width=1)
    d.text([x+28, cy+12], "量子比特可以同时处于 0 和 1 的叠加态，", font=f(13), fill=INK)
    d.text([x+28, cy+34], "这是量子计算超越经典计算的根本原因。", font=f(13), fill=INK)
    rrect(d, [x+28, cy+58, x+108, cy+76], 9, fill=SOFT)
    d.text([x+36, cy+60], "#量子计算", font=f(11), fill=BLUE)
    rrect(d, [x+116, cy+58, x+172, cy+76], 9, fill=SOFT)
    d.text([x+124, cy+60], "#重点", font=f(11), fill=BLUE)
    d.text([x+28, cy+84], "example.com · 09-24 12:30", font=f(11), fill=MUTED)
    for i, b in enumerate(["复制", "导出", "删除"]):
        bx = x+w-16-3*54 + i*54
        rrect(d, [bx, cy+98, bx+46, cy+118], 7, outline=LINE, width=1)
        d.text([bx+8, cy+100], b, font=f(11), fill=(55,65,81))
    cy2 = cy + 134
    rrect(d, [x+16, cy2, x+w-16, cy2+60], 12, fill=CARD, outline=LINE, width=1)
    d.rounded_rectangle([x+28, cy2+14, x+w-40, cy2+28], radius=7, fill=(236,238,241))
    d.rounded_rectangle([x+28, cy2+36, x+w-120, cy2+50], radius=7, fill=(236,238,241))
    popup_footer(d, x, y, w, h)

def popup_review(d, revealed=False):
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 1)
    d.text([x+16, y+102], "待回顾 2 条 · 记忆盒 1/5", font=f(12), fill=MUTED)
    cy = y + 128
    ch = 300 if revealed else 210
    rrect(d, [x+16, cy, x+w-16, cy+ch], 14, fill=CARD, outline=LINE, width=1)
    d.multiline_text([x+36, cy+26], "量子比特可以同时处于\n0 和 1 的叠加态，\n这是量子计算超越经典\n计算的根本原因。", font=f(15), fill=INK, spacing=10)
    if revealed:
        d.line([x+36, cy+146, x+w-36, cy+146], fill=LINE, width=1)
        d.rectangle([x+36, cy+162, x+39, cy+196], fill=BLUE)
        d.text([x+48, cy+164], "标签：量子计算 / 重点", font=f(12), fill=INK)
        d.text([x+48, cy+182], "来源：example.com", font=f(12), fill=MUTED)
        labels = [("忘记", RED), ("记得", BLUE), ("简单", GREEN)]
        for i, (label, col) in enumerate(labels):
            bx = x + 36 + i*98
            rrect(d, [bx, cy+ch-46, bx+86, cy+ch-14], 8, outline=col, width=2)
            d.text([bx+22, cy+ch-40], label, font=f(14), fill=col)
    else:
        rrect(d, [x+36, cy+ch-52, x+w-36, cy+ch-16], 9, fill=SOFT, outline=BLUE, width=1)
        d.text([x+w/2-40, cy+ch-44], "显示答案", font=f(14), fill=BLUE)
    popup_footer(d, x, y, w, h)

frames = []

# 场景1：文章 → 划词 → 工具条（收藏 / 高亮 / 批注 / 阅读）
im, d, _ = base(); frames.append(im.copy())
selection(d); frames.append(im.copy())
toolbar(d, 560, 306); frames.append(im.copy())

# 场景2：高亮 + 批注落到页面
im, d, _ = base(); applied_marks(d); frames.append(im.copy())

# 场景3：收藏卡片
im, d, _ = base(); selection(d); save_card(d); frames.append(im.copy())
im, d, _ = base(); selection(d); save_card(d, filled=True); frames.append(im.copy())

# 场景4：弹窗收藏列表 + 备份/恢复底栏
im, d, _ = base(); popup_clips(d); frames.append(im.copy())
im, d, _ = base(); popup_clips(d); 
x, y, w, h = 560, 90, 360, 460
popup_footer(d, x, y, w, h, toast="已导出 3 条"); frames.append(im.copy())

# 场景5：每日回顾（间隔重复）
im, d, _ = base(); popup_review(d); frames.append(im.copy())
im, d, _ = base(); popup_review(d, revealed=True); frames.append(im.copy())

durations = [700, 800, 1200, 1200, 900, 1000, 1000, 1200, 1000, 1800]
frames[0].save(
    "/Users/liuxin/Documents/开源项目/ClipKeep/docs/demo.gif",
    save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True,
    disposal=2,
)
print("demo.gif written:", len(frames), "frames")
