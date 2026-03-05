# SunoDownloader

A browser extension for downloading music from [Suno.com](https://suno.com). Compatible with both **Chrome** and **Firefox**.

[![Status](https://img.shields.io/badge/status-ready-brightgreen.svg)]()
[![Chrome](https://img.shields.io/badge/chrome-compatible-blue.svg)]()
[![Firefox](https://img.shields.io/badge/firefox-compatible-orange.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## ✨ Features

- 🎵 Download your published Suno songs in MP3 or WAV format
- 📝 Download lyrics as separate `.txt` files (named by song title)
- 📦 Bulk download with folder organization
- 🔍 Search and filter your songs (liked, stems, public)
- 🆕 Cached list with automatic new-song checks
- 🌓 Dark mode support
- 🚀 Fast and reliable downloads with retry/rate-limit handling
- 📱 Improved Android download compatibility
- 💾 Caches song list for quick access

## Repository Structure

This repository contains two separate plugin directories:

- **`firefox-plugin/`** - Firefox extension with Firefox-specific manifest
- **`chrome-plugin/`** - Chrome extension with Chrome-specific manifest

Each directory is a complete, standalone extension ready to be loaded in its respective browser.

### ✅ Testing Status

Both extensions have been validated and tested:
- ✅ **Firefox**: All tests passed (0 errors, 1 optional warning)
- ✅ **Chrome**: All validations passed
- ✅ **JavaScript**: All files syntactically valid
- ✅ **Cross-browser**: Compatible API usage verified

See [TESTING.md](test_results.md) for detailed test results.

## Installation

### Chrome

#### From Chrome Web Store
*(Coming soon)*

#### Manual Installation (Developer Mode)
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `chrome-plugin` directory from this repository

### Firefox

#### From Mozilla Add-ons
Install directly from the Firefox Add-ons store.

#### Manual Installation (Developer Mode)
1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" → "Load Temporary Add-on"
3. Select the `manifest.json` file from the `firefox-plugin` directory

## Development

### Chrome Development

Navigate to the `chrome-plugin` directory and load it in Chrome:

```bash
cd chrome-plugin
# Then load via chrome://extensions/ (Developer mode -> Load unpacked)
```

### Firefox Development

Navigate to the `firefox-plugin` directory:

```bash
cd firefox-plugin

# Run extension in Firefox
web-ext run --source-dir . --start-url https://suno.com

# Build extension package
web-ext build --source-dir . --artifacts-dir ./web-ext-artifacts

# Lint extension
web-ext lint --source-dir .
```

**Prerequisites for Firefox development:**
- Node.js
- web-ext: `npm install -g web-ext`

## Testing

Both extensions have been thoroughly tested and validated:

### Running Tests

**Firefox Extension:**
```bash
cd firefox-plugin

# Validate manifest and code
web-ext lint

# Build extension package
web-ext build --overwrite-dest

# Check JavaScript syntax
node -c background.js && node -c content.js && node -c popup.js
```

**Chrome Extension:**
```bash
cd chrome-plugin

# Check JavaScript syntax
node -c background.js && node -c content.js && node -c popup.js
```

### Test Results

**Latest Test Results (2026-02-01):**
- ✅ Firefox: 0 errors, 0 notices, 1 warning (optional data_collection_permissions)
- ✅ Chrome: All validations passed
- ✅ JavaScript syntax: Valid in all files
- ✅ Cross-browser API compatibility: Verified

For detailed test results, see [test_results.md](test_results.md).

## Browser Compatibility

Both versions use the same codebase with browser-specific manifests:

| Feature | Firefox | Chrome |
|---------|---------|--------|
| **Manifest Version** | 3 | 3 |
| **Background** | `scripts: ["background.js"]` | `service_worker: "background.js"` |
| **API Polyfill** | ✅ `browser` API | ✅ `chrome` API |
| **Browser Settings** | `browser_specific_settings` | Not required |
| **Extension ID** | Firefox store ID included | Not included |

### Technical Details

- **JavaScript files**: Cross-browser compatible using the `browser`/`chrome` API polyfill pattern:
  ```javascript
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  ```
- **Manifest files**: Separate manifests optimized for each browser
  - Firefox: Uses `background.scripts` and includes `browser_specific_settings`
  - Chrome: Uses `background.service_worker`
- **Permissions**: Both use the same permissions (downloads, scripting, activeTab, storage)
- **Host Permissions**: Both access `*://*.suno.com/*`

## Troubleshooting

### Chrome

**Issue**: Extension won't load
- Ensure Developer mode is enabled
- Check that you selected the `chrome-plugin` directory (not a file)
- Look for errors in the Extensions page

**Issue**: Downloads not working
- Make sure you're logged into Suno.com
- Check that downloads permission is granted

### Firefox

**Issue**: Temporary add-on disappears after restart
- This is expected behavior for temporary add-ons
- For permanent installation, use the Firefox Add-ons store version

**Issue**: "This extension could not be installed"
- Make sure you selected the `manifest.json` file from `firefox-plugin` directory
- Check Firefox version (requires 142.0+)

**Issue**: Lyrics file is missing for some songs
- Some songs may not have lyrics available from Suno (e.g. instrumental generations)
- The extension tries both feed data and per-song API metadata before marking lyrics as missing

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

### Development Guidelines

1. Make changes in both `firefox-plugin` and `chrome-plugin` directories
2. Test in both browsers before submitting
3. Run linting for Firefox: `cd firefox-plugin && web-ext lint`
4. Verify JavaScript syntax: `node -c <filename.js>`
5. Update documentation as needed

## License

MIT License - see LICENSE file for details
