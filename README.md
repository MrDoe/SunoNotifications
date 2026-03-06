# BetterSuno

Enhance your Suno.com experience with real-time notifications and powerful song management tools.

## Features

### 🔔 Notifications
- **Live updates** - See your latest Suno notifications in real-time without grouping of similar events
- **Desktop alerts** - Get notified when someone likes or comments on your songs

### 🎵 Song Batch Download
- **Browse your library** - View all your Suno creations in one place
- **Bulk downloads** - Download multiple songs at once in MP3 or WAV format
- **Complete packages** - Include lyrics and cover images with your downloads
- **Smart filtering** - Filter by liked songs, public/private, or search by text

### ⚙️ Settings
- **Customizable polling** - Choose how often to check for new notifications

## Installation

### Chrome / Edge / Brave
1. Download and extract this extension
2. Open `chrome://extensions` in your browser
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the `dist/chrome/` folder
5. Visit [suno.com](https://suno.com) and look for the notification bell icon

### Firefox
1. Download and extract this extension
2. Open `about:debugging#/runtime/this-firefox` in Firefox
3. Click **Load Temporary Add-on**
4. Select the `manifest.json` file from the `dist/firefox/` folder
5. Visit [suno.com](https://suno.com) and look for the notification bell icon

## How to Use

1. **Open Suno.com** and log in to your account
2. **Click the bell icon** in the bottom-right corner to open the panel
3. **Switch tabs** to view Notifications, Download Songs, or Settings
4. **Download songs** by clicking "Fetch Songs", selecting tracks, and clicking "Download Selected"

## Building from Source

```bash
npm run build
```

This creates browser-specific builds in `dist/chrome/` and `dist/firefox/`.

## Support

If you encounter issues:
- Refresh the Suno.com page
- Reload the extension in your browser's extension manager
- Make sure you're logged in to Suno.com

For bugs or feature requests, please open an issue on GitHub.

## Privacy

BetterSuno operates entirely locally in your browser. No data is collected or transmitted to third parties. The extension only communicates with Suno's official APIs using your existing session.

## Disclaimer

This project is an independent enhancement for Suno users and is not affiliated with or endorsed by Suno.
We respect Suno's terms of service and do not engage in any unauthorized access, downloading, or distribution of copyrighted content. 
The extension is designed to work with the public APIs and interfaces provided by Suno and operates within the permissions granted by the user. 
Users are responsible for ensuring their use of the extension complies with Suno's terms of service and applicable laws.
Use this extension at your own risk. The developers are not liable for any issues arising from its use.
