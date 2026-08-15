# LingoFlow 🌐 Foreign Web Reader

**一款轻量的 Chrome 扩展，助你轻松阅读外文网站。**  
A lightweight Chrome Extension for reading foreign-language websites with ease.

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v1.0.2-blue)](https://chromewebstore.google.com/detail/lingoflow-%F0%9F%8C%90-foreign-web/fkloicgbhpomiadliefangbfegkccmlh) [![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg)](LICENSE)

---

## Features / 功能特性

### Core Translation / 核心翻译

| Feature | Description |
|---------|-------------|
| **Selection Translation** | Select text on any webpage — a floating toolbar instantly shows the translation |
| **Full Page Translation** | One-click translate the entire page into your target language |
| **Bilingual Mode** | Show translations below each paragraph — read side by side with the original |
| **Hover Paragraph Translation** | Hover over any paragraph to preview a bilingual translation without clicking |
| **Restore Original** | Instantly revert the page back to its original state |

### Data Management / 数据管理

| Feature | Description |
|---------|-------------|
| **Vocabulary Book** | Save words and sentences from any page; filter by type, search, and export as CSV or JSON |
| **Translation History** | Automatic history log with search, filtering, and deletion; configurable limit |
| **Full Data Backup** | Export/Import all settings, history, and vocabulary as a single JSON backup file |

### Supported Translation Engines / 支持的翻译引擎

| Engine | Type | Key Required |
|--------|------|-------------|
| Google Translate | Free (web scraping) | No |
| MyMemory | Free (with quota) | No |
| SiliconFlow AI | API key | Yes |
| Gemini AI | API key | Yes |
| Microsoft Translator (Azure) | API key | Yes |
| Youdao Translate | API key | Yes |
| Youdao LLM | API key | Yes |
| Baidu Translate | API key | Yes |
| Baidu LLM | API key | Yes |
| Alibaba Bailian (Qwen) | API key | Yes |
| Custom (OpenAI Compatible) | API key + Base URL + Model | Yes |

### Interface & Customization / 界面与个性化

- **Light & Dark themes** — matches your browser preference
- **UI Language** — English or Chinese (follows system or manual selection)
- **Auto-save** — changes take effect immediately
- **Toolbar Position** — choose where the selection toolbar appears (above or below selection)
- **Existing bilingual content handling** — skip, or English-only fallback

### Other / 其他

- **Right-click context menu** — translate selection, save to vocabulary, copy text
- **Keyboard shortcuts supported** — use Chrome's built-in shortcut manager
- **Privacy-first** — no account, no tracking, all data stays in your browser
- **Manifest V3** — latest Chrome extension architecture

---

## Installation / 安装

### From Chrome Web Store (Recommended)

Download from the [Chrome Web Store](https://chromewebstore.google.com/detail/lingoflow-%F0%9F%8C%90-foreign-web/fkloicgbhpomiadliefangbfegkccmlh).

### Developer Mode (Manual)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `LingoFlow` folder
5. Pin the extension to the toolbar for easy access

---

## Usage / 使用说明

1. **Select text** on any webpage — a floating toolbar appears with Translate / Copy / Save buttons
2. **Right-click** selected text for quick actions via the context menu
3. Click the **LingoFlow icon** in the toolbar:
   - Choose a display mode: `Translate Page` / `Bilingual Mode` / `Restore Original`
   - Open **History** to browse past translations
   - Open **Vocabulary** to review saved words and sentences
   - Open **Settings** to configure translation engines, themes, language, and backup data

### Setting Up Translation Engines

- **Free engines** (Google, MyMemory) work out of the box — no configuration needed.
- **API-key engines** require you to obtain an API key from the respective provider. See the **API Setup Guide** in the Settings panel for step-by-step instructions for each engine.

---

## Privacy / 隐私保护

- **No account required** — no login, no registration
- **No data collection** — no analytics, no tracking, no telemetry
- **All data stays local** — stored in `chrome.storage.local` on your device
- **API keys stay local** — never sent to any server other than the translation service you configure
- **Translated text** is sent directly to your chosen translation engine — LingoFlow never proxies or stores it

See the full [Privacy Policy](https://vaxicy.github.io/LingoFlow/pages/privacy.html).

---

## Project Structure / 项目结构

```
LingoFlow/
├── manifest.json              # Manifest V3
├── popup.html / .css / .js    # Popup UI
├── js/
│   ├── background.js          # Service Worker
│   ├── content.js             # Content script (injected into pages)
│   ├── popup.js               # Popup logic
│   ├── vocabulary.js          # Vocabulary book
│   ├── history.js             # Translation history
│   └── i18n.js                # Internationalization helpers
├── css/                       # Stylesheets
├── pages/                     # Settings, Vocabulary, History, Privacy, Support
│   ├── vocabulary.html        # Vocabulary book page
│   ├── history.html           # Translation history page
│   ├── privacy.html           # Privacy policy
│   ├── support.html           # Donation / support page
│   ├── setup-guide.html       # API setup guide
│   └── setup-guide.js         # Setup guide interactivity
├── icons/                     # Extension icons (16/48/128 px)
├── assets/                    # Static resources (donation QR codes)
├── _locales/                  # i18n (en, zh_CN)
│   ├── en/
│   │   └── messages.json
│   └── zh_CN/
│       └── messages.json
├── store-assets/              # Chrome Web Store listing assets
└── scripts/                   # Development / automation scripts
```

---

## Tech Stack / 技术栈

- **Manifest V3** — Chrome Extension platform
- **Vanilla JavaScript** — no framework, no dependencies
- **Chrome Storage API** — local data persistence
- **`chrome.i18n`** — internationalization via `_locales` (English + Chinese)
- **CSS custom properties** — light / dark theming
- **`chrome.downloads` / data URL fallback** — backup export
- **`contextMenus`** — right-click integration

---

## Development / 开发

```bash
# Clone the repo
git clone https://github.com/vaxicy/LingoFlow.git

# Load unpacked in Chrome (see Installation section above)

# Make changes and reload the extension
```

### Packaging

```bash
# Create a clean zip for Chrome Web Store upload
# (excludes .git, .codebuddy, scripts/, store-assets/, dev docs)
cd LingoFlow && zip -r ../LingoFlow-v1.0.2.zip . \
  -x ".git/*" ".codebuddy/*" "scripts/*" "store-assets/*" \
  -x "create-icons.html" "README.md" "INSTALL.md" "I18N_COMPLETE.md"
```

---

## License / 开源协议

[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](LICENSE)

You are free to **share** and **adapt** the material for non-commercial purposes, provided you give appropriate credit. Commercial use requires prior permission.

---

## Support / 支持

If LingoFlow helps you read foreign-language websites more comfortably, you can support its development:

- [WeChat / PayPal donation](https://vaxicy.github.io/LingoFlow/pages/support.html)
- Report issues or suggest features via [GitHub Issues](https://github.com/vaxicy/LingoFlow/issues)

Thank you for helping keep LingoFlow free and improving!

---

<p align="center">
  Made with ❤️ for effortless cross-language reading.
</p>
