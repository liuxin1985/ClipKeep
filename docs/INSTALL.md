# 安装指南

ClipKeep 是「已解压」形态的插件，加载即用，无需构建。

## Chrome

1. 复制本仓库到本地。
2. 地址栏打开 `chrome://extensions`。
3. 右上角开启 **开发者模式**。
4. 点 **加载已解压的扩展程序** → 选择 `ClipKeep/extension/` 目录。
5. 工具栏出现 ★ 图标即安装成功。

## Microsoft Edge

1. 地址栏打开 `edge://extensions`。
2. 左下角开启 **开发人员模式**。
3. 点 **加载解压缩的扩展** → 选择 `ClipKeep/extension/` 目录。

## Safari（16.4+）

Safari 需要通过 Xcode 将 Web 扩展转换为 App 扩展：

1. 打开 `ClipKeep/extension/manifest.safari.json`，将其内容替换到 `manifest.json`（或复制一份命名为 `manifest.json`）。
2. 终端执行 `xcrun safari-web-extension-converter ClipKeep/extension`（需已安装 Xcode 命令行工具）。
3. 在生成的 Xcode 工程中 **Run**，首次运行后到
   `系统设置 → Safari → 扩展` 勾选启用 ClipKeep。

> 若暂不使用 Safari，直接用默认 `manifest.json` 即为 Chrome / Edge 版。

## 更新到 v1.1

1. 在仓库目录 `git pull`（或重新下载 zip 覆盖）。
2. `chrome://extensions` 点 ClipKeep 卡片的 **刷新** 按钮。
3. 已确认版本号为 `1.1.0`，即可使用 🖍 高亮、✎ 批注、「🔁 回顾」与「备份 / 恢复」。

> 老数据无需迁移：回顾排期对未评分的历史收藏默认从「立即到期」开始，第一次进「回顾」会一次排队较多，
> 逐条点「简单」即可把它们推远。

## 更新代码后

`chrome://extensions` 页面点 ClipKeep 卡片的 **刷新** 按钮即可生效。

## 常见问题

- **划词没弹出工具条？** 部分页面（`chrome://`、Web Store、扩展页面）出于安全限制不注入脚本，属正常现象。
- **净化阅读空白？** 极少数强动态站点正文提取失败，可重试或反馈 Issue。
- **数据在哪？** 全部存在浏览器本地 `storage.local`，卸载插件前请在弹窗导出备份。
- **高亮刷新后没了？** 高亮按文字内容匹配重放；若站点把正文改成异步渲染或原文被拆散，可能延迟出现或不再匹配。可在弹窗「备份」里确认高亮仍在，或提 Issue 附页面链接。
- **回顾的下次时间怎么算？** Leitner 六盒：忘记 → 立即再来，记得 → 升 1 盒，简单 → 升 2 盒，间隔依次 0/1/3/7/21/90 天。
- **换电脑怎么迁移？** 旧机器「备份」出 JSON → 新机器装好插件 → 弹窗「恢复」选中该文件，按 id 合并，重复导入不会产生重复数据。
