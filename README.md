# LingoFlow

**A lightweight browser extension for reading foreign-language websites with ease.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Publishing-blue)](https://chrome.google.com/webstore/) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Features

| Feature | Description |
|---------|-------------|
| **Selection Translation** | Select text on any page to see instant translation in a floating toolbar |
| **Full-Page Translation** | Translate the entire page content with one click |
| **Bilingual Mode** | Show translations below original text side by side |
| **Hover Paragraph Translation** | Hover over paragraphs to preview bilingual results |
| **Vocabulary Book** | Save words and sentences, export to CSV/JSON |
| **Translation History** | Browse past translations with search and filter |
| **Multiple Engines** | Free and paid translation engine options |
| **Light & Dark Themes** | Match your browsing preference |

## Installation

### From Chrome Web Store (Recommended)

> Coming soon — check back later!

### Load as Unpacked Extension (Developer)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this (`LingoFlow`) folder
5. Pin the extension to your toolbar

## Usage

1. **Select text** on any webpage — a floating toolbar appears with translate/copy/save options
2. **Right-click** selected text for quick actions via context menu
3. Click the **LingoFlow icon** in the toolbar for:
   - Page translation & bilingual mode toggle
   - Vocabulary book & history
   - Settings (engine, theme, language, etc.)

## Project Structure

```
LingoFlow/
├── manifest.json              # Manifest V3
├── popup.html / .js / .css    # Popup UI
├── js/
│   ├── background.js          # Service worker
│   ├── content.js             # Content script (injection)
│   ├── popup.js               # Popup logic
│   ├── options.js             # Settings page
│   ├── vocabulary.js          # Vocabulary book
│   └── history.js             # Translation history
├── css/                       # Stylesheets
├── pages/                     # Options, vocabulary, history, privacy policy
├── icons/                     # Extension icons
├── assets/                    # Static assets
├── _locales/                  # i18n (en, zh_CN)
└── store-assets/              # Chrome Web Store listing assets
```

## Privacy

- **No account required**, no login
- **No data collection**, no tracking, no analytics
- **All data stored locally** in your browser (`chrome.storage.local`)
- **API keys** are stored locally only — never sent to our servers
- Translation text is sent directly to your chosen engine provider

See [Privacy Policy](pages/privacy.html) for details.

## Tech Stack

- **Manifest V3** (Chrome Extension)
- **Vanilla JavaScript** (no frameworks)
- **Chrome Storage API** for local persistence
- **i18n** via `_locales` (English + Chinese)

## License

[MIT](LICENSE)
