/**
 * ClipKeep - 文案层（v1.11）
 *
 * msgid 就是中文原文：中文界面原样返回，英文界面查 EN 词典，查不到退回中文并记下缺条。
 * 这么设计的理由：
 *  - 代码里的中文既是默认文案又是键，不会出现「键和文案对不上」这类错位；
 *  - 中文用户零变化（所有既有断言仍然按中文文本比对）；
 *  - 缺一条译文只会退回中文，不会渲染成空白——而覆盖率测试会把退回的那条揪出来。
 * 零依赖、纯原生 JS，popup / content script / service worker 三处共用同一份文件。
 */
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : this;

  /* ---------- 英文词典：键是中文原文，值是大写与标点都排好版的英文 ---------- */
  const EN = {
    "\n\n输入新批注内容并回车保存；输入 !d 回车删除该高亮。"          : "\n\nType a note and press Enter to save; type !d and press Enter to delete the highlight.",
    " · {0} 条还没进备份"                             : " · {0} items aren't in a backup yet",
    " · 今日上限 {0} 条，剩余 {1} 条明天继续"               : " · daily cap {0}, {1} left for tomorrow",
    " · 回顾 {0} 条，点开看明细"                        : " · {0} reviewed, open for details",
    " · 复习 {0} 条"                              : " · {0} reviewed",
    " · 数据没有变化"                                 : " · nothing changed since",
    " · 比上次少了 {0} 条（删除不会从备份里消失）"    : " · {0} fewer than last time (deleting doesn't remove them from the backup)",
    " · 配额 {0}"                                     : " · quota {0}",
    " — 批注：{0}"                                : " — Note: {0}",
    "# ClipKeep 收藏"                            : "# ClipKeep Clips",
    "# ClipKeep 高亮与批注"                         : "# ClipKeep Highlights and Notes",
    "**备注：** "                                 : "**Note:** ",
    "**来源**: {0}"                              : "**Source**: {0}",
    "+{0} 标签"                                       : "+{0} tags",
    "+{0} 站"                                   : "+{0} sites",
    "0.5×（更快）"                                 : "0.5× (faster)",
    "1 分钟"                                     : "1 minute",
    "10 分钟"                                    : "10 minutes",
    "1×（标准）"                                   : "1× (standard)",
    "2×（更慢）"                                   : "2× (slower)",
    "30 分钟"                                    : "30 minutes",
    "5 分钟"                                     : "5 minutes",
    "60 分钟"                                    : "60 minutes",
    "> 导出于 {0} · 共 {1} 条"                      : "> Exported {0} · {1} items",
    "ClipKeep 已更新，请刷新页面后继续使用"                  : "ClipKeep was updated — refresh the page to keep using it",
    "ClipKeep 已更新，请重新打开弹窗再操作"                  : "ClipKeep was updated — reopen the popup and try again",
    "ClipKeep 批注："                             : "ClipKeep note:",
    "ClipKeep：净化阅读本页"                          : "ClipKeep: Read this page cleanly",
    "ClipKeep：收藏这个链接"                          : "ClipKeep: Save this link",
    "ClipKeep：收藏这张图片"                          : "ClipKeep: Save this image",
    "ClipKeep：收藏选中内容"                          : "ClipKeep: Save the selection",
    "Markdown 导出里每条收藏的小标题怎么写"                  : "Heading style for each clip in Markdown exports",
    "[来源](<{0}>)"                              : "[Source](<{0}>)",
    "title: ClipKeep 收藏"                       : "title: ClipKeep Clips",
    "{0} 个标签超上限没存进去（每条最多 {1} 个）"               : "{0} tags were over the limit and not saved (max {1} per clip)",
    "{0} 字节"                                        : "{0} bytes",
    "一次最多处理 {0} 条，请分批再选"                       : "At most {0} items at a time — please work in batches",
    "上次备份 {0} 条（{1}）· 现在 {2} 条"             : "Last backup {0} items ({1}) · now {2}",
    "下一条将在 {0} 到期。明天再来 ~"                      : "The next card is due {0}. Come back tomorrow ~",
    "仅显示最近 {0} 条，另有 {1} 条未列出。"                 : "Showing only the newest {0} items; {1} more are not listed.",
    "仅来源标题"                                    : "Source title only",
    "今日到期 {0} 条 · 累计复习 {1} 条"               : "{0} due today · {1} reviewed in total",
    "今日回顾已完成"                                  : "Today's review is done",
    "今日待回顾"                                    : "Due today",
    "从 JSON 备份恢复"                              : "Restore from a JSON backup",
    "从所有收藏中删除 #{0}？（不会删除内容本身）"                 : "Remove #{0} from all clips? (the content itself is not deleted)",
    "以{0}高亮"                                   : "Highlight in {0}",
    "保存"                                       : "Save",
    "保存失败"                                     : "Save failed",
    "保存失败，请刷新页面后重试"                            : "Save failed — refresh the page and try again",
    "保存失败，请重试"                                 : "Save failed, please try again",
    "保存失败：本地存储不可用，请稍后重试"                       : "Save failed: local storage is unavailable, please try again later",
    "保存失败：本地存储已满，请先导出备份清理"                     : "Save failed: local storage is full — export a backup and clean up first",
    "先去网页上划词收藏几条吧。"                            : "Select some text on a page and clip it first.",
    "全文"                                       : "Full text",
    "全文已经收藏过了"                                 : "The full text is already saved",
    "全选"                                       : "Select all",
    "关闭"                                       : "Close",
    "内容为空"                                     : "Nothing to save",
    "内容超过 {0} 字，仅保存了前半部分"                      : "Content over {0} characters — only the first part was saved",
    "写下你的批注…"                                  : "Write a note…",
    "净化阅读"                                     : "Clean read",
    "净化阅读当前页"                                  : "Read the current page cleanly",
    "分数存好了，但今天的打卡记录没写进去（热力图会少这一条）"             : "Score saved, but today's check-in wasn't recorded (the heatmap will miss it)",
    "切换深色模式"                                   : "Toggle dark mode",
    "删除"                                       : "Delete",
    "删除后可撤销的时长"                                : "How long a delete can be undone",
    "删除失败，请重试"                                 : "Delete failed, please try again",
    "加标签"                                      : "Add tag",
    "勾选 / 取消勾选焦点那条，配合批量操作"                     : "Check / uncheck the focused item for batch actions",
    "勾选后可批量删除 / 加标签 / 导出"                      : "Check items to delete, tag, or export them in bulk",
    "取消"                                       : "Cancel",
    "取消全选"                                     : "Deselect all",
    "另有 {0} 条未列出（只列最近 {1} 条）"                  : "{0} more are not listed (showing the newest {1})",
    "另有 {0} 条没有列出"                             : "{0} more aren't listed",
    "合并"                                       : "Merge",
    "合并到…"                                     : "Merge into…",
    "合并失败，请重试"                                 : "Merge failed, please try again",
    "合并：只补新内容，不动本地；覆盖本地：以备份为准（备份里没有的类别保留本地）。"  : "Merge only adds what's new and leaves local data alone; Overwrite restores the backup as-is (categories it doesn't mention keep the local data).",
    "回收站 {0} 条 · 最早一条约 {1} 分钟后清掉"       : "{0} in trash · the oldest is cleared in about {1} minutes",
    "回收站保留"                                    : "Trash retention",
    "回收站已清空"                                   : "Trash emptied",
    "回收站是空的"                                    : "The trash is empty",
    "回收站里还有更早的 {0} 条，逐条恢复请点「明细」"               : "{0} older items are still in the trash — open Details to restore them one by one",
    "回顾打分：忘记 / 记得 / 简单（要先看答案）"                 : "Review score: Forgot / Good / Easy (reveal the answer first)",
    "回顾打卡"                                     : "Review check-in",
    "回顾时显示答案"                                  : "Show the answer while reviewing",
    "图片"                                       : "Image",
    "在收藏列表里移动焦点"                               : "Move focus through the clip list",
    "在网页上划选文字，点「收藏」即可留存到这里。"                   : "Select text on a page and tap Clip to keep it here.",
    "在网页上划选文字，点工具条的 🖍 高亮或 ✎ 批注。"              : "Select text on a page and tap 🖍 Highlight or ✎ Note in the toolbar.",
    "备份"                                       : "Backup",
    "备份与本地一致，无需恢复"                             : "The backup matches local data — nothing to restore",
    "备份文件为空或格式不符"                              : "The backup file is empty or not a ClipKeep backup",
    "备份未含高亮"                                   : "The backup has no highlights",
    "备份里没有这 {0} 条本地内容，覆盖后将丢失。继续？"              : "{0} local items are missing from the backup and will be lost if you overwrite. Continue?",
    "复制"                                       : "Copy",
    "复制失败"                                     : "Copy failed",
    "存储读不到，先别导出诊断"                        : "Storage couldn't be read — hold off on exporting diagnostics",
    "存储读不到，自检没跑成。"                        : "Local storage couldn't be read, so the check didn't run.",
    "导出"                                       : "Export",
    "导出全部为 JSON 备份"                            : "Export everything as a JSON backup",
    "导出全部为 Markdown"                           : "Export everything as Markdown",
    "导出只含元数据的诊断 JSON，不含收藏正文"         : "Export a diagnostics JSON with metadata only — no clip text",
    "导出带来源链接"                                  : "Include source links in exports",
    "导出时间：{0}"                                 : "Exported: {0}",
    "导出标题样式"                                   : "Export heading style",
    "导出诊断"                                        : "Export diagnostics",
    "导出高亮批注为 Markdown"                         : "Export highlights and notes as Markdown",
    "展开 / 收起焦点那条的全文"                           : "Expand / collapse the full text of the focused item",
    "展开全文"                                     : "Expand full text",
    "已从 {0} 条中删除 #{1}"                         : "Removed #{1} from {0} items",
    "已删除 1 条 · 10 分钟内可撤销"                      : "Deleted 1 item · undoable for 10 minutes",
    "已删除 {0} 条 · {1} 分钟内可撤销"                   : "Deleted {0} items · undoable for {1} minutes",
    "已删除 {0} 条{1}"                             : "Deleted {0} items{1}",
    "已删除 {0} 条收藏 · {1} 分钟内可撤销"                 : "Deleted {0} clips · undoable for {1} minutes",
    "已删除 {0} 条高亮 · {1} 分钟内可撤销"                 : "Deleted {0} highlights · undoable for {1} minutes",
    "已删除 {0} 条（单次上限）{1}，剩下的请再选一批"              : "Deleted {0} items (batch limit){1} — select the rest again",
    "已删除高亮"                                    : "Highlight deleted",
    "已删除，但回收站没写进去，这条撤销不了"                      : "Deleted, but the trash wasn't updated — this one can't be undone",
    "已删除，可撤销"                                  : "Deleted — undo available",
    "已合并：新增 {0} 收藏 · {1} 高亮{2}"                : "Merged: {0} new clips · {1} new highlights{2}",
    "已备份 {0} 条收藏 · {1} 条高亮"                    : "Backed up {0} clips · {1} highlights",
    "已复制 ✓"                                    : "Copied ✓",
    "已导出 {0} 条"                                : "Exported {0} items",
    "已导出 {0} 条高亮"                              : "Exported {0} highlights",
    "已导出诊断 JSON（不含收藏正文）"                 : "Diagnostics JSON exported (no clip text)",
    "已恢复 1 条收藏 ✓"                              : "Restored 1 clip ✓",
    "已恢复 1 条高亮 ✓"                              : "Restored 1 highlight ✓",
    "已截断"                                      : "Truncated",
    "已批注"                                      : "Noted",
    "已批注（正文超过 {0} 字，已截断）"                      : "Noted (text over {0} characters, truncated)",
    "已换色"                                      : "Color changed",
    "已撤销 {0} 条删除 ✓"                            : "Undeleted {0} items ✓",
    "已撤销 {0} 条，另有 {1} 条已存在未重复添加"               : "Restored {0} items; {1} already existed and weren't added twice",
    "已撤销删除 ✓"                                  : "Delete undone ✓",
    "已收藏 ✓"                                    : "Saved ✓",
    "已收藏 ✓（内容过长，已截断）"                          : "Saved ✓ (content too long, truncated)",
    "已收藏 ✓（超过 {0} 字，已截断）"                      : "Saved ✓ (over {0} characters, truncated)",
    "已收藏全文 ✓"                                  : "Full text saved ✓",
    "已收藏全文 ✓（正文过长，已截断）"                        : "Full text saved ✓ (article too long, truncated)",
    "已更新 {0} 条（#{1} → #{2}）"                   : "Updated {0} items (#{1} → #{2})",
    "已清空"                                      : "Emptied",
    "已用备份覆盖：共 {0} 收藏 · {1} 高亮{2}"              : "Overwritten from backup: {0} clips · {1} highlights{2}",
    "已经是空的了"                                   : "It's already empty",
    "已给 {0} 条加标签"                              : "Tagged {0} items",
    "已给 {0} 条加标签（单次上限 {1} 条），剩下的请再选一批"         : "Tagged {0} items (batch limit {1}) — select the rest again",
    "已给 {0} 条加标签，另有 {1} 个标签超上限（每条最多 {2} 个）没存进去": "Tagged {0} items; {1} tags were over the limit (max {2} per item) and weren't saved",
    "已选 0 条"                                   : "0 selected",
    "已选 {0} 条"                                 : "{0} selected",
    "已高亮"                                      : "Highlighted",
    "已高亮（正文超过 {0} 字，已截断）"                      : "Highlighted (text over {0} characters, truncated)",
    "当前{0}，点击换成{1}"                            : "Currently {0}; click to switch to {1}",
    "当前有关键词 / 标签 / 类型 / 站点筛选，去掉一个试试。"          : "A keyword / tag / type / site filter is active — try removing one.",
    "当前页面不支持净化阅读"                              : "This page doesn't support clean reading",
    "当前页面：存 {0} 条高亮，标出 {1} 条，{2} 条定位不回" : "This page: {0} highlights stored, {1} shown, {2} can't be found again",
    "忘记"                                       : "Forgot",
    "快捷键 Alt+Shift+K 秒存当前选区；设置只存在本地。"          : "Alt+Shift+K saves the current selection instantly; settings live only on this device.",
    "快捷键："                                     : "Shortcuts:",
    "恢复"                                       : "Restore",
    "恢复备份"                                     : "Restore backup",
    "恢复备份 · 差异确认"                              : "Restore backup · confirm differences",
    "恢复失败，请重试"                                 : "Restore failed, please try again",
    "恢复失败：文件解析错误"                              : "Restore failed: the file could not be parsed",
    "打分保存失败，已还原，请重试"                           : "Couldn't save the score — reverted, please try again",
    "打开 / 关闭这份快捷键说明"                           : "Open / close this shortcut list",
    "扩展界面语言；选「跟随浏览器」时按浏览器的界面语言"                : "Extension language; Follow browser uses your browser's own language",
    "批注"                                       : "Note",
    "批注已更新 ✓"                                  : "Note updated ✓",
    "批量删除失败，请重试"                               : "Bulk delete failed, please try again",
    "批量加标签失败，请重试"                              : "Bulk tagging failed, please try again",
    "把 #{0} 合并到哪个标签？\n现有标签：{1}"                : "Merge #{0} into which tag?\nExisting tags: {1}",
    "把标签重命名为："                                 : "Rename the tag to:",
    "按存储里的数据重新算一遍"                        : "Recompute from what's in storage",
    "换一个标签 / 站点，或清除筛选看全库的到期内容。" : "Try another tag / site, or clear the filter to see everything due.",
    "换个关键词或标签试试。"                              : "Try a different keyword or tag.",
    "换个关键词试试。"                                 : "Try a different keyword.",
    "换色"                                       : "Color",
    "换色失败，请重试"                                 : "Couldn't change the color, please try again",
    "排序"                                       : "Sort",
    "搜索收藏内容…"                                  : "Search clips…",
    "搜索高亮与批注…"                                 : "Search highlights and notes…",
    "撤销"                                       : "Undo",
    "撤销失败，请重试"                                 : "Undo failed, please try again",
    "撤销这批 {0} 条"                               : "Undo these {0} items",
    "操作失败"                                     : "Action failed",
    "收藏"                                       : "Clip",
    "收藏 {0} 条 · 高亮 {1} 条 · 回收站 {2} 条"       : "{0} clips · {1} highlights · {2} in trash",
    "收藏全文"                                     : "Clip full text",
    "收藏内容"                                     : "Clip content",
    "收藏失败"                                     : "Clip failed",
    "收藏已清空，但收藏的撤销记录没关掉，还能撤销"                   : "Clips were cleared, but the undo record is still open — you can still undo",
    "收藏时间"                                     : "Saved date",
    "收起"                                       : "Hide",
    "数据大小 {0} · 存储占用 {1}"                     : "Data size {0} · storage used {1}",
    "数据大小 {0}（这个浏览器不报存储占用）"          : "Data size {0} (this browser doesn't report storage used)",
    "数据自检"                                        : "Data check",
    "文字"                                       : "Text",
    "无匹配结果"                                    : "No matches",
    "明细"                                       : "Details",
    "显示答案"                                     : "Show answer",
    "最新优先"                                     : "Newest first",
    "最早优先"                                     : "Oldest first",
    "未命名"                                      : "Untitled",
    "未能提取正文"                                   : "Couldn't extract the article",
    "本周 {0} · 连续 {1} 天 · 累计 {2}"               : "{0} this week · {1}-day streak · {2} total",
    "本组待回顾 {0} 条 · 记忆盒 {1}/{2}"                : "This set: {0} due · box {1}/{2}",
    "条两边已有（保留本地版本）"                            : "already in both (local version kept)",
    "条仅存在于本地"                                  : "only in this browser",
    "条备份里的新收藏"                                 : "new clips from the backup",
    "条已存在"                                     : "already exist",
    "条新高亮"                                     : "new highlights",
    "来源不是可点击的地址"                               : "The source isn't a clickable address",
    "来源：{0}"                                   : "Source: {0}",
    "查看原图"                                     : "View original image",
    "标签已更新"                                    : "Tags updated",
    "标签已更新，{0} 个超上限（最多 {1} 个）没进去"              : "Tags updated; {0} were over the limit (max {1}) and weren't saved",
    "标签没有变化"                                   : "The tag didn't change",
    "标签，用逗号分隔（可选）"                             : "Tags, comma separated (optional)",
    "正文被 {0} 字上限砍短 {1} 条"                    : "{1} clips were cut by the {0}-character limit",
    "正文首句"                                     : "First line of the text",
    "每日上限 {0} 条，剩余 {1} 条明天继续"                  : "Daily cap {0}, {1} left for tomorrow",
    "每日回顾上限"                                   : "Daily review cap",
    "没有可备份的数据"                                 : "Nothing to back up",
    "没有可导出的内容"                                 : "Nothing to export",
    "没有可导出的高亮"                                 : "No highlights to export",
    "没有正文被砍短的收藏"                            : "No clip was cut by the text limit",
    "没有输入标签"                                   : "No tag entered",
    "没有选中内容"                                   : "Nothing selected",
    "没有选中的文字"                                  : "No text selected",
    "添加备注（可选）"                                 : "Add a note (optional)",
    "添加批注"                                     : "Add note",
    "清空"                                       : "Clear",
    "清空全部"                                     : "Clear all",
    "清空回收站失败，请重试"                              : "Couldn't empty the trash, please try again",
    "清空回收站？清空后无法再撤销。"                          : "Empty the trash? Items can't be restored afterwards.",
    "清空失败，收藏还在，请重试"                            : "Clear failed — your clips are still there, please try again",
    "清除筛选"                                        : "Clear filter",
    "用当前颜色高亮"                                  : "Highlight with the current color",
    "界面语言"                                     : "Language",
    "确定清空全部收藏？此操作不可恢复（高亮批注不受影响）。"              : "Clear all clips? This can't be undone (highlights and notes are unaffected).",
    "空格"                                       : "Space",
    "筛选后没有结果"                                  : "No results after filtering",
    "简单"                                       : "Easy",
    "管理标签"                                     : "Manage tags",
    "粉色"                                       : "Pink",
    "给选中的 {0} 条追加标签（逗号分隔）："                    : "Add tags to the {0} selected items (comma separated):",
    "绿色"                                       : "Green",
    "编号 + 来源标题"                                : "Number + source title",
    "网页上把选区一秒存进 ClipKeep"                      : "Save the selection to ClipKeep in one keystroke",
    "自检还在跑，稍等一下再导出"                      : "The check is still running — export in a moment",
    "蓝色"                                       : "Blue",
    "覆盖失败：收藏没有写入成功，本地内容未变，请重试"                : "Overwrite failed: clips weren't written. Local content is unchanged — please try again",
    "覆盖失败：高亮没有写入成功，本地内容未变，请重试"                : "Overwrite failed: highlights weren't written. Local content is unchanged — please try again",
    "覆盖失败：收藏和高亮都没有写入成功，本地内容未变，请重试"          : "Overwrite failed: clips and highlights were not written. Local content is unchanged — please try again",
    "覆盖本地"                                     : "Overwrite local data",
    "记得"                                       : "Good",
    "设置"                                       : "Settings",
    "该内容已存在，未重复添加"                             : "Already saved — not added twice",
    "该处无法高亮"                                   : "This spot can't be highlighted",
    "该条目已过期，无法撤销"                              : "This item expired, so it can't be undone",
    "请先选中文字"                                   : "Select some text first",
    "跟随浏览器"                                    : "Follow browser",
    "输入标签，用逗号分隔："                              : "Enter tags, comma separated:",
    "输入框里打字时这些键不生效，放心搜索。"                      : "These keys don't apply while you're typing in a box — search away.",
    "还有 {0} 个标签没有列出，先用搜索或去掉筛选"     : "{0} more tags aren't listed — search or drop a filter first",
    "还有 {0} 个站点没有列出，用搜索找它们的域名"                 : "{0} more sites aren't listed — search for their domain",
    "还没备份过"                                      : "No backup yet",
    "还没有可回顾的内容"                                : "Nothing to review yet",
    "还没有收藏"                                    : "No clips yet",
    "还没有标签。给收藏「加标签」后就能在这里重命名、合并或删除。"           : "No tags yet. Add a tag to a clip and you can rename, merge, or delete them here.",
    "还没有高亮"                                    : "No highlights yet",
    "还没跑过自检。"                                  : "No check has run yet.",
    "这个地址无法收藏（不是 http(s) 或过长）"                 : "This address can't be saved (not http(s), or too long)",
    "这个筛选条件下没有要回顾的"                      : "Nothing due under this filter",
    "这个页面打不通：可能是浏览器自带页，或扩展刚更新完需要重开页面" : "This page can't be reached: it may be a browser page, or the extension just updated and the page needs reopening",
    "这个页面没有高亮记录"                            : "This page has no highlights",
    "这条已经不在回收站里了（可能已过期）"                       : "This item is no longer in the trash (it may have expired)",
    "这条已经不在收藏里了"                               : "This clip is no longer in your list",
    "这条已经在收藏里了"                                : "Already in your clips",
    "这条收藏已经在列表里了，未重复添加"                        : "This clip is already in the list — not added twice",
    "这条记录来自旧版本，只存了当天条数，没有复习明细。"                : "This record came from an older version: it only stored the daily count, no per-card details.",
    "这条高亮已经不在了"                                : "That highlight is no longer here",
    "这条高亮已经在列表里了，未重复添加"                        : "This highlight is already in the list — not added twice",
    "退出"                                       : "Exit",
    "选择这条收藏"                                   : "Select this clip",
    "逐条查看回收站，单独恢复某一条"                          : "Look through the trash and restore one item at a time",
    "重命名"                                      : "Rename",
    "重新自检"                                        : "Run again",
    "链接"                                       : "Link",
    "键盘快捷键"                                    : "Keyboard shortcuts",
    "键盘快捷键（?）"                                 : "Keyboard shortcuts (?)",
    "间隔倍率"                                     : "Interval multiplier",
    "阅读"                                       : "Read",
    "零账号 · 纯本地 · 跨浏览器"                         : "No account · Local only · Any browser",
    "高亮"                                       : "Highlight",
    "黄色"                                       : "Yellow",
    "📌 收藏"                                    : "📌 Clips",
    "🔁 回顾"                                    : "🔁 Review",
    "🖍 高亮"                                    : "🖍 Highlights",
    "（{0} 条正文过长，已截断到 {1} 字）"                   : " ({0} items were over the limit and cut to {1} characters)",
    "（无正文）"                                    : "(no text)",
    "（无）"                                      : "(none)",
    "（没有标题）"                                    : "(no title)",
    "（覆盖会丢失）"                                  : "(lost if overwritten)",
    "（跨元素，刷新后可能不显示）"                           : " (spans elements; it may not show after a refresh)",
    "（这条收藏已删除）"                                : "(this clip was deleted)",
    "，但回收站没写进去，撤销不了"                           : ", but the trash wasn't updated, so it can't be undone",
    "，只列前 {0} 条"                                 : ", only the first {0} are listed",
    "，可撤销"                                     : ", can be undone",
    "，覆盖会保留本地 {0} 条高亮 / 批注"                    : ", overwriting keeps the {0} local highlights / notes",
  };

  const SUPPORTED = ["auto", "zh", "en"];
  const missingIds = [];
  let pref = "auto";
  let resolved = "zh";

  /** 浏览器界面语言：扩展页与 service worker 优先用 i18n，内容脚本退回 navigator.language */
  function uiTag() {
    try {
      const api = (typeof browser !== "undefined" && browser.runtime) ? browser
        : (typeof chrome !== "undefined" && chrome.runtime) ? chrome : null;
      if (api && api.i18n && typeof api.i18n.getUILanguage === "function") {
        const got = String(api.i18n.getUILanguage() || "");
        if (got) return got;
      }
    } catch (_) { /* 拿不到就当没说，继续往下问 navigator */ }
    try {
      if (typeof navigator !== "undefined" && navigator.language) return String(navigator.language);
    } catch (_) { /* 同上 */ }
    return "zh";
  }

  /** zh* 区域标记（zh / zh-CN / zh-TW / zho）算中文，其它一律走英文 */
  const isChineseTag = (tag) => /^zh/i.test(String(tag || ""));

  function resolve(p) {
    const want = SUPPORTED.indexOf(p) >= 0 ? p : "auto";
    return want === "auto" ? (isChineseTag(uiTag()) ? "zh" : "en") : want;
  }

  /** 设成 auto / zh / en，返回解析后的实际语言；非法值一律当 auto */
  function setLang(p) {
    pref = SUPPORTED.indexOf(p) >= 0 ? p : "auto";
    resolved = resolve(pref);
    return resolved;
  }

  /**
   * 取文案：args 是按 {0} {1} 顺序排好的参数。
   * 中文界面直接返回 msgid；英文界面查词典，缺条目退回 msgid 并记进 missing（宁可混排也不要空白）。
   */
  function T(msgid, args) {
    let s = String(msgid == null ? "" : msgid);
    if (resolved === "en") {
      const hit = Object.prototype.hasOwnProperty.call(EN, s) ? String(EN[s]) : "";
      if (hit.trim()) s = hit;
      else if (missingIds.indexOf(s) < 0) missingIds.push(s);
    }
    if (/\{\d+\}/.test(s)) {
      const list = Array.isArray(args) ? args : [];
      s = s.replace(/\{(\d+)\}/g, (m, i) => {
        const v = list[Number(i)];
        return v === undefined || v === null ? m : String(v);
      });
    }
    return s;
  }

  /**
   * 把静态外壳翻成当前语言：data-i18n 换文本，data-i18n-title / -placeholder / -aria 换属性。
   * 属性里写的就是中文原文（msgid），所以中文界面下这一步是恒等变换。
   */
  function localize(node) {
    if (typeof document === "undefined") return;
    const scope = node || document;
    // 一律走 setAttribute：title / placeholder 有同名 property，aria-* 没有，
    // 写 el["aria-label"] 只会挂个没用的 JS 属性，读屏拿到的还是原来的中文
    const attr = (el, name, key) => {
      const v = el.getAttribute(key);
      if (v !== null) el.setAttribute(name, T(v));
    };
    scope.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = T(el.getAttribute("data-i18n")); });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => attr(el, "title", "data-i18n-title"));
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => attr(el, "placeholder", "data-i18n-placeholder"));
    scope.querySelectorAll("[data-i18n-aria]").forEach((el) => attr(el, "aria-label", "data-i18n-aria"));
  }

  /** 弹窗与阅读层的 <html lang>：翻译阅读器、字体fallback 都看它 */
  function applyDocumentLang() {
    if (typeof document === "undefined" || !document.documentElement) return;
    document.documentElement.lang = resolved === "en" ? "en" : "zh-CN";
  }

  root.ClipKeepI18N = {
    T,
    EN,
    localize,
    setLang,
    applyDocumentLang,
    lang: () => resolved,
    currentPref: () => pref,
    missing: () => missingIds.slice(),
    SUPPORTED,
  };
})();
