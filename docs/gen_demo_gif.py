#!/usr/bin/env python3
# 生成 ClipKeep README 演示动图（界面示意 mockup）
# v1.4：高亮/批注 + 高亮总览 + 删除撤销 + 回顾热力图 + 重复收藏提示 + 搜索命中高亮 + 标签管理 + 设置 + 恢复差异 + 快捷键秒存
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
    d.text([60, 144], "2026-09-26 · 阅读约 8 分钟 · 科技前沿", font=f(14), fill=MUTED)
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
    for i, label in enumerate(["导出", "深色", "设置", "阅读"]):
        lw = d.textlength(label, font=f(11))
        bx = x + w - 16 - i*40 - lw
        d.text([bx, y+21], label, font=f(11), fill=MUTED)
    return x, y, w, h

def popup_tabs(d, x, y, w, active):
    """三个标签页：收藏 / 高亮 / 回顾（active 为选中下标）"""
    hy = y + 52
    tw = w / 3
    d.rectangle([x, hy, x+w, hy+38], fill=CARD)
    d.line([x, hy+38, x+w, hy+38], fill=LINE, width=1)
    for i, label in enumerate(["收藏", "高亮", "回顾"]):
        fnt = f(14, i == active)
        lw = d.textlength(label, font=fnt)
        cx = x + i*tw + (tw-lw)/2
        d.text([cx, hy+9], label, font=fnt, fill=BLUE if i == active else MUTED)
        if i == active:
            d.rectangle([x + i*tw + tw/2 - 40, hy+35, x + i*tw + tw/2 + 40, hy+38], fill=BLUE)
    if active == 0:  # 回顾红点徽标提示有待复习内容
        d.text([x + 2*tw + tw/2 + 16, hy+11], "", font=f(12), fill=MUTED)
        rrect(d, [x + 2*tw + tw/2 + 14, hy+10, x + 2*tw + tw/2 + 34, hy+28], 9, fill=RED)
        d.text([x + 2*tw + tw/2 + 21, hy+12], "2", font=f(12), fill=(255,255,255))
    d.rounded_rectangle([x, y, x+w, y+460], radius=14, outline=(203, 213, 225), width=2)

def trashbar(d, x, y, w, text="已删除 1 条收藏 · 10 分钟内可撤销"):
    """删除后出现在工具条下方的撤销条"""
    rrect(d, [x+14, y+172, x+w-14, y+206], 10, fill=SOFT, outline=LINE, width=1)
    d.text([x+26, y+182], text, font=f(11), fill=MUTED)
    rrect(d, [x+w-116, y+178, x+w-64, y+200], 7, fill=BLUE)
    d.text([x+w-106, y+181], "撤销", font=f(12), fill=(255,255,255))
    rrect(d, [x+w-58, y+178, x+w-22, y+200], 7, outline=LINE, width=1)
    d.text([x+w-48, y+181], "清空", font=f(12), fill=(55,65,81))

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

