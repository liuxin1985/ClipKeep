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
npm test        # 1161 项断言：消息路由 / 并发写 / 快捷键链路 / 标签管理 / Leitner 排期 / 恢复三选一 /
                # 高亮重放与同步 / 重叠高亮分段 / 回收站撤销与逐条恢复 / v1.4~v1.11 缺陷审计 / 回顾热力图与格子下钻 /
                # 重复收藏 / 导出模板 / 图片与链接剪藏 / 高亮颜色 / 批量选择与操作 / 回顾键盘打分 /
                # 类型与站点筛选 / 列表键盘流与键位说明 / 上限与截断如实告知 / 跨节点分段锚定与锚点自洽校验 /
                # 文档级上下文借字 / 国际化文案层与语言偏好 / Chrome-Safari 清单一致性
```

新增功能请顺带在 `test/clipkeep.test.mjs` 补几条断言；不确定怎么加可以在 Issue 里说，我们帮你写。

## 更新演示动图

README 里的 `docs/demo.gif` **不是手绘示意图**，而是 headless Chrome 直接加载真
`popup.html` / `content.js` 截出来的界面，驱动脚本按用户实际操作走一遍（勾选、切页、按空格）。
所以界面一改，动图就能重出一版：

```bash
bash docs/demo/capture.sh      # 逐帧截图到 .shots/（已 gitignore）
python3 docs/gen_demo_gif.py   # 合成 docs/demo.gif
```

`docs/demo/` 里是那套本地桩（`stub.js` 提供内存版 `chrome.*`，`driver.js` / `web_driver.js` 负责真点击），
它们只为出图服务，不参与扩展运行，也不会进 npm 包。

两个坑值得先知道：`make_shot.sh` 会把清单要装的脚本（含 `i18n.js`）逐个拷进 `docs/demo/`，
漏一个就会静默退回旧行为——断言会当场报出来；界面语言在桩里钉成 `zh`，
因为无头 Chrome 的界面语言是 en-US，偏好留空等于 `auto`，整套动图会悄悄换成英文。
想要英文那一帧就在 URL 后加 `&lang=en`（`capture.sh` 里的 `p_en` 就是这么来的）。

## 开启 CI（维护者）

仓库自带 `.github/workflows` 骨架：把 `docs/ci/workflow-test.yml` 复制成 `.github/workflows/test.yml`
并推送即可（步骤已在本地全部验证通过）。GitHub 要求提交工作流的账号具备 `workflow` 授权范围，
用 gh CLI 时需先执行 `gh auth refresh -s workflow`。

## 代码约定

- 原生 JS，每个文件一个 IIFE，全局只挂 `window.__clipkeep*` 守卫，不用打包器。
- 跨浏览器统一用 `const API = browser || chrome`。
- 存储键集中在 `clipkeep_items` / `clipkeep_highlights` / `clipkeep_trash` / `clipkeep_prefs` / `clipkeep_activity`，
  新增键请同步更新备份逻辑，并保证「备份」不把临时数据（如回收站、打卡计数）导出。
- **写存储只走 background**：内容脚本和弹窗都不要再「读整表 → 改 → 写整表」，
  而是发 `clipkeep:*` 消息，由后台那条串行写链（`chainStep`）现读现写；
  链内的步骤可以直接读写其它键，但绝不能再调用 `mutate*`，否则会自锁。
- **算排期在弹窗，落盘走 `clipkeep:grade`**：Leitner 的下次到期时间由 `popup.js` 算好后发给后台，
  后台校验结构（`validReview`）再清洗入库（`cleanReview`），并在同一步里写当天打卡计数；
  两个 key 必须原子落地，否则热力图和排期会不一致。
- **备份导入的数据一律过 `cleanItem` / `cleanHighlight`**：后台是最后一道关，
  前端做过校验也不能省——文本裁剪到 `MAX_TEXT`、标签归一化成字符串数组、`id` 非法就重新生成、
  同 id 记录先 `dedupeById` 再合并。
- 外部来源的数据字段白名单：id 用 `/^[\w-]{1,64}$/`，颜色取枚举值，数字字段夹取范围，
  拼进 HTML 前再 `esc()` 一次。
- **来源地址只认协议白名单**：`popup.js` 的 `linkable()` 只放行 `http(s)` / `file`，
  列表渲染和 Markdown 导出都用它——备份文件里的 `url` 是外部数据，
  `javascript:` 之类不能变成扩展页里可点击的链接。写 Markdown 链接时用尖括号目的地
  `[来源](<…>)`，否则 URL 里的括号会把链接写断。
- **图片 / 链接收藏的「类型 + 地址」成对校验**：`kind` 只认 `image` / `link`，
  地址必须过 `mediaUrlOk()`（`http(s)` 且不超过 `MEDIA_MAX`），否则整对字段一起丢掉、退回普通文字收藏——
  留着 `kind:"image"` 却没有合法地址，列表里就是一张点开没反应的假图片徽标。
  超长地址**不收也不截**：截断会把它变成另一个能点开的地址，用户以为存的就是原来那条。
  弹窗侧 `mediaOf()` 是同一套判断的镜像，导出与复制都走它，别再开第二个出口。
- **`clipkeep:update` 只认字段白名单**（`UPDATABLE`）：改标签不该顺手把 `createdAt`、`truncated`
  或任意未知字段写进存储，`review` 还要再过一遍 `cleanReview` 夹取。
  新增可编辑字段时记得同时加进白名单，别把合并放回开放模式。
- **打卡活动记录有两种格式**：`clipkeep_activity` 的日记录 v1.5 及以前是数字，v1.6 起是 `{ n, ids }`。
  读写两端都先用 `activityOf()` 归一化，统计口径取 `n`，明细取 `ids`（上限 `ACT_IDS_MAX`）；
  不要假设它一定是对象，也不要迁移老数据。
- **高亮颜色枚举四处同源**：`background.js` 与 `popup.js` 的 `HL_COLORS`、
  `content.js` 的 `COLORS`、`popup.js` 的 `COLOR_HEX` 必须是同一套色名与色值，
  清单一致性测试会直接比对源码；加一种颜色要四处都改，漏一处就会出现「存得进、看不见」的颜色。
- **偏好按分区写**：`clipkeep_prefs` 里 `review` / `trash` / `export` 三个分区都通过
  `savePrefs(section, patch)` 落盘，它一次读全量、逐区夹一遍合法值再写；
  新增分区要同时补对应的 `*PrefsOf()` 夹取函数，别在面板里直接 `set({[PREFS_KEY]: …})`，
  那样会把别的分区覆盖掉。
- **列表里的媒体链接只有一份渲染**：`mediaLinkHtml()` 同时给收藏列表和回顾卡片用，
  图片显示「查看原图」、链接显示域名，`title` 才是真实地址。加显示规则改这一处就行，
  别在两个渲染函数里各写一遍（曾经各写一遍，结果图片和链接显示口径不一致）。
- **批量写操作 = 一次 `cleanIds` + 一个写链步骤**：`ids` 先过 `SAFE_ID` 去重并夹到 `BATCH_MAX`，
  超出要如实回 `limited:true`（前端提示「单次上限，剩下的再选一批」，不能报成全部成功）；
  整批删除共用同一个撤销 `tid`，`clipkeep:trash-restore` 按 `tid` 成批还原——
  一条一个 `tid` 的话，用户点一次「撤销」只会回来一条。
- **弹窗里的写操作一律走 `withLock`**：删除 / 加标签 / 批量按钮都是「发消息 → 重新 load → 提示」，
  连点第二次会对着已经消失的数据再发一遍请求，然后报出「已删除 0 条，可撤销」这种谎话。
- 新增文案优先中文，兼顾英文注释。
- 不引入需要联网的 CDN（受 MV3 CSP 限制）。
- 发版清单：`[4]` 测试会检查两份 manifest 对齐、清单引用的文件都在、
  前端消息后台都有处理、CHANGELOG / README / 落地页指向当前版本号，别漏掉任何一项。

## 好上手的第一批 Issue

- 弹窗与工具条的**批量操作键盘流**（`?` 帮助浮层、方向键在列表里移动焦点）。
- 嵌套 / 重叠高亮的拆分与合并（目前同一段落重叠时会互相盖掉）。
- 英文 UI 与国际化文案层（`popup.html` / `content.js` 的中文串集中抽取）。
- 更多站点的净化阅读提取规则。
- 导出目标扩展：Obsidian 目录结构、按标签分文件（仍然纯前端生成，不联网）。

## 提交信息

使用简洁的 Conventional Commits 前缀：`feat:` `fix:` `docs:` `style:` `chore:` `test:`。
