# LingoFlow - Modern Reading Assistant for Foreign Websites

Read any website effortlessly.

## Features

### 1. Text Selection Translation
- Select any text on a webpage
- Floating toolbar appears with options:
  - **Translate**: Show translation result
  - **Copy**: Copy selected text
  - **Save**: Save to vocabulary

### 2. Right-Click Menu
- Right-click on selected text
- Options:
  - Translate Selection
  - Save to Vocabulary
  - Copy Text

### 3. Bilingual Reading Mode
- Click "Bilingual Mode" in popup
- Shows Chinese translation below original English text
- Preserves original content
- Provides "Restore Original" to revert

### 4. Page Translation
- Click "Translate Page" in popup
- Translates main content of the page
- Supports common content nodes: `p`, `li`, `h1`, `h2`, `h3`, `article`, `main`

### 5. Hover Word Definition
- Hover over English words
- Shows definition card with:
  - Chinese definition
  - Part of speech
  - Original word

### 6. Vocabulary Management
- Save words and sentences
- Search, delete, export (CSV/JSON)
- Access from popup or dedicated page

### 7. Translation History
- Save last 50 translation records
- Search, delete, clear
- Configurable history limit (20/50/100)

### 8. Settings
- Target language (Chinese/English)
- Theme (Light/Dark)
- Bilingual mode toggle
- Hover translation toggle
- History limit configuration
- Export vocabulary
- Privacy information

## Installation

### Load as Unpacked Extension

1. Open Chrome browser
2. Go to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the `LingoFlow` folder
6. The extension is now installed

### Create PNG Icons

The extension uses SVG icons. To convert them to PNG:

**Option 1: Using online converter**
- Go to https://cloudconvert.com/svg-to-png
- Upload `icon16.svg`, `icon48.svg`, `icon128.svg`
- Download and rename to `icon16.png`, `icon48.png`, `icon128.png`
- Place in the `icons` folder

**Option 2: Using ImageMagick**
```bash
magick convert icons/icon16.svg -background none icons/icon16.png
magick convert icons/icon48.svg -background none icons/icon48.png
magick convert icons/icon128.svg -background none icons/icon128.png
```

**Option 3: Using Inkscape**
```bash
inkscape --export-type=png --export-filename=icons/icon16.png -w 16 -h 16 icons/icon16.svg
inkscape --export-type=png --export-filename=icons/icon48.png -w 48 -h 48 icons/icon48.svg
inkscape --export-type=png --export-filename=icons/icon128.png -w 128 -h 128 icons/icon128.svg
```

## Usage

### Popup Interface

1. Click the LingoFlow icon in the Chrome toolbar
2. Use buttons to:
   - Translate Page
   - Enable Bilingual Mode
   - Restore Original
   - Open Vocabulary
   - Open History
   - Open Settings

### Text Selection

1. Select text on any webpage
2. Floating toolbar appears
3. Click desired action

### Right-Click Menu

1. Select text on any webpage
2. Right-click
3. Choose action from "LingoFlow" menu

### Settings

1. Click "Settings" in popup
2. Configure:
   - Target language
   - Theme
   - Bilingual mode
   - Hover translation
   - History limit
   - Export vocabulary
   - Clear history

## Architecture

### File Structure

```
LingoFlow/
├── manifest.json              # Extension manifest (Manifest V3)
├── popup.html                # Popup UI
├── popup.js                  # Popup logic
├── css/
│   ├── popup.css             # Popup styles
│   ├── content.css           # Content script styles
│   ├── options.css           # Settings page styles
│   ├── vocabulary.css        # Vocabulary page styles
│   └── history.css           # History page styles
├── js/
│   ├── background.js         # Background service worker
│   ├── content.js            # Content script
│   ├── popup.js              # Popup logic
│   ├── options.js            # Settings page logic
│   ├── vocabulary.js         # Vocabulary page logic
│   ├── history.js            # History page logic
│   └── engines/             # Translation engines (pluggable)
├── pages/
│   ├── options.html          # Settings page
│   ├── vocabulary.html       # Vocabulary page
│   └── history.html          # History page
├── icons/                   # Extension icons
├── _locales/                # Internationalization
│   ├── en/                  # English
│   └── zh_CN/               # Chinese
└── README.md                # Documentation
```

### Translation Engine Architecture

The translation engine is designed to be pluggable:

```javascript
const TranslationEngine = {
  activeEngine: 'mock',

  engines: {
    mock: { /* Mock translator */ },
    google: { /* Google Translate */ },
    libre: { /* LibreTranslate */ },
    microsoft: { /* Microsoft Translator */ },
    deepl: { /* DeepL */ },
    openai: { /* OpenAI */ },
    gemini: { /* Gemini */ }
  },

  async translate(text, targetLang) {
    return await this.engines[this.activeEngine].translate(text, targetLang);
  }
};
```

Currently using mock translator. Replace with real API integration later.

## Technical Details

### Permissions

- `storage`: Store settings, vocabulary, history
- `activeTab`: Access current tab
- `contextMenus`: Create right-click menu
- `host_permissions: <all_urls>`: Support any webpage

### Data Storage

Uses Chrome Storage Local API:

- `lingoflow_settings`: User settings
- `lingoflow_vocabulary`: Saved words/sentences
- `lingoflow_history`: Translation history

### DOM Processing

- Preserves original content
- Tracks translated nodes
- Avoids re-translation
- Skips unnecessary tags: `script`, `style`, `code`, `pre`, `input`, `textarea`, `button`, `nav`, `footer`

## Privacy

- No login required
- No data collection
- All data stored locally
- No server communication
- No tracking

## Limitations

Current version (MVP):
- Uses mock translator (shows `[Translation] text`)
- Limited dictionary for hover definitions
- Basic DOM processing

Future improvements:
- Integrate real translation APIs
- Expand dictionary database
- Improve DOM processing
- Add more features

## License

MIT License

## Support

For issues and feature requests, please contact the developer.

---

**Enjoy reading foreign websites with LingoFlow!**