def popup_clips(d, hits=False, tagbox=False, undo=False, toast=None):
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 0)
    rrect(d, [x+16, y+100, x+w-16, y+130], 8, fill=CARD, outline=LINE, width=1)
    if hits:
        d.text([x+28, y+106], "量子", font=f(13), fill=INK)
        rrect(d, [x+26, y+104, x+60, y+126], 3, outline=BLUE, width=1)
    else:
        d.text([x+28, y+106], "搜索收藏内容…", font=f(13), fill=(156,163,175))
    for i, t in enumerate(["全部", "量子计算", "重点"]):
        cx = x+16 + i*90
        active = (i == 0)
        fill = BLUE if active else CARD
        col = (255,255,255) if active else MUTED
        rrect(d, [cx, y+142, cx+80, y+164], 11, fill=fill, outline=None if active else LINE, width=0 if active else 1)
        d.text([cx+16, y+146], t, font=f(13), fill=col)
    rrect(d, [x+w-46, y+142, x+w-16, y+164], 11, fill=HL_PINK if tagbox else CARD,
         outline=None if tagbox else LINE, width=0 if tagbox else 1)
    d.text([x+w-40, y+145], "标签", font=f(12), fill=INK)
    if undo:
        trashbar(d, x, y, w)
    cy = y + (214 if undo else 178)
    if tagbox:
        d.text([x+16, cy+2], "标签管理", font=f(12, True), fill=INK)
        rows = [("量子计算", 3), ("重点", 2), ("旧名", 1)]
        for i, (name, num) in enumerate(rows):
            ry = cy + 22 + i*40
            rrect(d, [x+16, ry, x+w-16, ry+34], 9, fill=CARD, outline=LINE, width=1)
            d.text([x+26, ry+9], "#" + name, font=f(12), fill=BLUE)
            d.text([x+112, ry+9], str(num), font=f(12), fill=MUTED)
            for j, op in enumerate(["改名", "合并", "删除"]):
                ox = x+w-16-3*44 + j*44
                rrect(d, [ox, ry+7, ox+38, ry+27], 6, outline=RED if op == "删除" else LINE, width=1)
                d.text([ox+5, ry+9], op, font=f(11), fill=RED if op == "删除" else (55,65,81))
        popup_footer(d, x, y, w, h)
        return
    rrect(d, [x+16, cy, x+w-16, cy+126], 12, fill=CARD, outline=LINE, width=1)
    if hits:
        rrect(d, [x+26, cy+11, x+54, cy+29], 3, fill=HL_YELLOW)
        rrect(d, [x+52, cy+33, x+80, cy+51], 3, fill=HL_YELLOW)
    d.text([x+28, cy+12], "量子比特可以同时处于 0 和 1 的叠加态，", font=f(13), fill=INK)
    d.text([x+28, cy+34], "这是量子计算超越经典计算的根本原因。", font=f(13), fill=INK)
    rrect(d, [x+28, cy+58, x+108, cy+76], 9, fill=SOFT)
    d.text([x+36, cy+60], "#量子计算", font=f(11), fill=BLUE)
    rrect(d, [x+116, cy+58, x+172, cy+76], 9, fill=SOFT)
    d.text([x+124, cy+60], "#重点", font=f(11), fill=BLUE)
    d.text([x+28, cy+84], "example.com · 09-26 07:20", font=f(11), fill=MUTED)
    for i, b in enumerate(["复制", "导出", "删除"]):
        bx = x+w-16-3*54 + i*54
        rrect(d, [bx, cy+98, bx+46, cy+118], 7, outline=LINE, width=1)
        d.text([bx+8, cy+100], b, font=f(11), fill=(55,65,81))
    cy2 = cy + 134
    rrect(d, [x+16, cy2, x+w-16, cy2+60], 12, fill=CARD, outline=LINE, width=1)
    d.rounded_rectangle([x+28, cy2+14, x+w-40, cy2+28], radius=7, fill=(236,238,241))
    d.rounded_rectangle([x+28, cy2+36, x+w-120, cy2+50], radius=7, fill=(236,238,241))
    popup_footer(d, x, y, w, h, toast=toast)

def popup_marks(d, toast=None):
    """v1.3：高亮 / 批注总览，按页面分组"""
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 1)
    rrect(d, [x+16, y+100, x+w-96, y+130], 8, fill=CARD, outline=LINE, width=1)
    d.text([x+28, y+106], "搜索高亮与批注…", font=f(13), fill=(156,163,175))
    rrect(d, [x+w-84, y+100, x+w-16, y+130], 8, fill=SOFT, outline=LINE, width=1)
    d.text([x+w-72, y+106], "导出批注", font=f(12), fill=BLUE)
    d.text([x+16, y+144], "example.com", font=f(12, True), fill=BLUE)
    d.line([x+16, y+162, x+96, y+162], fill=BLUE, width=1)
    rrect(d, [x+w-52, y+142, x+w-16, y+164], 11, fill=SOFT)
    d.text([x+w-42, y+146], "2 条", font=f(11), fill=BLUE)
    rows = [
        (HL_GREEN, "量子比特可以同时处于 0 和 1 的叠加态", "和 Leitner 盒对照着记", y + 176),
        (HL_YELLOW, "退相干时间是量子计算的主要工程难点", "", y + 268),
    ]
    for col, text, note, ry in rows:
        rrect(d, [x+16, ry, x+w-16, ry+80], 12, fill=CARD, outline=LINE, width=1)
        d.rectangle([x+16, ry, x+21, ry+80], fill=col)
        d.text([x+32, ry+12], text, font=f(12), fill=INK)
        if note:
            d.rectangle([x+32, ry+36, x+34, ry+54], fill=LINE)
            d.text([x+42, ry+38], "批注：" + note, font=f(11), fill=MUTED)
        else:
            d.text([x+32, ry+38], "09-27 09:12", font=f(11), fill=MUTED)
        for i, b in enumerate(["复制", "删除"]):
            bx = x+w-16-2*46 + i*46
            rrect(d, [bx, ry+56, bx+40, ry+74], 6, outline=RED if b == "删除" else LINE, width=1)
            d.text([bx+8, ry+58], b, font=f(11), fill=RED if b == "删除" else (55,65,81))
    popup_footer(d, x, y, w, h, toast=toast)

