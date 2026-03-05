// background.js
const api = (typeof browser !== 'undefined') ? browser : chrome;

let stopFetchRequested = false;
let isFetching = false;

let stopDownloadRequested = false;
let isDownloading = false;
let currentDownloadJobId = 0;
let activeDownloadIds = new Set();

const DOWNLOAD_STATE_KEY = 'sunoDownloadState';

async function getSunoTab() {
    // Popups/options can be the active tab in some browsers. Try active tab first, then fallback.
    try {
        const activeTabs = await api.tabs.query({ active: true, currentWindow: true });
        const active = activeTabs?.[0];
        if (active?.url && active.url.includes('suno.com')) return active;

        const windowTabs = await api.tabs.query({ currentWindow: true });
        const sunoInWindow = windowTabs.find(t => t.url && t.url.includes('suno.com'));
        if (sunoInWindow) return sunoInWindow;

        const allTabs = await api.tabs.query({});
        return allTabs.find(t => t.url && t.url.includes('suno.com')) || null;
    } catch (e) {
        return null;
    }
}

async function persistDownloadState(extra = {}) {
    try {
        await api.storage.local.set({
            [DOWNLOAD_STATE_KEY]: {
                isDownloading,
                stopRequested: stopDownloadRequested,
                jobId: currentDownloadJobId,
                activeDownloadIds: Array.from(activeDownloadIds),
                ...extra
            }
        });
    } catch (e) {
        // ignore
    }
}

async function readPersistedDownloadState() {
    try {
        const result = await api.storage.local.get(DOWNLOAD_STATE_KEY);
        return result?.[DOWNLOAD_STATE_KEY] || null;
    } catch (e) {
        return null;
    }
}

function broadcastDownloadState() {
    try {
        api.runtime.sendMessage({
            action: 'download_state',
            isDownloading,
            stopRequested: stopDownloadRequested,
            jobId: currentDownloadJobId
        });
    } catch (e) {
        // ignore
    }
}

