#!/bin/bash
# 逐帧截图：headless Chrome 直接加载真扩展界面（popup / content），驱动脚本负责真点击。
#   用法：bash docs/demo/capture.sh
#   产物：.shots/*.png（gitignore），再由 python3 docs/gen_demo_gif.py 合成 docs/demo.gif
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  CHROME="$(command -v google-chrome || command -v chromium || true)"
  [ -n "$CHROME" ] || { echo "找不到 Chrome / Chromium，装一个或改 CHROME 变量"; exit 1; }
fi
OUT="$ROOT/.shots"
mkdir -p "$OUT"
rm -f "$OUT"/*.png
bash "$HERE/make_shot.sh" >/dev/null

snap() { # snap 名称 URL 宽 高
  local name=$1 url=$2 w=$3 h=$4 prof pid watchdog
  prof=$(mktemp -d)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size="$w,$h" \
    --virtual-time-budget=8000 --user-data-dir="$prof" \
    --screenshot="$OUT/$name.png" "$url" >/dev/null 2>&1 &
  pid=$!
  ( sleep 50; kill "$pid" 2>/dev/null ) & watchdog=$!
  wait "$pid" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  rm -rf "$prof"
  echo "$name: $(ls -la "$OUT/$name.png" 2>/dev/null | awk '{print $5}') bytes"
}

# 文章页（划选工具条 / 收藏卡片 / 高亮落地 / 重叠高亮分层 / 跨节点锚点重放）
snap "w_sel"  "file://$HERE/web_shot.html?m=sel"  900 560
snap "w_card" "file://$HERE/web_shot.html?m=card" 900 560
snap "w_ov"   "file://$HERE/web_shot.html?m=ov"   900 560
snap "w_anchor" "file://$HERE/web_shot.html?m=anchor" 900 620
# 弹窗三视图 + 批量全选 + 类型筛选 + 键盘焦点 + 快捷键帮助 + 回收站明细 + 键盘打分 + 深色模式
# + 回顾按标签筛选 + 数据自检面板（380x600 就是真 popup 尺寸）
# 每帧都得进 gen_demo_gif.py 的 FRAMES：一帧一次 Chrome 启动（约 50 秒），不用的模式别顺手加进来
for f in clips batchall review reveal marks filter focus keys trash dark revfilter diag; do
  snap "p_$f" "file://$HERE/shot.html?f=$f" 380 600
done
# 英文界面那一帧：同一份 popup.html / popup.js，只是偏好把语言换成 en（?lang= 由桩接住）。
# 留着它，README 上「界面语言跟着偏好走」这句话就有图可看，而不是只在代码里。
snap "p_en" "file://$HERE/shot.html?f=clips&lang=en" 380 600