def popup_settings(d):
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 0)
    d.text([x+16, y+102], "设置", font=f(12, True), fill=INK)
    rrect(d, [x+16, y+126, x+w-16, y+322], 12, fill=CARD, outline=LINE, width=1)
    d.text([x+30, y+142], "每日回顾上限", font=f(13), fill=INK)
    rrect(d, [x+w-96, y+138, x+w-32, y+164], 7, fill=(249,250,251), outline=LINE, width=1)
    d.text([x+w-80, y+143], "20", font=f(13), fill=INK)
    d.text([x+30, y+170], "一次最多出几张卡（1–200）", font=f(11), fill=MUTED)
    d.line([x+30, y+196, x+w-30, y+196], fill=LINE, width=1)
    d.text([x+30, y+208], "间隔倍率", font=f(13), fill=INK)
    for i, m in enumerate(["0.5×", "1×", "2×"]):
        mx = x+w-32-3*46 + i*46
        active = (m == "1×")
        rrect(d, [mx, y+204, mx+40, y+228], 7, fill=BLUE if active else CARD,
              outline=None if active else LINE, width=0 if active else 1)
        d.text([mx+8, y+208], m, font=f(12), fill=(255,255,255) if active else MUTED)
    d.text([x+30, y+238], "倍率越大，下次复习排得越远", font=f(11), fill=MUTED)
    d.line([x+30, y+262, x+w-30, y+262], fill=LINE, width=1)
    d.text([x+30, y+272], "回收站保留", font=f(13), fill=INK)
    rrect(d, [x+w-110, y+268, x+w-32, y+292], 7, fill=(249,250,251), outline=LINE, width=1)
    d.text([x+w-100, y+273], "30 分钟 ▾", font=f(12), fill=INK)
    d.text([x+30, y+298], "删除后多久内还能撤销", font=f(11), fill=MUTED)
    rrect(d, [x+16, y+344, x+w-16, y+404], 12, fill=SOFT, outline=LINE, width=1)
    d.text([x+30, y+356], "秒存选区", font=f(13, True), fill=INK)
    rrect(d, [x+30, y+378, x+150, y+398], 6, fill=CARD, outline=(203,213,225), width=1)
    d.text([x+40, y+380], "Alt+Shift+K", font=f(12), fill=INK)
    d.text([x+162, y+380], "选中文字直接入库", font=f(11), fill=MUTED)
    popup_footer(d, x, y, w, h)

def restore_modal(d):
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 0)
    d.rectangle([x+3, y+92, x+w-3, y+h-42], fill=(232, 236, 242))
    mw, mh = 300, 236
    mx, my = x + (w-mw)//2, y + 96
    rrect(d, [mx, my, mx+mw, my+mh], 12, fill=CARD, outline=(203,213,225), width=2)
    d.text([mx+18, my+14], "恢复备份", font=f(15, True), fill=INK)
    d.text([mx+18, my+42], "clipkeep-backup-2026-09-26.json", font=f(11), fill=MUTED)
    rows = [("新增", 2, GREEN), ("相同", 1, MUTED), ("仅本地", 1, RED)]
    for i, (label, num, col) in enumerate(rows):
        ry = my + 66 + i*26
        d.ellipse([mx+20, ry+5, mx+28, ry+13], fill=col)
        d.text([mx+36, ry], label, font=f(12), fill=INK)
        d.text([mx+96, ry], f"{num} 条", font=f(12), fill=col)
    d.text([mx+18, my+148], "覆盖会以备份为准，本地独有将被删除", font=f(10), fill=MUTED)
    btns = [("合并", BLUE, (255,255,255)), ("覆盖本地", CARD, RED), ("取消", CARD, INK)]
    for i, (label, fillc, col) in enumerate(btns):
        bx = mx + 18 + i*90
        rrect(d, [bx, my+mh-40, bx+82, my+mh-12], 8, fill=fillc,
              outline=None if fillc == BLUE else LINE, width=0 if fillc == BLUE else 1)
        d.text([bx+12, my+mh-34], label, font=f(12), fill=col)

def page_toast(d, text, key=False):
    """页面底部居中的提示条：快捷键说明 + 结果反馈（无 emoji，避免缺字）"""
    label = ("Alt+Shift+K  秒存选中的文字  →  " if key else "") + text
    fnt = f(15)
    tw = d.textlength(label, font=fnt)
    px, py, ph = (W - tw) / 2 - 26, 486, 44
    rrect(d, [px, py, px + tw + 52, py + ph], 22, fill=(17, 24, 39))
    d.text([px + 26, py + 12], label, font=fnt, fill=(255, 255, 255))

