# LingoFlow

**一款轻量的浏览器扩展，让你轻松阅读外文网站。**

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Publishing-blue)](https://chrome.google.com/webstore/) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 功能特性

| 功能 | 说明 |
|------|------|
| **划词翻译** | 在网页上选中文本，即出现浮动工具栏显示译文 |
| **全文翻译** | 一键翻译整页内容 |
| **双语模式** | 在原文下方显示译文，对照阅读 |
| **悬停段落翻译** | 鼠标悬停在段落上即可预览双语结果 |
| **生词本** | 收藏单词和句子，支持导出 CSV/JSON |
| **翻译历史** | 浏览历史翻译，支持搜索与筛选 |
| **多翻译引擎** | 提供免费与付费引擎可选 |
| **浅色 / 深色主题** | 匹配你的浏览偏好 |

## 安装

### 从 Chrome 网上应用店安装（推荐）

> 敬请期待，稍后上线！

### 加载已解压的扩展（开发者）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角的 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本（`LingoFlow`）文件夹
5. 将扩展固定到工具栏

## 使用

1. **选中文本** — 任意网页选中文字，浮动工具栏提供翻译 / 复制 / 收藏
2. **右键菜单** — 选中文字后右键可快速操作
3. 点击工具栏的 **LingoFlow 图标**：
   - 全文翻译 / 切换双语模式
   - 生词本 / 翻译历史
   - 设置（翻译引擎、主题、语言等）

## 项目结构

```
LingoFlow/
├── manifest.json              # Manifest V3
├── popup.html / .js / .css    # 弹窗界面
├── js/
│   ├── background.js          # Service Worker
│   ├── content.js             # 内容脚本（注入页面）
│   ├── popup.js               # 弹窗逻辑
│   ├── options.js             # 设置页
│   ├── vocabulary.js          # 生词本
│   └── history.js             # 翻译历史
├── css/                       # 样式文件
├── pages/                     # 设置、生词本、历史、隐私权政策
├── icons/                     # 扩展图标
├── assets/                    # 静态资源
├── _locales/                  # 国际化（en、zh_CN）
└── store-assets/              # Chrome 应用店上架素材
```

## 隐私

- **无需账号**，不登录
- **不收集数据**，无追踪、无分析统计
- **数据均存于本地** 浏览器（`chrome.storage.local`）
- **API Key 仅存本地** — 绝不发送至我们的服务器
- 翻译文本仅直接发送至你选定的翻译引擎服务商

详见 [隐私权政策](pages/privacy.html)。

## 技术栈

- **Manifest V3**（Chrome 扩展）
- **原生 JavaScript**（无框架）
- **Chrome Storage API** 本地存储
- **i18n** 通过 `_locales`（中文 + 英文）

## 开源协议

[MIT](LICENSE)

---

## English

LingoFlow is a lightweight browser extension for reading foreign-language websites with ease.

**Highlights:** selection translation, full-page translation, bilingual mode, hover paragraph translation, vocabulary book (export CSV/JSON), translation history, multiple translation engines (free & paid), and light/dark themes.

All data stays on your device. No account required, no tracking, no server communication. See the [Privacy Policy](pages/privacy.html) for details.