// Keep active download IDs in sync (best-effort)
try {
    api.downloads?.onChanged?.addListener((delta) => {
        if (!delta || typeof delta.id !== 'number') return;
        const state = delta.state?.current;
        if (state === 'complete' || state === 'interrupted') {
            if (activeDownloadIds.delete(delta.id)) {
                persistDownloadState();
            }
        }
    });
} catch (e) {
    // ignore
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "fetch_feed_page") {
        (async () => {
            try {
                const token = message.token;
                const cursorValue = message.cursor || null;
                const isPublicOnly = !!message.isPublicOnly;
                const userId = message.userId || null;

                if (!token) {
                    sendResponse({ ok: false, status: 0, error: "Missing token" });
                    return;
                }

                const body = {
                    limit: 20,
                    filters: {
                        disliked: "False",
                        trashed: "False",
                        fromStudioProject: { presence: "False" }
                    }
                };

                if (userId) {
                    body.filters.user = {
                        presence: "True",
                        userId: userId
                    };
                }

                if (isPublicOnly) {
                    body.filters.public = "True";
                }
                if (cursorValue) {
                    body.cursor = cursorValue;
                }

                const controller = new AbortController();
                const timeoutMs = 20000;
                const timeout = setTimeout(() => controller.abort(), timeoutMs);

                const response = await fetch('https://studio-api.prod.suno.com/api/feed/v3', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                clearTimeout(timeout);

                const status = response.status;
                let data = null;
                try {
                    data = await response.json();
                } catch (e) {
                    // ignore
                }

                sendResponse({
                    ok: response.ok,
                    status,
                    data
                });
            } catch (e) {
                sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
            }
        })();
        return true;
    }

    if (message.action === "fetch_songs") {
        stopFetchRequested = false;
        isFetching = true;
        fetchSongsList(message.isPublicOnly, message.maxPages, message.checkNewOnly, message.knownIds);
    }
    
    if (message.action === "get_fetch_state") {
        sendResponse({ isFetching: isFetching });
        return true;
    }
    
    if (message.action === "stop_fetch") {
        stopFetchRequested = true;
        isFetching = false;
        // Notify content script to stop
        getSunoTab().then(tab => {
            if (tab?.id) {
                api.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => { window.sunoStopFetch = true; }
                });
            }
        });
    }
    
    if (message.action === "check_stop") {
        sendResponse({ stop: stopFetchRequested });
        return true;
    }

    if (message.action === "download_selected") {
        if (isDownloading) {
            logToPopup("⚠️ Download already running. Stop it first.");
            return;
        }
        stopDownloadRequested = false;
        isDownloading = true;
        currentDownloadJobId += 1;
        activeDownloadIds = new Set();
        persistDownloadState({ startedAt: Date.now() });
        broadcastDownloadState();
        downloadSelectedSongs(
            message.folderName,
            message.songs,
            message.format || 'mp3',
            currentDownloadJobId,
            normalizeDownloadOptions(message.downloadOptions)
        );
    }

    if (message.action === "stop_download") {
        stopDownloadRequested = true;
        isDownloading = false;
        persistDownloadState({ stoppedAt: Date.now() });
        broadcastDownloadState();

        // Try to cancel in-progress browser downloads (best-effort)
        readPersistedDownloadState().then((state) => {
            const persistedIds = Array.isArray(state?.activeDownloadIds) ? state.activeDownloadIds : [];
            const idsToCancel = Array.from(new Set([...Array.from(activeDownloadIds), ...persistedIds]));
            for (const id of idsToCancel) {
                try { api.downloads.cancel(id); } catch (e) {}
            }
        });

        // Notify the Suno page to stop any in-page WAV polling
        getSunoTab().then(tab => {
            if (tab?.id) {
                api.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => { window.sunoStopDownload = true; }
                });
            }
        });

        try { api.runtime.sendMessage({ action: "download_stopped" }); } catch (e) {}
    }

    if (message.action === "get_download_state") {
        // Prefer persisted state (helps when popup is reopened)
        readPersistedDownloadState().then((state) => {
            if (state) {
                sendResponse({
                    isDownloading: !!state.isDownloading,
                    stopRequested: !!state.stopRequested,
                    jobId: state.jobId || 0
                });
            } else {
                sendResponse({
                    isDownloading,
                    stopRequested: stopDownloadRequested,
                    jobId: currentDownloadJobId
                });
            }
        });
        return true;
    }

    if (message.action === "download_item") {
        api.downloads.download({
            url: message.url,
            filename: message.filename,
            conflictAction: "uniquify"
        });
    }
    
    if (message.action === "songs_list") {
        isFetching = false;
        // Forward songs list from content script to popup
        api.runtime.sendMessage({ 
            action: "songs_fetched", 
            songs: message.songs,
            checkNewOnly: message.checkNewOnly
        });
    }
    
    if (message.action === "fetch_error_internal") {
        isFetching = false;
        api.runtime.sendMessage({ action: "fetch_error", error: message.error });
    }
});

async function fetchSongsList(isPublicOnly, maxPages, checkNewOnly = false, knownIds = []) {
    try {
        const tab = await getSunoTab();
        if (!tab?.id || !tab.url || !tab.url.includes("suno.com")) {
            api.runtime.sendMessage({ action: "fetch_error", error: "❌ Error: Please open Suno.com in the active tab." });
            return;
        }
        const tabId = tab.id;

        if (!checkNewOnly) {
            logToPopup("🔑 Extracting Auth Token...");
        }

        const tokenResults = await api.scripting.executeScript({
            target: { tabId: tabId },
            world: "MAIN",
            func: async () => {
                try {
                    if (window.Clerk && window.Clerk.session) {
                        return await window.Clerk.session.getToken();
                    }
                    return null;
                } catch (e) { return null; }
            }
        });

        const token = tokenResults[0]?.result;

        if (!token) {
            api.runtime.sendMessage({ action: "fetch_error", error: "❌ Error: Could not find Auth Token. Log in first!" });
            return;
        }

        const userId = await fetchCurrentUserId(token);

        if (!checkNewOnly) {
            logToPopup("✅ Token found! Fetching songs list...");
        }

        await api.scripting.executeScript({
            target: { tabId: tabId },
            func: (t, p, m, c, k, u) => { 
                window.sunoAuthToken = t; 
                window.sunoPublicOnly = p;
                window.sunoMaxPages = m;
                window.sunoCheckNewOnly = c;
                window.sunoKnownIds = k;
                window.sunoUserId = u;
                window.sunoStopFetch = false;
                window.sunoMode = "fetch";
            },
            args: [token, isPublicOnly, maxPages, checkNewOnly, knownIds, userId]
        });

        await api.scripting.executeScript({
            target: { tabId: tabId },
            files: ["content.js"]
        });

    } catch (err) {
        console.error(err);
        api.runtime.sendMessage({ action: "fetch_error", error: "❌ System Error: " + err.message });
    }
}