HEAT = [  # v1.4 回顾热力图：8 周 × 7 天，0 未复习 / 1–3 复习量递增
    [0, 1, 2, 1, 0, 3, 1],
    [1, 0, 2, 3, 1, 0, 2],
    [2, 1, 0, 1, 3, 2, 1],
    [0, 3, 2, 1, 0, 2, 3],
    [1, 2, 3, 2, 1, 3, 2],
    [0, 1, 0, 2, 3, 1, 2],
    [2, 3, 1, 0, 2, 3, 1],
    [3, 2, 1, 3, 0, 2, 0],
]
HEAT_LVL = {0: (238, 241, 245), 1: (191, 219, 254), 2: (96, 165, 250), 3: (29, 78, 216)}

def heat_grid(d, gx, gy):
    """右上角的 8 周打卡格（格子 8px，间距 2px）"""
    for wk, col in enumerate(HEAT):
        for dy, lvl in enumerate(col):
            x0 = gx + wk * 10
            y0 = gy + dy * 10
            d.rectangle([x0, y0, x0 + 8, y0 + 8], fill=HEAT_LVL[lvl],
                         outline=None if lvl == 0 else HEAT_LVL[0], width=1)

def popup_review(d, revealed=False):
    x, y, w, h = popup_shell(d)
    popup_tabs(d, x, y, w, 2)
    heat_grid(d, x + w - 94, y + 94)
    d.text([x+16, y+102], "待回顾 2 条 · 记忆盒 1/5", font=f(12), fill=MUTED)
    d.text([x+16, y+126], "本周 14 · 连续 6 天", font=f(11), fill=(156,163,175))
    cy = y + 170
    ch = 250 if revealed else 204
    rrect(d, [x+16, cy, x+w-16, cy+ch], 14, fill=CARD, outline=LINE, width=1)
    d.multiline_text([x+36, cy+22], "量子比特可以同时处于\n0 和 1 的叠加态，\n这是量子计算超越经典\n计算的根本原因。", font=f(15), fill=INK, spacing=6)
    if revealed:
        d.line([x+36, cy+142, x+w-36, cy+142], fill=LINE, width=1)
        d.rectangle([x+36, cy+156, x+39, cy+190], fill=BLUE)
        d.text([x+48, cy+158], "标签：量子计算 / 重点", font=f(12), fill=INK)
        d.text([x+48, cy+176], "来源：example.com", font=f(12), fill=MUTED)
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

# 场景5：每日回顾（间隔重复 + 8 周热力图）
im, d, _ = base(); popup_review(d); frames.append(im.copy())
im, d, _ = base(); popup_review(d, revealed=True); frames.append(im.copy())

# 场景6：v1.2 —— 搜索命中高亮 / 标签管理 / 回顾设置
im, d, _ = base(); popup_clips(d, hits=True); frames.append(im.copy())
im, d, _ = base(); popup_clips(d, tagbox=True); frames.append(im.copy())
im, d, _ = base(); popup_settings(d); frames.append(im.copy())

# 场景7：v1.2 —— 恢复差异预览（合并 / 覆盖本地 / 取消）
im, d, _ = base(); restore_modal(d); frames.append(im.copy())

# 场景8：v1.2 —— Alt+Shift+K 秒存选区
im, d, _ = base(); selection(d); page_toast(d, "已存入 ClipKeep", key=True); frames.append(im.copy())

# 场景9：v1.3 —— 高亮 / 批注总览，整份导出 Markdown
im, d, _ = base(); popup_marks(d); frames.append(im.copy())
im, d, _ = base(); popup_marks(d, toast="已导出 2 条高亮"); frames.append(im.copy())

# 场景10：v1.3 —— 删错了能撤销（回收站，保留时长在 ⚙ 可选）
im, d, _ = base(); popup_clips(d, undo=True); frames.append(im.copy())
im, d, _ = base(); popup_clips(d, toast="已撤销删除 ✓"); frames.append(im.copy())

# 场景11：v1.4 —— 重复收藏不再静默入库
im, d, _ = base(); selection(d); page_toast(d, "这条已经在收藏里了"); frames.append(im.copy())

durations = [700, 800, 1200, 1200, 900, 1000, 1000, 1100, 1000, 1800, 1200, 1300, 1200, 1400, 1600,
             1600, 1200, 1500, 1200, 1800]
assert len(durations) == len(frames), f"durations({len(durations)}) != frames({len(frames)})"
frames[0].save(
    "/Users/liuxin/Documents/开源项目/ClipKeep/docs/demo.gif",
    save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True,
    disposal=2,
)
print("demo.gif written:", len(frames), "frames")
