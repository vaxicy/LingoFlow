# LingoFlow 🌐 Foreign Web Reader

**一款轻量的 Chrome 扩展，助你轻松阅读外文网站。**
A lightweight Chrome Extension for reading foreign-language websites with ease.

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v1.0.2-blue)](https://chromewebstore.google.com/detail/lingoflow-%F0%9F%8C%90-foreign-web/fkloicgbhpomiadliefangbfegkccmlh) [![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg)](LICENSE)

---

## Features / 功能特性

### Core Translation / 核心翻译

| Feature | Description | 说明 |
|---------|-------------|------|
| **Selection Translation** | Select text on any webpage — a floating toolbar instantly shows the translation | 选中网页任意文本 — 浮动工具栏即时显示翻译 |
| **Full Page Translation** | One-click translate the entire page into your target language | 一键将整页翻译为目标语言 |
| **Bilingual Mode** | Show translations below each paragraph — read side by side with the original | 在每段原文下方显示翻译 — 对照阅读 |
| **Hover Paragraph Translation** | Hover over any paragraph to preview a bilingual translation without clicking | 鼠标悬停段落即可预览双语翻译，无需点击 |
| **Restore Original** | Instantly revert the page back to its original state | 一键恢复页面原始状态 |

### Data Management / 数据管理

| Feature | Description | 说明 |
|---------|-------------|------|
| **Vocabulary Book** | Save words and sentences from any page; filter by type, search, and export as CSV or JSON | 从任意页面保存单词和句子；按类型筛选、搜索，导出为 CSV 或 JSON |
| **Translation History** | Automatic history log with search, filtering, and deletion; configurable limit | 自动记录翻译历史，支持搜索、过滤和删除；可配置上限条数 |
| **Full Data Backup** | Export/Import all settings, history, and vocabulary as a single JSON backup file | 导出/导入所有设置、历史和生词本，单个 JSON 备份文件 |

### Supported Translation Engines / 支持的翻译引擎

| Engine | Type | Key Required | 需要密钥 |
|--------|------|-------------|---------|
| Google Translate | Free (web scraping) | **No — 无需 Key** ✅ | 免费即用 |
| translate.js | Free (built-in, no key) | **No — 无需 Key** ✅ | 内置免费，开箱即用 |
| MyMemory | Free (with quota) | **No — 无需 Key** ✅ | 免费（有配额限制） |
| SiliconFlow AI | API key | Yes | 需要 |
| Gemini AI | API key | Yes | 需要 |
| Microsoft Translator (Azure) | API key | Yes | 需要 |
| Youdao Translate | API key | Yes | 需要 |
| Youdao LLM | API key | Yes | 需要 |
| Baidu Translate | API key | Yes | 需要 |
| Baidu LLM | API key | Yes | 需要 |
| Alibaba Bailian (Qwen) | API key | Yes | 需要 |
| Custom (OpenAI Compatible) | API key + Base URL + Model | Yes | 需要 |

> **免费引擎说明**：Google 翻译、translate.js 和 MyMemory 三个引擎**完全免费且无需任何 API Key**，安装后即可直接使用。其余引擎需要用户自行申请对应平台的 API Key 并在设置中填写。

### About translate.js / 关于 translate.js

The built-in free translation channel in LingoFlow is powered by the open-source project [xnx3/translate](https://github.com/xnx3/translate). It runs entirely as a content script injected into the page — no API key, no configuration, and no server round-trip to LingoFlow itself. The library rotates across multiple backends (Google, MyMemory, and your own custom AI API) to maximize availability. All credit for the underlying translation logic goes to the original authors of xnx3/translate.

LingoFlow 内置的免费翻译通道基于开源项目 [xnx3/translate](https://github.com/xnx3/translate) 实现。它完全以内容脚本的形式注入页面运行——**无需 API Key、无需配置**，也不会向 LingoFlow 自身回传任何数据。该库会在多个后端（Google、MyMemory 以及用户自定义的 AI API）之间自动轮换以保证可用性。翻译底层逻辑的全部归属与致谢均归于 xnx3/translate 的原作者。

### Interface & Customization / 界面与个性化

- **Light & Dark themes** — matches your browser preference / 浅色与深色主题 — 跟随浏览器偏好
- **UI Language** — English or Chinese (follows system or manual selection) / 界面语言 — 英文或中文（跟随系统或手动选择）
- **Auto-save** — changes take effect immediately / 自动保存 — 设置更改立即生效
- **Toolbar Position** — choose where the selection toolbar appears (above or below selection) / 工具栏位置 — 选择选中文本工具栏出现的位置（上方或下方）
- **Existing bilingual content handling** — skip, or English-only fallback / 已有双语内容的处理方式 — 跳过或仅回退英文

### Other / 其他功能

- **Right-click context menu** — translate selection, save to vocabulary, copy text / 右键菜单 — 翻译选中文本、保存到生词本、复制文本
- **Keyboard shortcuts supported** — use Chrome's built-in shortcut manager / 支持键盘快捷键 — 使用 Chrome 自带的快捷键管理器
- **Privacy-first** — no account, no tracking, all data stays in your browser / 隐私优先 — 无账号、无追踪，所有数据留在浏览器本地
- **Manifest V3** — latest Chrome extension architecture / 基于 Manifest V3 — Chrome 最新扩展架构

---

## Installation / 安装

### From Chrome Web Store (Recommended) / 从 Chrome Web Store 安装（推荐）

Download from the [Chrome Web Store](https://chromewebstore.google.com/detail/lingoflow-%F0%9F%8C%90-foreign-web/fkloicgbhpomiadliefangbfegkccmlh).
从 [Chrome Web Store](https://chromewebstore.google.com/detail/lingoflow-%F0%9F%8C%90-foreign-web/fkloicgbhpomiadliefangbfegkccmlh) 下载安装。

### Developer Mode (Manual) / 开发者模式（手动安装）

1. Open Chrome and go to `chrome://extensions/` / 打开 Chrome，进入 `chrome://extensions/`
2. Enable **Developer mode** (top right) / 开启右上角 **开发者模式**
3. Click **Load unpacked** / 点击 **加载已解压的扩展程序**
4. Select the `LingoFlow` folder / 选择 `LingoFlow` 文件夹
5. Pin the extension to the toolbar for easy access / 将扩展固定到工具栏以便快速访问

---

## Usage / 使用说明

1. **Select text** on any webpage — a floating toolbar appears with Translate / Copy / Save buttons / 选中任意网页上的文本 — 弹出浮动工具栏，包含翻译 / 复制 / 保存按钮
2. **Right-click** selected text for quick actions via the context menu / **右键点击**选中文本，通过上下文菜单快速操作
3. Click the **LingoFlow icon** in the toolbar: / 点击工具栏中的 **LingoFlow 图标**：
   - Choose a display mode: `Translate Page` / `Bilingual Mode` / `Restore Original` / 选择显示模式：`整页翻译` / `双语模式` / `恢复原文`
   - Open **History** to browse past translations / 打开 **历史记录** 浏览过往翻译
   - Open **Vocabulary** to review saved words and sentences / 打开 **生词本** 查看已保存的单词和句子
   - Open **Settings** to configure translation engines, themes, language, and backup data / 打开 **设置** 配置翻译引擎、主题、语言和备份数据

### Setting Up Translation Engines / 设置翻译引擎

- **Free engines (无需 Key)** — Google 翻译、translate.js、MyMemory 三个引擎**开箱即用，无需任何配置和 API Key**。
- **API-key engines (需要 Key)** — 其余引擎需要你在对应平台申请 API Key，并在设置中填写。请参阅设置面板中的 **API Setup Guide / API 配置指南** 获取各引擎的分步指引。

---

## Privacy / 隐私保护

- **No account required** — no login, no registration / **无需账号** — 无登录、无注册
- **No data collection** — no analytics, no tracking, no telemetry / **不收集数据** — 无分析、无追踪、无遥测
- **All data stays local** — stored in `chrome.storage.local` on your device / **所有数据留本地** — 存储在你设备的 `chrome.storage.local` 中
- **API keys stay local** — never sent to any server other than the translation service you configure / **API Key 留本地** — 仅发送到你配置的翻译服务，不会发给其他任何服务器
- **Translated text** is sent directly to your chosen translation engine — LingoFlow never proxies or stores it / **翻译文本**直接发送到你选择的翻译引擎 — LingoFlow 不做代理也不存储

See the full [Privacy Policy](https://vaxicy.github.io/LingoFlow/pages/privacy.html).
查看完整的 [隐私政策](https://vaxicy.github.io/LingoFlow/pages/privacy.html)。

---

## Project Structure / 项目结构

```
LingoFlow/
├── manifest.json              # Manifest V3
├── popup.html / .css / .js    # Popup UI / 弹出界面
├── js/
│   ├── background.js          # Service Worker / 服务工作线程
│   ├── content.js             # Content script (injected into pages) / 内容脚本（注入页面）
│   ├── popup.js               # Popup logic / 弹出界面逻辑
│   ├── vocabulary.js          # Vocabulary book / 生词本
│   ├── history.js             # Translation history / 翻译历史
│   └── i18n.js                # Internationalization helpers / 国际化辅助
├── css/                       # Stylesheets / 样式表
├── pages/                     # Settings, Vocabulary, History, Privacy, Support / 设置、生词本、历史、隐私、支持
│   ├── vocabulary.html        # Vocabulary book page / 生词本页
│   ├── history.html           # Translation history page / 翻译历史页
│   ├── privacy.html           # Privacy policy / 隐私政策
│   ├── support.html           # Donation / support page / 捐赠 / 支持页
│   ├── setup-guide.html       # API setup guide / API 配置指南
│   └── setup-guide.js         # Setup guide interactivity / 配置指南交互
├── icons/                     # Extension icons (16/48/128 px) / 扩展图标
├── assets/                    # Static resources (donation QR codes) / 静态资源（捐赠二维码）
├── _locales/                  # i18n (en, zh_CN) / 国际化（英文、简体中文）
│   ├── en/
│   │   └── messages.json
│   └── zh_CN/
│       └── messages.json
├── store-assets/              # Chrome Web Store listing assets / 商店素材
└── scripts/                   # Development / automation scripts / 开发 / 自动化脚本
```

---

## Tech Stack / 技术栈

- **Manifest V3** — Chrome Extension platform / Chrome 扩展平台
- **Vanilla JavaScript** — no framework, no dependencies / 原生 JavaScript，无框架无依赖
- **Chrome Storage API** — local data persistence / 本地数据持久化
- **`chrome.i18n`** — internationalization via `_locales` (English + Chinese) / 通过 `_locales` 实现国际化（英文 + 中文）
- **CSS custom properties** — light / dark theming / CSS 自定义属性实现浅色/深色主题
- **`chrome.downloads` / data URL fallback** — backup export / 下载导出及 data URL 兜底
- **`contextMenus`** — right-click integration / 右键菜单集成

---

## Development / 开发

```bash
# Clone the repo / 克隆仓库
git clone https://github.com/vaxicy/LingoFlow.git

# Load unpacked in Chrome (see Installation section above)
# 在 Chrome 中加载解压扩展（见上方安装说明）

# Make changes and reload the extension
# 修改代码后重新加载扩展
```

### Packaging / 打包

```bash
# Create a clean zip for Chrome Web Store upload
# 创建干净的 zip 包用于上传 Chrome Web Store
# (excludes .git, .codebuddy, scripts/, store-assets/, dev docs)
# （排除 .git、.codebuddy、scripts/、store-assets/、开发文档）
cd LingoFlow && zip -r ../LingoFlow-v1.0.2.zip . \
  -x ".git/*" ".codebuddy/*" "scripts/*" "store-assets/*" \
  -x "create-icons.html" "README.md" "INSTALL.md" "I18N_COMPLETE.md"
```

---

## License / 开源协议

[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](LICENSE)

You are free to **share** and **adapt** the material for non-commercial purposes, provided you give appropriate credit. Commercial use requires prior permission.
您可以自由**共享**和**改编**本材料用于非商业用途，但须提供适当署名。商业用途需事先获得许可。

---

## Support / 支持

If LingoFlow helps you read foreign-language websites more comfortably, you can support its development:
如果 LingoFlow 让你的外文阅读更舒适，欢迎支持其持续开发：

- [WeChat / PayPal donation](https://vaxicy.github.io/LingoFlow/pages/support.html) / [微信 / PayPal 捐赠](https://vaxicy.github.io/LingoFlow/pages/support.html)
- Report issues or suggest features via [GitHub Issues](https://github.com/vaxicy/LingoFlow/issues) / 通过 [GitHub Issues](https://github.com/vaxicy/LingoFlow/issues) 反馈问题或建议新功能

Thank you for helping keep LingoFlow free and improving!
感谢你帮助 LingoFlow 保持免费并不断改进！

---

<p align="center">
  Made with ❤️ for effortless cross-language reading.<br>
  为轻松的跨语言阅读而生。❤️
</p>
