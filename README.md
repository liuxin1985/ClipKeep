# ClipKeep ★

> **零账号 · 纯本地 · 跨浏览器** 的轻量划词收藏插件。

在任意网页划选文字 → 一键存本地 → 导出 Markdown → 净化阅读。
学生整理网课重点、上班族留存周报素材，开箱即用，无后端、无广告、不上传任何数据。

> 在网页划选文字 → 浮动条点「★ 收藏」→ 打开弹窗查看/搜索/导出。演示 GIF 欢迎贡献（放置于 `docs/demo.gif`）。

---

## ✨ 为什么选 ClipKeep

- **一键即用**：装上就能划词收藏，无需注册、无需配置。
- **纯本地离线**：所有数据存在浏览器 `storage.local`，永不离开你的设备。
- **跨三浏览器**：Chrome / Edge / Safari 16.4+ 全支持（同一套代码 + Safari 适配层）。
- **导出 Markdown**：单条或批量导出，方便归档到 Obsidian / Notion / GitHub。
- **净化阅读**：一键移除广告、侧边栏、导航，只留正文。
- **标签分类 + 深色模式 + 一键复制**：高频小功能全覆盖。

##  快速开始（3 步）

1. 下载 / clone 本仓库。
2. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择 `extension/` 目录。

> 详细分浏览器安装说明见 [docs/INSTALL.md](docs/INSTALL.md)。

## 🧑‍ 使用方式

| 操作 | 方法 |
| --- | --- |
| 划词收藏 | 选中文字 → 浮动条点「★ 收藏」→（可加备注/标签）保存 |
| 右键收藏 | 选中文字 → 右键 → 「ClipKeep：收藏选中内容」 |
| 净化阅读 | 浮动条点「阅读」/ 右键「净化阅读本页」/ 弹窗 📖 |
| 查看/搜索/筛选 | 点工具栏图标打开弹窗 |
| 导出 | 弹窗右上 ⬇ 导出全部，或单条「导出」 |
| 深色模式 | 弹窗右上 🌙 / ☀️ 切换 |

## 📁 项目结构

```
ClipKeep/
├── README.md
├── LICENSE                 # MIT
├── CHANGELOG.md
├── docs/
│   ├── clipkeep-dev-plan.md   # 完整开发规划与 30 天里程碑
│   ├── INSTALL.md
│   ├── CONTRIBUTING.md
│   └── ISSUE_TEMPLATES.md
└── extension/              # 可直接加载的插件目录
    ├── manifest.json          # MV3（Chrome / Edge）
    ├── manifest.safari.json   # Safari 适配清单
    ├── background.js          # Service Worker：菜单 / 存储 / 消息路由
    ├── content.js             # 划词监听 / 浮动条 / 收藏卡片 / 净化阅读
    ├── content.css
    ├── popup.html / popup.css / popup.js   # 列表 / 搜索 / 标签 / 导出 / 深色
    └── icons/                 # 16 / 48 / 128
```

## 🛠 技术栈

原生 JavaScript + 浏览器 Extension API（Manifest V3）+ 手写 CSS（清爽卡片风）。
**零构建、零依赖、零后端** —— 改完刷新即用。

## 🗺 开发路线（30 天里程碑）

- **Day 1–7 基础版**：划词监听、本地存储、浮动收藏 UI、极简列表弹窗。
- **Day 8–18 核心迭代**：Markdown 单条/批量导出、净化阅读模式、Safari tab 权限适配。
- **Day 19–30 吸星小更新**：标签分类、深色模式、一键复制、Issue 维护。

完整拆解与每阶段 AI 开发 Prompt 见 [docs/clipkeep-dev-plan.md](docs/clipkeep-dev-plan.md)。

## 🤝 参与贡献

欢迎 Issue 与 PR！提 PR 前请先读 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。
如果 ClipKeep 帮到了你，点个 **Star** ⭐ 是最好的支持。

## 📄 许可证

[MIT](LICENSE) © ClipKeep contributors