async function fetchCurrentUserId(token) {
    try {
        const endpoints = [
            'https://studio-api.prod.suno.com/api/me/',
            'https://studio-api.prod.suno.com/api/me'
        ];

        for (const url of endpoints) {
            try {
                const res = await fetch(url, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!res.ok) continue;
                const data = await res.json();

                const direct = data?.id || data?.user_id || data?.user?.id || data?.profile?.id;
                if (typeof direct === 'string' && direct.length > 0) return direct;

                const fromTree = findUuidLikeId(data);
                if (fromTree) return fromTree;
            } catch (e) {
                // try next endpoint
            }
        }
    } catch (e) {
        // ignore
    }
    return null;
}

function findUuidLikeId(obj) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const stack = [obj];
    let safety = 0;

    while (stack.length && safety < 5000) {
        safety += 1;
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;

        for (const value of Object.values(cur)) {
            if (typeof value === 'string' && uuidRegex.test(value)) {
                return value;
            }
            if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    return null;
}

function normalizeDownloadOptions(options) {
    return {
        music: options?.music !== false,
        lyrics: options?.lyrics !== false,
        image: options?.image !== false
    };
}

async function downloadSelectedSongs(folderName, songs, format = 'mp3', jobId = 0, downloadOptions = { music: true, lyrics: true, image: true }) {
    const cleanFolder = folderName.replace(/[^a-zA-Z0-9_-]/g, "");
    
    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*]/g, "").trim().substring(0, 100);
    }

    function buildDownloadFilename(baseName) {
        const folderPrefix = sanitizeFilename(cleanFolder);
        if (isAndroid) {
            return folderPrefix ? `${folderPrefix}-${baseName}` : baseName;
        }
        return cleanFolder ? `${cleanFolder}/${baseName}` : baseName;
    }

    async function downloadTextFile(text, filename) {
        async function downloadTextFileViaPage(fileText, fullFilename) {
            const sunoTab = await getSunoTab();
            if (!sunoTab?.id) {
                throw new Error('No Suno tab found for text download fallback');
            }

            const results = await api.scripting.executeScript({
                target: { tabId: sunoTab.id },
                world: "MAIN",
                func: async (payloadText, suggestedName) => {
                    try {
                        const blob = new Blob([payloadText], { type: 'text/plain;charset=utf-8' });
                        const blobUrl = URL.createObjectURL(blob);

                        const a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = suggestedName;
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();

                        setTimeout(() => {
                            try { document.body.removeChild(a); } catch (e) {}
                            try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                        }, 5000);

                        return { ok: true };
                    } catch (e) {
                        return { error: e?.message || String(e) };
                    }
                },
                // When the downloads API rejects (e.g. data: URL not allowed), we fall back
                // to an in-page anchor. Browsers don't accept folder paths on that fallback,
                // so include the selected folder name in the suggested filename by
                // replacing path separators with '-'. This keeps files grouped by folder.
                args: [fileText, fullFilename.replace(/\//g, '-')]
            });

            const result = results?.[0]?.result;
            if (result?.error) {
                throw new Error(result.error);
            }
        }

        const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
        try {
            const downloadId = await api.downloads.download({
                url: dataUrl,
                filename,
                conflictAction: "uniquify"
            });
            if (typeof downloadId === 'number') {
                activeDownloadIds.add(downloadId);
                persistDownloadState();
            }
        } catch (err) {
            const msg = err?.message || String(err);
            const denied = /access denied|error processing url|invalid url|unsupported url/i.test(msg);
            if (!denied) throw err;
            await downloadTextFileViaPage(text, filename);
        }
    }

    function extractText(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        }

        if (Array.isArray(value)) {
            const parts = value.map(v => extractText(v)).filter(Boolean);
            if (parts.length > 0) return parts.join('\n');
        }

        if (value && typeof value === 'object') {
            const nestedCandidates = [
                value.lyrics,
                value.display_lyrics,
                value.full_lyrics,
                value.raw_lyrics,
                value.prompt,
                value.text,
                value.content,
                value.value
            ];
            for (const candidate of nestedCandidates) {
                const text = extractText(candidate);
                if (text) return text;
            }
        }

        return null;
    }

    function extractLyricsFromData(data) {
        if (!data || typeof data !== 'object') return null;

        const directCandidates = [
            data.lyrics,
            data.display_lyrics,
            data.full_lyrics,
            data.raw_lyrics,
            data.prompt,
            data.metadata?.lyrics,
            data.metadata?.display_lyrics,
            data.metadata?.full_lyrics,
            data.metadata?.raw_lyrics,
            data.metadata?.prompt,
            data.meta?.lyrics,
            data.meta?.display_lyrics,
            data.meta?.prompt,
            data.clip?.lyrics,
            data.clip?.display_lyrics,
            data.clip?.prompt,
            data.generation?.lyrics,
            data.generation?.prompt
        ];

        for (const candidate of directCandidates) {
            const text = extractText(candidate);
            if (text) return text;
        }

        return null;
    }

    async function getAuthContext(authCtx) {
        if (authCtx.failed) return authCtx;
        if (authCtx.token && authCtx.tabId) return authCtx;

        const tab = await getSunoTab();
        if (!tab?.id || !tab.url || !tab.url.includes('suno.com')) {
            authCtx.failed = true;
            return authCtx;
        }

        authCtx.tabId = tab.id;

        if (!authCtx.token) {
            const tokenResults = await api.scripting.executeScript({
                target: { tabId: tab.id },
                world: "MAIN",
                func: async () => {
                    try {
                        if (window.Clerk && window.Clerk.session) {
                            return await window.Clerk.session.getToken();
                        }
                        return null;
                    } catch (e) {
                        return null;
                    }
                }
            });
            authCtx.token = tokenResults?.[0]?.result || null;
            if (!authCtx.token) {
                authCtx.failed = true;
            }
        }

        return authCtx;
    }

    async function fetchSongDataFromApi(songId, authCtx) {
        const ctx = await getAuthContext(authCtx);
        if (!ctx.token || !ctx.tabId) return null;

        const results = await api.scripting.executeScript({
            target: { tabId: ctx.tabId },
            world: "MAIN",
            func: async (clipId, authToken) => {
                const endpoints = [
                    `https://studio-api.prod.suno.com/api/gen/${clipId}/`,
                    `https://studio-api.prod.suno.com/api/gen/${clipId}`,
                    `https://studio-api.prod.suno.com/api/gen/${clipId}/metadata/`,
                    `https://studio-api.prod.suno.com/api/gen/${clipId}/metadata`
                ];

                for (const url of endpoints) {
                    try {
                        const response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                'Authorization': `Bearer ${authToken}`,
                                'Accept': 'application/json'
                            }
                        });
                        if (!response.ok) continue;
                        const data = await response.json();
                        return data;
                    } catch (e) {
                        // try next endpoint
                    }
                }

                return null;
            },
            args: [songId, ctx.token]
        });

        return results?.[0]?.result || null;
    }

    async function resolveLyricsForSong(song, authCtx) {
        const fromSong = typeof song.lyrics === 'string' ? song.lyrics.trim() : '';
        if (fromSong) return fromSong;

        try {
            const apiData = await fetchSongDataFromApi(song.id, authCtx);
            const extracted = extractLyricsFromData(apiData);
            return extracted || '';
        } catch (e) {
            return '';
        }
    }

    function extractImageUrlFromData(data) {
        if (!data || typeof data !== 'object') return null;

        function scoreImageUrl(url) {
            if (!url || typeof url !== 'string') return -1;
            let score = 0;
            const u = url.toLowerCase();

            if (/\b(large|full|orig|original|hd|uhd|4k|2048|1536|1024)\b/.test(u)) score += 6;
            if (/\b(image_large|cover_image)\b/.test(u)) score += 4;
            if (/\bthumbnail|thumb|small|avatar\b/.test(u)) score -= 8;
            if (/[?&](w|h|width|height)=\d{1,3}\b/.test(u)) score -= 3;

            return score;
        }

        const directCandidates = [
            data.image_large_url,
            data.cover_image_url,
            data.image_url,
            data.cover_url,
            data.image,
            data.thumbnail_url,
            data.artwork_url,
            data.image_hd_url,
            data.image_4k_url,
            data.image_original_url,
            data.metadata?.image_url,
            data.metadata?.image_large_url,
            data.metadata?.image,
            data.metadata?.cover_url,
            data.metadata?.cover_image_url,
            data.meta?.image_url,
            data.meta?.image_large_url,
            data.meta?.image,
            data.meta?.cover_url,
            data.meta?.cover_image_url,
            data.clip?.image_url,
            data.clip?.image_large_url,
            data.clip?.image,
            data.clip?.cover_url,
            data.clip?.cover_image_url,
            data.generation?.image_url,
            data.generation?.image_large_url,
            data.generation?.image,
            data.generation?.cover_url,
            data.generation?.cover_image_url
        ];

        let bestUrl = null;
        let bestScore = -999;
        for (const candidate of directCandidates) {
            if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) {
                const url = candidate.trim();
                const score = scoreImageUrl(url);
                if (score > bestScore) {
                    bestScore = score;
                    bestUrl = url;
                }
            }
        }

        return bestUrl;
    }

    function isLikelyThumbnailUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const u = url.toLowerCase();
        return /\bthumbnail|thumb|small|avatar\b/.test(u) || /[?&](w|h|width|height)=\d{1,3}\b/.test(u);
    }

    async function resolveImageUrlForSong(song, authCtx) {
        const fromSong = typeof song.image_url === 'string' ? song.image_url.trim() : '';
        const validFromSong = (fromSong && /^https?:\/\//i.test(fromSong)) ? fromSong : '';
        const songIsThumb = isLikelyThumbnailUrl(validFromSong);

        // Keep the existing URL only if it doesn't look like a thumbnail.
        if (validFromSong && !songIsThumb) return validFromSong;

        try {
            const apiData = await fetchSongDataFromApi(song.id, authCtx);
            const fromApi = extractImageUrlFromData(apiData) || '';
            if (fromApi) return fromApi;

            // Fallback only when API did not provide a better URL.
            return validFromSong || '';
        } catch (e) {
            return validFromSong || '';
        }
    }

    function getImageExtensionFromUrl(url) {
        try {
            const pathname = new URL(url).pathname || '';
            const ext = pathname.split('.').pop()?.toLowerCase();
            if (ext && /^[a-z0-9]{2,5}$/.test(ext)) {
                return ext;
            }
        } catch (e) {
            // ignore
        }
        return 'jpg';
    }

    async function downloadImageForSong(song) {
        const title = song.title || `Untitled_${song.id}`;
        const imageUrl = await resolveImageUrlForSong(song, lyricsAuthContext);
        if (!imageUrl) {
            return { downloaded: false, missing: true, title };
        }

        const ext = getImageExtensionFromUrl(imageUrl);
        const baseName = `${sanitizeFilename(title)}_${song.id.slice(-4)}_cover.${ext}`;
        const filename = buildDownloadFilename(baseName);

        try {
            await downloadOneFile(imageUrl, filename);
            return { downloaded: true, missing: false, title };
        } catch (err) {
            return { downloaded: false, missing: false, title, error: err?.message || String(err) };
        }
    }

    async function downloadLyricsForSong(song) {
        const title = song.title || `Untitled_${song.id}`;
        const lyrics = await resolveLyricsForSong(song, lyricsAuthContext);
        if (!lyrics) {
            return { downloaded: false, missing: true, title };
        }

        const baseName = `${sanitizeFilename(title)}_${song.id.slice(-4)}.txt`;
        const filename = buildDownloadFilename(baseName);
        const textContent = `${title}\n\n${lyrics}\n`;

        try {
            await downloadTextFile(textContent, filename);
            return { downloaded: true, missing: false, title };
        } catch (err) {
            return { downloaded: false, missing: false, title, error: err?.message || String(err) };
        }
    }
    
    const shouldDownloadMusic = !!downloadOptions?.music;
    const shouldDownloadLyrics = !!downloadOptions?.lyrics;
    const shouldDownloadImage = !!downloadOptions?.image;
    const selectedTypes = [];
    if (shouldDownloadMusic) selectedTypes.push(format.toUpperCase());
    if (shouldDownloadLyrics) selectedTypes.push('lyrics');
    if (shouldDownloadImage) selectedTypes.push('images');

    if (selectedTypes.length === 0) {
        logToPopup('⚠️ Nothing selected to download.');
        stopDownloadRequested = false;
        isDownloading = false;
        activeDownloadIds = new Set();
        persistDownloadState({ finishedAt: Date.now() });
        broadcastDownloadState();
        api.runtime.sendMessage({ action: "download_complete", stopped: false });
        return;
    }

    logToPopup(`🚀 Starting download of ${songs.length} song(s): ${selectedTypes.join(', ')}...`);

    // Some platforms (notably Firefox Android) may not support subfolders in downloads filenames.
    let isAndroid = false;
    try {
        const platformInfo = await api.runtime.getPlatformInfo();
        isAndroid = platformInfo?.os === 'android';
    } catch (e) {
        // ignore
    }

    if (isAndroid) {
        logToPopup('📱 Android detected: saving files without subfolders.');
    }

    async function downloadOneFile(url, filename) {
        const downloadId = await api.downloads.download({
            url,
            filename,
            conflictAction: "uniquify"
        });
        if (typeof downloadId === 'number') {
            activeDownloadIds.add(downloadId);
            persistDownloadState();
        }
        return true;
    }

    // Ensure in-page stop flag exists (used for WAV polling)
    try {
        const tab = await getSunoTab();
        if (tab?.id && tab.url && tab.url.includes("suno.com")) {
            await api.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => { window.sunoStopDownload = false; }
            });
        }
    } catch (e) {
        // ignore
    }
    
    let downloadedCount = 0;
    let lyricsDownloadedCount = 0;
    let lyricsMissingCount = 0;
    let imagesDownloadedCount = 0;
    let imagesMissingCount = 0;
    let failedCount = 0;
    const lyricsAuthContext = { token: null, tabId: null, failed: false };
    
    // For WAV downloads, we need to use the authenticated API
    if (format === 'wav' && shouldDownloadMusic) {
        // Get the active tab to execute the WAV conversion requests
        const tab = await getSunoTab();
        if (!tab?.id || !tab.url || !tab.url.includes("suno.com")) {
            logToPopup("❌ Error: Please open Suno.com for WAV downloads.");
            api.runtime.sendMessage({ action: "download_complete" });
            return;
        }
        const tabId = tab.id;
        
        // Get auth token
        const tokenResults = await api.scripting.executeScript({
            target: { tabId: tabId },
            world: "MAIN",
            func: async () => {
                try {
                    if (window.Clerk && window.Clerk.session) {
                        return await window.Clerk.session.getToken();
                    }
                    return null;
                } catch (e) { return null; }
            }
        });
        
        const token = tokenResults[0]?.result;
        if (!token) {
            logToPopup("❌ Error: Could not get auth token for WAV download.");
            api.runtime.sendMessage({ action: "download_complete" });
            return;
        }
        lyricsAuthContext.token = token;
        lyricsAuthContext.tabId = tabId;
        
        for (const song of songs) {
            if (stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId) {
                logToPopup("⏹️ Download stopped by user.");
                break;
            }
            const title = song.title || `Untitled_${song.id}`;
            const baseName = `${sanitizeFilename(title)}_${song.id.slice(-4)}.wav`;
            const filename = buildDownloadFilename(baseName);
            
            try {
                // Request WAV conversion and poll until ready
                const wavResult = await api.scripting.executeScript({
                    target: { tabId: tabId },
                    world: "MAIN",
                    func: async (clipId, authToken) => {
                        try {
                            if (window.sunoStopDownload) {
                                return { stopped: true };
                            }
                            // Step 1: Start the conversion
                            const convertResponse = await fetch(`https://studio-api.prod.suno.com/api/gen/${clipId}/convert_wav/`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${authToken}`
                                }
                            });
                            
                            if (!convertResponse.ok) {
                                return { error: `Convert HTTP ${convertResponse.status}` };
                            }
                            
                            // Step 2: Poll for the WAV file URL
                            const maxAttempts = 30;
                            for (let i = 0; i < maxAttempts; i++) {
                                if (window.sunoStopDownload) {
                                    return { stopped: true };
                                }
                                await new Promise(r => setTimeout(r, 1000));
                                
                                const pollResponse = await fetch(`https://studio-api.prod.suno.com/api/gen/${clipId}/wav_file/`, {
                                    method: 'GET',
                                    headers: {
                                        'Authorization': `Bearer ${authToken}`
                                    }
                                });
                                
                                if (pollResponse.ok) {
                                    const data = await pollResponse.json();
                                    const wavUrl = data.wav_file_url || data.url || data.download_url;
                                    if (wavUrl) {
                                        return { url: wavUrl };
                                    }
                                    if (data.status === 'complete' || data.status === 'ready') {
                                        return { url: wavUrl };
                                    }
                                } else if (pollResponse.status === 404 || pollResponse.status === 202) {
                                    // Still processing, continue polling
                                    continue;
                                } else {
                                    return { error: `Poll HTTP ${pollResponse.status}` };
                                }
                            }
                            return { error: 'Timeout waiting for WAV' };
                        } catch (e) {
                            return { error: e.message };
                        }
                    },
                    args: [song.id, token]
                });
                
                const result = wavResult[0]?.result;

                if (result?.stopped) {
                    logToPopup("⏹️ Download stopped by user.");
                    break;
                }
                
                if (result?.error) {
                    logToPopup(`⚠️ WAV failed: ${title} (${result.error})`);
                    failedCount++;
                    continue;
                }
                
                if (result?.url) {
                    await downloadOneFile(result.url, filename);
                    downloadedCount++;
                    
                    if (downloadedCount % 5 === 0) {
                        logToPopup(`📥 Downloaded ${downloadedCount}/${songs.length}...`);
                    }
                } else {
                    logToPopup(`⚠️ No WAV URL: ${title}`);
                    failedCount++;
                }

                if (shouldDownloadLyrics && !(stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId)) {
                    const lyricsResult = await downloadLyricsForSong(song);
                    if (lyricsResult.downloaded) {
                        lyricsDownloadedCount++;
                    } else if (lyricsResult.missing) {
                        lyricsMissingCount++;
                        logToPopup(`⚠️ No lyrics found: ${title}`);
                    } else if (lyricsResult.error) {
                        failedCount++;
                        logToPopup(`⚠️ Lyrics failed: ${title} (${lyricsResult.error})`);
                    }
                }

                if (shouldDownloadImage && !(stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId)) {
                    const imageResult = await downloadImageForSong(song);
                    if (imageResult.downloaded) {
                        imagesDownloadedCount++;
                    } else if (imageResult.missing) {
                        imagesMissingCount++;
                        logToPopup(`⚠️ No image found: ${title}`);
                    } else if (imageResult.error) {
                        failedCount++;
                        logToPopup(`⚠️ Image failed: ${title} (${imageResult.error})`);
                    }
                }
            } catch (err) {
                const msg = (err && (err.message || err.toString)) ? (err.message || err.toString()) : '';
                logToPopup(`⚠️ Failed: ${title}${msg ? ` (${msg})` : ''}`);
                failedCount++;
            }
            
            // Longer delay for WAV to avoid rate limiting
            await new Promise(r => setTimeout(r, 500));
        }
    } else {
        // MP3 downloads - direct from CDN
        for (const song of songs) {
            if (stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId) {
                logToPopup("⏹️ Download stopped by user.");
                break;
            }
            if (shouldDownloadMusic && song.audio_url) {
                const title = song.title || `Untitled_${song.id}`;
                const baseName = `${sanitizeFilename(title)}_${song.id.slice(-4)}.mp3`;
                const filename = buildDownloadFilename(baseName);
                
                try {
                    await downloadOneFile(song.audio_url, filename);
                    downloadedCount++;
                    
                    if (downloadedCount % 5 === 0) {
                        logToPopup(`📥 Downloaded ${downloadedCount}/${songs.length}...`);
                    }
                } catch (err) {
                    const msg = (err && (err.message || err.toString)) ? (err.message || err.toString()) : '';
                    logToPopup(`⚠️ Failed: ${title}${msg ? ` (${msg})` : ''}`);
                    failedCount++;
                }
                
                await new Promise(r => setTimeout(r, 200));
            }

            if (shouldDownloadLyrics && !(stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId)) {
                const title = song.title || `Untitled_${song.id}`;
                const lyricsResult = await downloadLyricsForSong(song);
                if (lyricsResult.downloaded) {
                    lyricsDownloadedCount++;
                } else if (lyricsResult.missing) {
                    lyricsMissingCount++;
                    logToPopup(`⚠️ No lyrics found: ${title}`);
                } else if (lyricsResult.error) {
                    failedCount++;
                    logToPopup(`⚠️ Lyrics failed: ${title} (${lyricsResult.error})`);
                }
            }

            if (shouldDownloadImage && !(stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId)) {
                const title = song.title || `Untitled_${song.id}`;
                const imageResult = await downloadImageForSong(song);
                if (imageResult.downloaded) {
                    imagesDownloadedCount++;
                } else if (imageResult.missing) {
                    imagesMissingCount++;
                    logToPopup(`⚠️ No image found: ${title}`);
                } else if (imageResult.error) {
                    failedCount++;
                    logToPopup(`⚠️ Image failed: ${title} (${imageResult.error})`);
                }
            }
        }
    }
    
    const stopped = stopDownloadRequested || !isDownloading || jobId !== currentDownloadJobId;
    const parts = [];
    if (shouldDownloadMusic) parts.push(`${downloadedCount} song(s)`);
    if (shouldDownloadLyrics) parts.push(`${lyricsDownloadedCount} lyrics file(s)${lyricsMissingCount ? ` (${lyricsMissingCount} missing)` : ''}`);
    if (shouldDownloadImage) parts.push(`${imagesDownloadedCount} image file(s)${imagesMissingCount ? ` (${imagesMissingCount} missing)` : ''}`);
    const summary = parts.join(', ');

    if (stopped) {
        logToPopup(`⏹️ STOPPED. Downloaded ${summary}${failedCount ? ` (${failedCount} failed)` : ''}.`);
    } else if (failedCount > 0) {
        logToPopup(`🎉 COMPLETE! Downloaded ${summary} (${failedCount} failed).`);
    } else {
        logToPopup(`🎉 COMPLETE! Downloaded ${summary}.`);
    }

    // Reset download state
    stopDownloadRequested = false;
    isDownloading = false;
    activeDownloadIds = new Set();
    persistDownloadState({ finishedAt: Date.now() });
    broadcastDownloadState();

    api.runtime.sendMessage({ action: "download_complete", stopped: stopped });
}

function logToPopup(text) {
    try { api.runtime.sendMessage({ action: "log", text: text }); } catch (e) {}
}

