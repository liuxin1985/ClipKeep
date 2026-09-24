# 贡献指南

感谢你想让 ClipKeep 变得更好！

## 可以做什么

- 提 **Issue**：报 Bug、提新功能、反馈净化阅读提取失败的站点。
- 提 **PR**：修复问题或新增小工具。
- 点 **Star** ⭐：是最轻量、也最实在的支持。

## 开发流程

1. Fork 本仓库并 clone 到本地。
2. 直接在 `extension/` 目录改代码（无构建步骤）。
3. 浏览器 `chrome://extensions` 加载该目录，改完点刷新调试。
4. 保持 **零依赖、零后端、纯本地** 的设计原则。
5. 提交 PR，描述改动动机与验证方式。

## 代码约定

- 原生 ES 模块风格 JS，函数保持小而清晰。
- 跨浏览器统一用 `const API = browser || chrome`。
- 新增文案优先中文，兼顾英文注释。
- 不引入需要联网的 CDN（受 MV3 CSP 限制）。

## 提交信息

使用简洁的 Conventional Commits 前缀：`feat:` `fix:` `docs:` `style:` `chore:`。
