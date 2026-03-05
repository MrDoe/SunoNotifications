# SunoDownloader - Firefox Extension

This directory contains the Firefox version of the SunoDownloader extension.

## Features

- Download Suno songs in MP3 or WAV
- Download lyrics in separate `.txt` files per song
- Bulk download selected songs
- Search and filter songs (liked, stems, public)
- Dark mode and cached song list
- Improved Android compatibility for downloads

## Installation

### From Mozilla Add-ons Store
Install directly from the Firefox Add-ons store.

### Manual Installation (Developer Mode)
1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" → "Load Temporary Add-on"
3. Select the `manifest.json` file from this directory

## Development

### Prerequisites
- Node.js (optional)
- web-ext: `npm install -g web-ext`

### Commands

```bash
# Run extension in Firefox
web-ext run --source-dir . --start-url https://suno.com

# Build extension package
web-ext build --source-dir . --artifacts-dir ./web-ext-artifacts

# Lint extension
web-ext lint --source-dir .
```

## Browser-Specific Features

This Firefox version includes:
- Firefox-specific manifest settings (`browser_specific_settings`)
- Background scripts using the `scripts` array (Manifest V3 Firefox format)
- Extension ID for Firefox Add-ons store
- Fallback lyrics text download strategy for environments that block `data:` download URLs
