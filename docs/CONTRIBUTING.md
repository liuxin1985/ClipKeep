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
4. 保持 **零依赖、零后端、纯本地** 的设计原则（扩展产物不许引入运行时依赖）。
5. `npm install && npm run check && npm test` 全绿后提交 PR，描述改动动机与验证方式。

## 跑测试

测试用 jsdom 直接加载真实的 `background.js` / `popup.html + popup.js` / `content.js`，
不 mock 业务逻辑，所以改 UI 结构或消息协议时它们会立刻报警。

```bash
npm install     # 只装 jsdom（devDependency）
npm run check   # node --check 语法校验
npm test        # 132 项断言：消息路由 / 快捷键链路 / 标签管理 / Leitner 排期 / 恢复三选一 / 高亮重放与删除
```

新增功能请顺带在 `test/clipkeep.test.mjs` 补几条断言；不确定怎么加可以在 Issue 里说，我们帮你写。

## 开启 CI（维护者）

仓库自带 `.github/workflows` 骨架：把 `docs/ci/workflow-test.yml` 复制成 `.github/workflows/test.yml`
并推送即可（步骤已在本地全部验证通过）。GitHub 要求提交工作流的账号具备 `workflow` 授权范围，
用 gh CLI 时需先执行 `gh auth refresh -s workflow`。

## 代码约定

- 原生 JS，每个文件一个 IIFE，全局只挂 `window.__clipkeep*` 守卫，不用打包器。
- 跨浏览器统一用 `const API = browser || chrome`。
- 存储键集中在 `clipkeep_items` / `clipkeep_highlights` / `clipkeep_prefs`，新键请同步更新备份逻辑。
- 新增文案优先中文，兼顾英文注释。
- 不引入需要联网的 CDN（受 MV3 CSP 限制）。

## 好上手的第一批 Issue

- 高亮颜色选择器（目前固定四色，🏷 面板与设置面板可作参考实现）。
- 导出模板自定义（标题格式、是否带来源、front-matter）。
- 回顾统计热力图（每天复习了几张卡，数据已在 `clipkeep_review` 里）。
- 更多站点的净化阅读提取规则。
- 真实录屏替换 `docs/demo.gif` 的示意动图（生成脚本 `docs/gen_demo_gif.py`）。

## 提交信息

使用简洁的 Conventional Commits 前缀：`feat:` `fix:` `docs:` `style:` `chore:` `test:`。
