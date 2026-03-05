# SunoDownloader - Chrome Extension

This directory contains the Chrome version of the SunoDownloader extension.

## Features

- Download Suno songs in MP3 or WAV
- Download lyrics in separate `.txt` files per song
- Bulk download selected songs
- Search and filter songs (liked, stems, public)
- Dark mode and cached song list
- Improved reliability with retry/rate-limit handling

## Installation

### From Chrome Web Store
*(Coming soon)*

### Manual Installation (Developer Mode)
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right corner)
3. Click "Load unpacked"
4. Select this directory (`chrome-plugin`)

## Development

The extension can be loaded directly in Chrome using Developer Mode. No build process is required for development.

### Testing
1. Make changes to the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the SunoDownloader extension card
4. Test the updated extension

## Browser-Specific Features

This Chrome version includes:
- Chrome-compatible manifest (Manifest V3)
- Background service worker (required for Chrome)
- No browser-specific settings (Chrome doesn't use `browser_specific_settings`)
- Lyrics text download fallback for restrictive download URL environments
