#!/bin/bash
# 生成两个截图页：
#   shot.html    —— 真 popup.html + chrome 桩 + 弹窗驱动
#   web_shot.html—— 真文章页 + content.js + 划选驱动
# 每次都用时间戳当 ?v=，绕开 Chrome 按 URL 做的启发式缓存。
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
EXT="$ROOT/extension"
V=$(date +%s)

cp "$EXT/popup.css" "$EXT/popup.js" "$EXT/i18n.js" "$EXT/content.js" "$EXT/content.css" "$HERE/"

python3 - "$EXT/popup.html" "$HERE/shot.html" "$V" <<'PY'
import sys
src, dst, v = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(src, encoding="utf-8").read()
html = html.replace('href="popup.css"', f'href="popup.css?v={v}"')
# i18n.js 必须排在 popup.js / content.js 前面：漏了它，截图页会静默退回中文，
# 动图看着「还是老样子」，没人会想到是文案层没加载
html = html.replace('src="i18n.js"', f'src="i18n.js?v={v}"')
html = html.replace('<script src="popup.js"></script>',
    f'<script src="stub.js?v={v}"></script>\n'
    f'    <script src="popup.js?v={v}"></script>\n'
    f'    <script src="driver.js?v={v}"></script>')
open(dst, "w", encoding="utf-8").write(html)
print("shot.html", v)
PY

python3 - "$HERE/web.html" "$HERE/web_shot.html" "$V" <<'PY'
import sys
src, dst, v = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(src, encoding="utf-8").read()
html = html.replace('href="content.css"', f'href="content.css?v={v}"')
html = html.replace('<script src="content.js"></script>',
    f'<script src="i18n.js?v={v}"></script>\n<script src="content.js?v={v}"></script>')
html = html.replace("</body>", f'<script src="web_driver.js?v={v}"></script>\n</body>')
open(dst, "w", encoding="utf-8").write(html)
print("web_shot.html", v)
PY
