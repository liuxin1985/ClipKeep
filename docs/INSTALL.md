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

## 更新代码后

`chrome://extensions` 页面点 ClipKeep 卡片的 **刷新** 按钮即可生效。

## 常见问题

- **划词没弹出工具条？** 部分页面（`chrome://`、Web Store、扩展页面）出于安全限制不注入脚本，属正常现象。
- **净化阅读空白？** 极少数强动态站点正文提取失败，可重试或反馈 Issue。
- **数据在哪？** 全部存在浏览器本地 `storage.local`，卸载插件前请在弹窗导出备份。
