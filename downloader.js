// downloader.js — popup.js adapted as a content script for the Library tab panel
// Runs after content.js has injected the panel DOM.
// Uses IndexedDB for persistent storage across browser sessions

(function initDownloader() {
    const api = (typeof browser !== 'undefined') ? browser : chrome;

    let allSongs = [];
    let filteredSongs = [];
    let selectedSongIds = new Set();
    let currentPlayingSongId = null;
    let cachedSongIds = new Set();
    let currentBlobUrl = null;
    let isCachingAll = false;
    let stopCachingRequested = false;
    const SONG_RENDER_BATCH_SIZE = 40;
    let sortedFilteredSongs = [];
    let renderedSongCount = 0;
    let songListSentinel = null;
    let songListObserver = null;
    const songItemCache = new Map(); // songId → DOM element; reused on re-renders to prevent image reload
    const SYNC_META_KEY = 'sunoSyncMeta';
    let currentFetchMode = 'idle';
    let syncMeta = createDefaultSyncMeta();

    function createDefaultSyncMeta() {
        return {
            lastSyncAt: null,
            lastFullSyncAt: null,
            lastIncrementalSyncAt: null,
            lastSyncMode: null,
            lastAddedCount: 0,
            totalSongsAtLastSync: 0,
            lastError: null,
            syncStatus: 'idle'
        };
    }

    // ========================================================================
    // Audio Player
    // ========================================================================
    const miniPlayer = document.getElementById('bettersuno-mini-player');
    const audioElement = document.getElementById('bettersuno-audio-element');
    const playPauseBtn = document.getElementById('player-play-pause');
    const playerTitle = document.getElementById('player-song-title');
    const progressBar = document.getElementById('player-progress-bar');
    const playerTime = document.getElementById('player-time');

    async function togglePlay(song) {
        if (!song || !song.audio_url) return;

        if (currentPlayingSongId === song.id) {
            if (audioElement.paused) {
                audioElement.play();
                playPauseBtn.textContent = '▪';
            } else {
                audioElement.pause();
                playPauseBtn.textContent = '▶';
            }
        } else {
            // Remember the previous blob URL so we can revoke it after switching sources
            const prevBlobUrl = currentBlobUrl;
            currentBlobUrl = null;

            currentPlayingSongId = song.id;

            // Use cached audio if available, otherwise stream online
            const cachedBlob = await getAudioBlobFromIDB(song.id);
            if (cachedBlob) {
                currentBlobUrl = URL.createObjectURL(cachedBlob);
                audioElement.src = currentBlobUrl;
            } else {
                audioElement.src = song.audio_url;
            }

            // Revoke the previous blob URL now that the audio element has moved to the new source
            if (prevBlobUrl) {
                URL.revokeObjectURL(prevBlobUrl);
            }

            audioElement.play();
            miniPlayer.style.display = 'block';
            playerTitle.textContent = song.title || 'Untitled';
            playPauseBtn.textContent = '▪';

            refreshVisibleSongPlaybackState();
        }
    }

    if (playPauseBtn) {
        playPauseBtn.addEventListener('click', () => {
            if (audioElement.paused) {
                audioElement.play();
                playPauseBtn.textContent = '▪';
            } else {
                audioElement.pause();
                playPauseBtn.textContent = '▶';
            }
            refreshVisibleSongPlaybackState();
        });
    }

    if (audioElement) {
        audioElement.addEventListener('timeupdate', () => {
            const percent = (audioElement.currentTime / audioElement.duration) * 100;
            progressBar.style.width = `${percent}%`;
            
            const mins = Math.floor(audioElement.currentTime / 60);
            const secs = Math.floor(audioElement.currentTime % 60).toString().padStart(2, '0');
            playerTime.textContent = `${mins}:${secs}`;
        });

        audioElement.addEventListener('play', () => {
            refreshVisibleSongPlaybackState();
        });

        audioElement.addEventListener('pause', () => {
            refreshVisibleSongPlaybackState();
        });

        audioElement.addEventListener('ended', () => {
            playPauseBtn.textContent = '▶';
            refreshVisibleSongPlaybackState();
        });
    }

    // ========================================================================
    // IndexedDB Helper Functions
    // ========================================================================
    
    const IDB_NAME = 'BetterSunoicationsDB';
    const IDB_VERSION = 3;
    let dbInstance = null;
    const textEncoder = new TextEncoder();

    async function getDB() {
        if (dbInstance) return dbInstance;
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(IDB_NAME, IDB_VERSION);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                dbInstance = request.result;
                resolve(dbInstance);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('songsList')) {
                    db.createObjectStore('songsList', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('userPreferences')) {
                    db.createObjectStore('userPreferences', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('audioCache')) {
                    db.createObjectStore('audioCache', { keyPath: 'songId' });
                }
                if (!db.objectStoreNames.contains('imageCache')) {
                    db.createObjectStore('imageCache', { keyPath: 'songId' });
                }
            };
        });
    }

    async function saveSongsToIDB(songs) {
        try {
            const db = await getDB();
            const tx = db.transaction('songsList', 'readwrite');
            const store = tx.objectStore('songsList');
            store.clear();
            
            songs.forEach(song => {
                store.add({ ...song, timestamp: Date.now() });
            });
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save songs:', e);
        }
    }

    async function loadSongsFromIDB() {
        try {
            const db = await getDB();
            const tx = db.transaction('songsList', 'readonly');
            const store = tx.objectStore('songsList');
            const request = store.getAll();
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to load songs:', e);
            return [];
        }
    }

    async function savePreferenceToIDB(key, value) {
        try {
            const db = await getDB();
            const tx = db.transaction('userPreferences', 'readwrite');
            const store = tx.objectStore('userPreferences');
            store.put({
                key,
                value,
                timestamp: Date.now()
            });
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save preference:', e);
        }
    }

    async function loadPreferenceFromIDB(key) {
        try {
            const db = await getDB();
            const tx = db.transaction('userPreferences', 'readonly');
            const store = tx.objectStore('userPreferences');
            const request = store.get(key);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result?.value || null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to load preference:', e);
            return null;
        }
    }

    async function deletePreferenceFromIDB(key) {
        try {
            const db = await getDB();
            const tx = db.transaction('userPreferences', 'readwrite');
            const store = tx.objectStore('userPreferences');
            store.delete(key);
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to delete preference:', e);
        }
    }

    async function saveAudioBlobToIDB(songId, blob) {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readwrite');
            const store = tx.objectStore('audioCache');
            store.put({ songId, blob, timestamp: Date.now() });
            
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save audio blob:', e);
        }
    }

    async function getAudioBlobFromIDB(songId) {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readonly');
            const store = tx.objectStore('audioCache');
            const request = store.get(songId);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result?.blob || null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to get audio blob:', e);
            return null;
        }
    }

    async function getAllCachedSongIdsFromIDB() {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readonly');
            const store = tx.objectStore('audioCache');
            const request = store.getAllKeys();
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to get cached song IDs:', e);
            return [];
        }
    }

    async function deleteAudioBlobFromIDB(songId) {
        try {
            const db = await getDB();
            const tx = db.transaction('audioCache', 'readwrite');
            const store = tx.objectStore('audioCache');
            store.delete(songId);

            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to delete audio blob:', e);
            throw e;
        }
    }

    async function saveImageBlobToIDB(songId, blob) {
        try {
            const db = await getDB();
            const tx = db.transaction('imageCache', 'readwrite');
            const store = tx.objectStore('imageCache');
            store.put({ songId, blob, timestamp: Date.now() });
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[IDB] Failed to save image blob:', e);
        }
    }

    async function getImageBlobFromIDB(songId) {
        try {
            const db = await getDB();
            const tx = db.transaction('imageCache', 'readonly');
            const store = tx.objectStore('imageCache');
            const request = store.get(songId);
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result?.blob || null);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            return null;
        }
    }

    async function deleteImageBlobFromIDB(songId) {
        try {
            const db = await getDB();
            const tx = db.transaction('imageCache', 'readwrite');
            const store = tx.objectStore('imageCache');
            store.delete(songId);
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            // ignore
        }
    }

    async function getAllRecordsFromStore(storeName) {
        try {
            const db = await getDB();
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();

            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error(`[IDB] Failed to read store ${storeName}:`, e);
            return [];
        }
    }

    function estimateValueSize(value, visited = new WeakSet()) {
        if (value == null) {
            return 0;
        }

        if (typeof Blob !== 'undefined' && value instanceof Blob) {
            return value.size;
        }

        if (typeof value === 'string') {
            return textEncoder.encode(value).length;
        }

        if (typeof value === 'number') {
            return 8;
        }

        if (typeof value === 'boolean') {
            return 4;
        }

        if (value instanceof Date) {
            return 8;
        }

        if (value instanceof ArrayBuffer) {
            return value.byteLength;
        }

        if (ArrayBuffer.isView(value)) {
            return value.byteLength;
        }

        if (Array.isArray(value)) {
            return value.reduce((total, item) => total + estimateValueSize(item, visited), 0);
        }

        if (typeof value === 'object') {
            if (visited.has(value)) {
                return 0;
            }
            visited.add(value);

            let total = 0;
            for (const [key, nestedValue] of Object.entries(value)) {
                total += textEncoder.encode(key).length;
                total += estimateValueSize(nestedValue, visited);
            }
            return total;
        }

        return 0;
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            return '0 B';
        }

        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        const rounded = value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1);
        return `${rounded} ${units[unitIndex]}`;
    }

    async function estimateDbUsageBytes() {
        const [songs, preferences, audioCache, imageCache] = await Promise.all([
            getAllRecordsFromStore('songsList'),
            getAllRecordsFromStore('userPreferences'),
            getAllRecordsFromStore('audioCache'),
            getAllRecordsFromStore('imageCache')
        ]);

        return estimateValueSize(songs) + estimateValueSize(preferences) + estimateValueSize(audioCache) + estimateValueSize(imageCache);
    }

    // ========================================================================
    // DOM Elements
    // ========================================================================

    const statusDiv = document.getElementById("status");
    const folderInput = document.getElementById("folder");
    function getSelectedFormat() {
        const el = document.querySelector('input[name="format"]:checked');
        return el ? el.value : 'mp3';
    }
    const formatRadios = document.querySelectorAll('input[name="format"]');
    
    // Default settings (no longer in UI)
    const maxPages = 0; // 0 = unlimited
    const isPublicOnly = false; // fetch all songs
    const downloadBtn = document.getElementById("downloadBtn");
    const stopDownloadBtn = document.getElementById("stopDownloadBtn");
    const stopFetchBtn = document.getElementById("bettersuno-stop-fetch-btn");
    const cacheAllBtn = document.getElementById("cacheAllBtn");
    const stopCacheBtn = document.getElementById("stopCacheBtn");
    const deleteCachedBtn = document.getElementById("deleteCachedBtn");
    const dbUsageValue = document.getElementById("bettersuno-db-usage");
    const filterInput = document.getElementById("filterInput");
    const filterLiked = document.getElementById("filterLiked");
    const filterStems = document.getElementById("filterStems");
    const filterPublic = document.getElementById("filterPublic");
    const filterOffline = document.getElementById("filterOffline");
    const selectAllButton = document.getElementById("selectAll");
    const syncNewBtn = document.getElementById("syncNewBtn");
    const downloadMusicCheckbox = document.getElementById("downloadMusic");
    const downloadLyricsCheckbox = document.getElementById("downloadLyrics");
    const downloadImageCheckbox = document.getElementById("downloadImage");
    const songList = document.getElementById("songList");
    const songCount = document.getElementById("songCount");
    const songListContainer = document.getElementById("songListContainer");
    const versionFooter = document.getElementById("versionFooter");

    // hide stop-fetch button initially
    if (stopFetchBtn) {
        stopFetchBtn.style.display = 'none';
    }

    function setFetchUiState(active) {
        if (stopFetchBtn) {
            stopFetchBtn.style.display = active ? 'inline-block' : 'none';
        }
        if (syncNewBtn) {
            syncNewBtn.disabled = active;
            syncNewBtn.textContent = active && currentFetchMode === 'incremental' ? 'Syncing...' : 'Sync New';
        }
    }

    function formatRelativeTime(value) {
        if (!value) {
            return 'never';
        }

        const ts = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(ts)) {
            return 'unknown';
        }

        const diffMs = Date.now() - ts;
        const diffMinutes = Math.round(diffMs / 60000);
        if (diffMinutes <= 1) return 'just now';
        if (diffMinutes < 60) return `${diffMinutes}m ago`;

        const diffHours = Math.round(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours}h ago`;

        const diffDays = Math.round(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;

        try {
            return new Date(ts).toLocaleDateString();
        } catch {
            return 'unknown';
        }
    }

    async function refreshDbUsageDisplay() {
        if (!dbUsageValue) {
            return;
        }

        dbUsageValue.textContent = 'Calculating...';
        try {
            const bytes = await estimateDbUsageBytes();
            dbUsageValue.textContent = `${formatBytes(bytes)} used locally`;
            dbUsageValue.title = `Approximate IndexedDB usage for BetterSuno: ${bytes.toLocaleString()} bytes`;
        } catch (e) {
            dbUsageValue.textContent = 'Unavailable';
            dbUsageValue.title = e?.message || 'Failed to measure IndexedDB usage';
        }
    }

    async function saveSyncMeta(patch = {}) {
        syncMeta = {
            ...syncMeta,
            ...patch
        };
        try {
            await savePreferenceToIDB(SYNC_META_KEY, syncMeta);
            void refreshDbUsageDisplay();
        } catch (e) {
            console.error('[Downloader] Failed to save sync metadata:', e);
        }
    }

    function setCachingUiState(active) {
        if (cacheAllBtn) {
            cacheAllBtn.disabled = active;
            cacheAllBtn.textContent = active ? 'Downloading to DB...' : '💾 Download to DB';
        }
        if (stopCacheBtn) {
            stopCacheBtn.disabled = false;
            stopCacheBtn.classList.toggle('hidden', !active);
        }
    }



    try {
        const version = api.runtime.getManifest()?.version;
        if (versionFooter && version) {
            versionFooter.textContent = `v${version}`;
        }
    } catch (e) {
        if (versionFooter) {
            versionFooter.textContent = "v?";
        }
    }

    // Load from storage on startup
    loadFromStorage();

    // Save format preference when changed
    formatRadios.forEach(r => r.addEventListener("change", async () => {
        await savePreferenceToIDB('sunoFormat', getSelectedFormat());
    }));

    // Save folder preference when changed
    folderInput.addEventListener("change", () => {
        saveToStorage();
    });

    // Check if fetching is in progress
    checkFetchState();

    // Check if downloading is in progress (important when popup is reopened)
    checkDownloadState();

    function setDownloadUiState(isRunning) {
        if (isRunning) {
            downloadBtn.disabled = true;
            downloadBtn.textContent = "Downloading...";
            stopDownloadBtn.classList.remove("hidden");
        } else {
            downloadBtn.disabled = false;
            downloadBtn.textContent = "Download";
            stopDownloadBtn.classList.add("hidden");
        }
    }

    async function checkFetchState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_fetch_state" });
            if (response && response.isFetching) {
                currentFetchMode = syncMeta.lastSyncMode || 'incremental';
                statusDiv.innerText = "Fetching in progress...";
                setFetchUiState(true);
            }
        } catch (e) {
            // Ignore errors (e.g., no response)
        }
    }

    function startAutoFetch() {
        startFullRefresh({ confirmUser: true });
    }

    function startFullRefresh(options = {}) {
        const { confirmUser = true } = options;
        if (currentFetchMode !== 'idle') {
            return;
        }

        if (confirmUser) {
            const proceed = confirm("BetterSuno will reload your full Suno library. This may take a while. Continue?");
            if (!proceed) {
                statusDiv.innerText = "Refresh cancelled.";
                return;
            }
        }

        currentFetchMode = 'full';
        setFetchUiState(true);
        void saveSyncMeta({
            syncStatus: 'running',
            lastSyncMode: 'full',
            lastError: null
        });

        statusDiv.innerText = "Refreshing full library...";
        console.log('[Downloader] Starting full refresh...');
        try {
            api.runtime.sendMessage({
                action: "fetch_songs",
                isPublicOnly: isPublicOnly,
                maxPages: maxPages
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[Downloader] Message error:', chrome.runtime.lastError);
                    statusDiv.innerText = "Fetching songs in background...";
                } else if (response && response.error) {
                    console.error('[Downloader] Fetch songs error:', response.error);
                    statusDiv.innerText = response.error;
                } else {
                    console.log('[Downloader] Fetch request sent successfully');
                }
            });
        } catch (e) {
            console.debug('[Downloader] Could not send fetch request:', e.message);
            statusDiv.innerText = "Fetching songs in background...";
            currentFetchMode = 'idle';
            setFetchUiState(false);
        }
    }

    function startIncrementalSync(options = {}) {
        const { automatic = false } = options;

        if (currentFetchMode !== 'idle') {
            return;
        }

        if (!allSongs.length) {
            startFullRefresh({ confirmUser: !automatic });
            return;
        }

        currentFetchMode = 'incremental';
        setFetchUiState(true);
        void saveSyncMeta({
            syncStatus: 'running',
            lastSyncMode: 'incremental',
            lastError: null
        });

        statusDiv.innerText = automatic ? "Checking for new songs..." : "Syncing new songs...";

        try {
            api.runtime.sendMessage({
                action: "fetch_songs",
                isPublicOnly: false,
                maxPages: 0,
                checkNewOnly: true,
                knownIds: allSongs.map(song => song.id)
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[Downloader] Check for new songs error:', chrome.runtime.lastError);
                } else if (response && response.error) {
                    console.log('[Downloader] Check for new songs error:', response.error);
                } else {
                    console.log('[Downloader] Check for new songs request sent');
                }
            });
        } catch (e) {
            console.debug('[Downloader] Could not check for new songs:', e.message);
            currentFetchMode = 'idle';
            setFetchUiState(false);
        }
    }

    async function checkDownloadState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_download_state" });
            if (response && response.isDownloading) {
                setDownloadUiState(true);
                statusDiv.innerText = "Download in progress...";
            }
        } catch (e) {
            // Ignore errors
        }
    }

    async function loadFromStorage() {
        try {
            console.log('[Downloader] Loading songs from IndexedDB...');
            // Load songs and cached audio IDs from IndexedDB in parallel
            const [savedSongs, savedFormat, savedSongsMeta, cachedIds, savedSyncMeta] = await Promise.all([
                loadSongsFromIDB(),
                loadPreferenceFromIDB('sunoFormat'),
                loadPreferenceFromIDB('sunoSongsList'),
                getAllCachedSongIdsFromIDB(),
                loadPreferenceFromIDB(SYNC_META_KEY)
            ]);

            cachedSongIds = new Set(cachedIds);
            syncMeta = {
                ...createDefaultSyncMeta(),
                ...(savedSyncMeta || {})
            };
            console.log('[Downloader] Loaded', savedSongs?.length || 0, 'songs,', cachedSongIds.size, 'cached audio blobs from IndexedDB');
            void refreshDbUsageDisplay();

            // Load saved format preference first
            if (savedFormat) {
                const radio = document.querySelector(`input[name="format"][value="${savedFormat}"]`);
                if (radio) radio.checked = true;
            }
            
            if (savedSongs && savedSongs.length > 0) {
                allSongs = savedSongs;
                filteredSongs = [...allSongs];

                // Restore settings from metadata
                if (savedSongsMeta) {
                    if (savedSongsMeta.folder) folderInput.value = savedSongsMeta.folder;
                    if (savedSongsMeta.format) {
                        const radio = document.querySelector(`input[name="format"][value="${savedSongsMeta.format}"]`);
                        if (radio) radio.checked = true;
                    }
                }

                // Go directly to song list
                songListContainer.style.display = "block";
                filterInput.value = "";
                await loadFilterPreferences();
                applyFilter();
                statusDiv.innerText = `${allSongs.length} cached songs. Checking for new...`;

                console.log('[Downloader] Showing cached songs, checking for new songs...');
                // Check for new songs
                setTimeout(() => checkForNewSongs(), 100);
                return;
            }
        } catch (e) {
            console.error('[Downloader] Error loading from storage:', e);
        }

        void refreshDbUsageDisplay();

        console.log('[Downloader] No cached songs found, will prompt before auto-fetch...');
        // No cached songs — ask user before starting a full fetch
        songListContainer.style.display = "block";
        startAutoFetch();
    }

    function checkForNewSongs() {
        startIncrementalSync({ automatic: true });
    }

    async function saveToStorage() {
        try {
            // Save songs to IndexedDB
            await saveSongsToIDB(allSongs);
            
            // Save metadata
            const metadata = {
                folder: folderInput.value,
                format: getSelectedFormat(),
                timestamp: Date.now()
            };
            await savePreferenceToIDB('sunoSongsList', metadata);
            await savePreferenceToIDB('sunoFormat', getSelectedFormat());
            void refreshDbUsageDisplay();
        } catch (e) {
            console.error('Failed to save to storage:', e);
        }
    }

    async function saveFilterPreferences() {
        try {
            await savePreferenceToIDB('sunoFilterLiked', filterLiked.checked);
            await savePreferenceToIDB('sunoFilterStems', filterStems.checked);
            await savePreferenceToIDB('sunoFilterPublic', filterPublic.checked);
            await savePreferenceToIDB('sunoFilterOffline', !!filterOffline?.checked);
        } catch (e) {
            console.error('Failed to save filter preferences:', e);
        }
    }

    async function loadFilterPreferences() {
        try {
            const liked = await loadPreferenceFromIDB('sunoFilterLiked');
            const stems = await loadPreferenceFromIDB('sunoFilterStems');
            const pub = await loadPreferenceFromIDB('sunoFilterPublic');
            const offline = await loadPreferenceFromIDB('sunoFilterOffline');
            
            if (liked !== null) filterLiked.checked = liked;
            if (stems !== null) filterStems.checked = stems;
            filterPublic.checked = (pub !== null) ? pub : true;
            if (filterOffline) {
                filterOffline.checked = offline === true;
            }
        } catch (e) {
            console.error('Failed to load filter preferences:', e);
            filterPublic.checked = true;
            if (filterOffline) {
                filterOffline.checked = false;
            }
        }
    }

    function mergeSongs(newSongs) {
        const existingIds = new Set(allSongs.map(s => s.id));
        const addedSongs = newSongs.filter(s => !existingIds.has(s.id));

        if (addedSongs.length > 0) {
            // Add new songs at the beginning
            allSongs = [...addedSongs, ...allSongs];
            filteredSongs = [...allSongs];
            applyFilter();
            saveToStorage();
        }

        return addedSongs.length;
    }

    async function clearStorage() {
        try {
            await deletePreferenceFromIDB('sunoSongsList');
        } catch (e) {}
    }

    async function cacheAllSongs() {
        if (allSongs.length === 0) {
            statusDiv.innerText = "No songs to cache. Fetch your song list first.";
            return;
        }

        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const selectedSongs = allSongs.filter(s => selectedIds.includes(s.id));
        const songsToCache = selectedSongs.filter(s => s.audio_url && !cachedSongIds.has(s.id));
        if (songsToCache.length === 0) {
            statusDiv.innerText = `All ${selectedSongs.length} selected song(s) are already in the browser database.`;
            return;
        }

        stopCachingRequested = false;
        isCachingAll = true;
        setCachingUiState(true);

        let cached = 0;
        let failed = 0;
        const total = songsToCache.length;

        for (const song of songsToCache) {
            if (stopCachingRequested) {
                statusDiv.innerText = `⏹️ Download to DB stopped. ${cached} song(s) saved.`;
                break;
            }

            statusDiv.innerText = `💾 Downloading to DB ${cached + failed + 1}/${total}: ${song.title || 'Untitled'}...`;

            try {
                const response = await fetch(song.audio_url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                await saveAudioBlobToIDB(song.id, blob);

                // Also cache a small thumbnail (64px wide via CDN query param)
                const rawImageUrl = song.image_url || song.thumbnail_url || song.cover_image_url || song.artwork_url || null;
                if (rawImageUrl) {
                    try {
                        const thumbUrl = rawImageUrl.split('?')[0] + '?width=64';
                        const imgResponse = await fetch(thumbUrl);
                        if (imgResponse.ok) {
                            const imgBlob = await imgResponse.blob();
                            await saveImageBlobToIDB(song.id, imgBlob);
                        }
                    } catch (imgErr) {
                        // thumbnail failure is non-fatal
                    }
                }

                cachedSongIds.add(song.id);
                songItemCache.delete(song.id); // force re-creation so cached thumbnail is shown
                cached++;
                void refreshDbUsageDisplay();
            } catch (e) {
                failed++;
                console.error(`[Downloader] Failed to cache "${song.title}":`, e);
            }
        }

        isCachingAll = false;
        setCachingUiState(false);

        if (!stopCachingRequested) {
            const totalCached = cachedSongIds.size;
            statusDiv.innerText = `✅ Download to DB complete! ${cached} new, ${totalCached} total in browser database. ${failed > 0 ? `${failed} failed.` : ''}`.trim();
        }

        renderSongList({
            preserveScroll: true,
            minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
        });
        void refreshDbUsageDisplay();
    }

    async function deleteSelectedCachedSongs() {
        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const cachedSelectedIds = selectedIds.filter(id => cachedSongIds.has(id));
        if (cachedSelectedIds.length === 0) {
            statusDiv.innerText = "None of the selected songs are stored in the browser database.";
            return;
        }

        const proceed = confirm(`Delete ${cachedSelectedIds.length} selected song(s) from the browser database?`);
        if (!proceed) {
            statusDiv.innerText = "Database delete cancelled.";
            return;
        }

        if (deleteCachedBtn) {
            deleteCachedBtn.disabled = true;
        }

        let deleted = 0;
        let failed = 0;

        try {
            for (const songId of cachedSelectedIds) {
                try {
                    await deleteAudioBlobFromIDB(songId);
                    await deleteImageBlobFromIDB(songId);
                    cachedSongIds.delete(songId);
                    songItemCache.delete(songId); // force re-creation without cached state
                    deleted++;
                    void refreshDbUsageDisplay();
                } catch (e) {
                    failed++;
                }
            }

            const message = `🗑 Removed ${deleted} song(s) from the browser database.${failed > 0 ? ` ${failed} failed.` : ''}`;
            statusDiv.innerText = message;
            renderSongList({
                preserveScroll: true,
                minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
            });
        } finally {
            if (deleteCachedBtn) {
                deleteCachedBtn.disabled = false;
            }
        }
    }

    // Filter input
    filterInput.addEventListener("input", () => {
        applyFilter();
    });

    // Filter checkboxes
    filterLiked.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    filterStems.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    filterPublic.addEventListener("change", () => {
        applyFilter();
        saveFilterPreferences();
    });

    if (filterOffline) {
        filterOffline.addEventListener("change", () => {
            applyFilter();
            saveFilterPreferences();
        });
    }

    if (syncNewBtn) {
        syncNewBtn.addEventListener("click", () => {
            startIncrementalSync({ automatic: false });
        });
    }

    document.addEventListener('bettersuno:refresh-library', () => {
        startFullRefresh({ confirmUser: true });
    });

    document.addEventListener('bettersuno:settings-opened', () => {
        void refreshDbUsageDisplay();
    });

    document.addEventListener('bettersuno:delete-library', async () => {
        try {
            await clearStorage();
            // Also wipe the audio and image caches
            try {
                const db = await getDB();
                await new Promise((res, rej) => {
                    const tx = db.transaction(['audioCache', 'imageCache'], 'readwrite');
                    tx.objectStore('audioCache').clear();
                    tx.objectStore('imageCache').clear();
                    tx.oncomplete = res;
                    tx.onerror = () => rej(tx.error);
                });
            } catch (e) { /* non-fatal */ }
            allSongs = [];
            selectedSongIds.clear();
            cachedSongIds.clear();
            songItemCache.clear();
            renderSongList({ preserveScroll: false });
            statusDiv.innerText = "✅ Library deleted successfully.";
            void refreshDbUsageDisplay();
        } catch (e) {
            console.error('[Downloader] Failed to delete library:', e);
            statusDiv.innerText = "❌ Failed to delete library.";
        }
    });

    // Select/Clear all toggle button
    selectAllButton.addEventListener("click", () => {
        const shouldSelectAll = selectAllButton.getAttribute('aria-pressed') !== 'true';
        filteredSongs.forEach(song => {
            if (shouldSelectAll) {
                selectedSongIds.add(song.id);
            } else {
                selectedSongIds.delete(song.id);
            }
        });
        refreshVisibleSongSelectionState();
        updateSelectedCount();
    });

    // Download selected songs
    downloadBtn.addEventListener("click", () => {
        const selectedIds = getSelectedSongIds();
        if (selectedIds.length === 0) {
            statusDiv.innerText = "No songs selected!";
            return;
        }

        const downloadOptions = getDownloadOptions();
        if (!downloadOptions.music && !downloadOptions.lyrics && !downloadOptions.image) {
            statusDiv.innerText = "Please select at least one download type: music, lyrics, or image.";
            return;
        }

        const folder = folderInput.value;
        const format = getSelectedFormat();
        const songsToDownload = allSongs.filter(s => selectedIds.includes(s.id));

        setDownloadUiState(true);

        try {
            api.runtime.sendMessage({
                action: "download_selected",
                folderName: folder,
                format: format,
                songs: songsToDownload,
                downloadOptions: downloadOptions
            });
        } catch (e) {
            console.debug('[Downloader] Could not send download request:', e.message);
        }

        const selectedTypes = [];
        if (downloadOptions.music) selectedTypes.push(format.toUpperCase());
        if (downloadOptions.lyrics) selectedTypes.push("lyrics");
        if (downloadOptions.image) selectedTypes.push("images");
        statusDiv.innerText = `Downloading ${songsToDownload.length} song(s): ${selectedTypes.join(", ")}...`;
    });

    // Stop downloading
    stopDownloadBtn.addEventListener("click", () => {
        try {
            api.runtime.sendMessage({ action: "stop_download" });
        } catch (e) {
            console.debug('[Downloader] Could not send stop download request:', e.message);
        }
        statusDiv.innerText = "Stopping download...\n" + statusDiv.innerText;
        // Keep UI in running state until background confirms stop/complete
    });

    // Cache all songs to browser database
    if (cacheAllBtn) {
        cacheAllBtn.addEventListener("click", () => {
            cacheAllSongs();
        });
    }

    if (deleteCachedBtn) {
        deleteCachedBtn.addEventListener("click", () => {
            deleteSelectedCachedSongs();
        });
    }

    // Stop caching
    if (stopCacheBtn) {
        stopCacheBtn.addEventListener("click", () => {
            stopCachingRequested = true;
            stopCacheBtn.disabled = true;
        });
    }

    // Listen for messages from background
    api.runtime.onMessage.addListener((message) => {
        if (message.action === "log") {
            statusDiv.innerText = message.text + "\n" + statusDiv.innerText;
        }

        if (message.action === "fetch_started") {
            // background informs us fetching has started (manual or auto)
            setFetchUiState(true);
            statusDiv.innerText = currentFetchMode === 'incremental' ? "Syncing new songs..." : "Fetching songs...";
        }
        if (message.action === "songs_page_update") {
            // start or continue fetching, ensure UI shows stop button
            setFetchUiState(true);

            // Incremental page update
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;

            if (wasCheckingNew) {
                // Merge with existing songs
                mergeSongs(newSongs);
                statusDiv.innerText = `Page ${message.pageNum}: ${message.totalSongs} new songs found...`;
            } else {
                // Fresh fetch - replace all
                allSongs = newSongs;
                filteredSongs = [...allSongs];

                // Show song list immediately after first page
                if (message.pageNum === 1) {
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    loadFilterPreferences().then(() => {
                        applyFilter();
                    });
                } else {
                    // Just update the list
                    applyFilter({
                        preserveScroll: true,
                        minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
                    });
                }
                saveToStorage();
                statusDiv.innerText = `Page ${message.pageNum}: ${allSongs.length} songs...`;
            }
        }

        if (message.action === "download_state") {
            setDownloadUiState(!!message.isDownloading);
        }

        if (message.action === "download_stopped") {
            setDownloadUiState(false);
        }

        if (message.action === "songs_fetched") {
            setFetchUiState(false);
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;
            const completedAt = Date.now();

            if (wasCheckingNew) {
                // Merge with existing songs
                const addedCount = mergeSongs(newSongs);
                void saveSyncMeta({
                    lastSyncAt: completedAt,
                    lastIncrementalSyncAt: completedAt,
                    lastSyncMode: 'incremental',
                    lastAddedCount: addedCount,
                    totalSongsAtLastSync: allSongs.length,
                    lastError: null,
                    syncStatus: 'complete'
                });
                if (addedCount > 0) {
                    statusDiv.innerText = `Found ${addedCount} new song(s). Total: ${allSongs.length}`;
                } else {
                    statusDiv.innerText = `${allSongs.length} songs (no new songs found).`;
                }
            } else {
                // Fresh fetch complete
                allSongs = newSongs;
                filteredSongs = [...allSongs];

                // Only show song list if not already visible (page updates already showed it)
                if (songListContainer.style.display !== "block") {
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    loadFilterPreferences().then(() => {
                        applyFilter();
                    });
                } else {
                    // Just update the final list
                    applyFilter({
                        preserveScroll: true,
                        minimumRenderCount: Math.max(renderedSongCount, SONG_RENDER_BATCH_SIZE)
                    });
                }
                saveToStorage();
                void saveSyncMeta({
                    lastSyncAt: completedAt,
                    lastFullSyncAt: completedAt,
                    lastSyncMode: 'full',
                    lastAddedCount: allSongs.length,
                    totalSongsAtLastSync: allSongs.length,
                    lastError: null,
                    syncStatus: 'complete'
                });
                statusDiv.innerText = `✅ Complete! Found ${allSongs.length} songs total.`;
            }
            currentFetchMode = 'idle';
        }
        if (message.action === "fetch_stopped") {
            setFetchUiState(false);
            void saveSyncMeta({
                syncStatus: 'stopped',
                lastSyncMode: currentFetchMode === 'idle' ? syncMeta.lastSyncMode : currentFetchMode
            });
            statusDiv.innerText = "⏹️ Fetch stopped by user – song list may be incomplete.";
            currentFetchMode = 'idle';
        }
        if (message.action === "fetch_error") {
            setFetchUiState(false);
            void saveSyncMeta({
                syncStatus: 'error',
                lastError: message.error || 'Unknown error',
                lastSyncMode: currentFetchMode === 'idle' ? syncMeta.lastSyncMode : currentFetchMode
            });
            statusDiv.innerText = message.error;
            currentFetchMode = 'idle';
        }

        if (message.action === "download_complete") {
            setDownloadUiState(false);
            if (message.stopped) {
                statusDiv.innerText = "⏹️ Download stopped by user.";
            } else {
                statusDiv.innerText = "✅ Download complete!";
            }
        }
    });

    function ensureSongListObserver() {
        if (songListObserver || !songList) {
            return;
        }

        songListObserver = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) {
                renderSongListChunk();
            }
        }, {
            root: songList,
            rootMargin: '0px 0px 160px 0px'
        });
    }

    function updateSongListSentinelState() {
        if (!songListSentinel) {
            return;
        }

        const remaining = Math.max(sortedFilteredSongs.length - renderedSongCount, 0);
        songListSentinel.classList.toggle('is-complete', remaining === 0);
        songListSentinel.textContent = remaining > 0
            ? `Scroll to load ${Math.min(remaining, SONG_RENDER_BATCH_SIZE)} more songs`
            : (sortedFilteredSongs.length > 0 ? 'All songs loaded' : '');
    }

    function ensureSongListSentinel() {
        ensureSongListObserver();

        if (!songListSentinel) {
            songListSentinel = document.createElement('div');
            songListSentinel.className = 'bettersuno-list-sentinel';
        }

        if (!songListSentinel.isConnected) {
            songList.appendChild(songListSentinel);
        }

        if (songListObserver) {
            songListObserver.disconnect();
            songListObserver.observe(songListSentinel);
        }

        updateSongListSentinelState();
    }

    function createSongListItem(song) {
        const item = document.createElement("div");
        item.className = "song-item";
        item.dataset.songId = song.id;
        if (currentPlayingSongId === song.id) {
            item.classList.add('playing');
        }

        const thumbnailUrl = song?.image_url || song?.thumbnail_url || song?.cover_image_url || song?.artwork_url || null;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.id = song.id;
        checkbox.checked = selectedSongIds.has(song.id);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                selectedSongIds.add(song.id);
            } else {
                selectedSongIds.delete(song.id);
            }
            updateSelectedCount();
        });

        const thumbnail = document.createElement("div");
        thumbnail.className = "song-thumbnail";

        function attachThumbnailImage(src) {
            const thumbnailImage = document.createElement("img");
            thumbnailImage.className = "song-thumbnail-image";
            thumbnailImage.src = src;
            thumbnailImage.alt = song.title ? `${song.title} cover art` : 'Song cover art';
            thumbnailImage.loading = 'lazy';
            thumbnailImage.decoding = 'async';
            thumbnailImage.addEventListener('error', () => {
                thumbnail.classList.add('is-fallback');
                thumbnailImage.remove();
                if (!thumbnail.textContent) {
                    thumbnail.textContent = '♪';
                }
            }, { once: true });
            thumbnail.appendChild(thumbnailImage);
        }

        if (cachedSongIds.has(song.id)) {
            // Try to load from the local imageCache first; fall back to CDN URL
            getImageBlobFromIDB(song.id).then(imgBlob => {
                if (imgBlob) {
                    const objUrl = URL.createObjectURL(imgBlob);
                    attachThumbnailImage(objUrl);
                    // Revoke the object URL once the image has loaded to free memory
                    thumbnail.querySelector('img')?.addEventListener('load', () => URL.revokeObjectURL(objUrl), { once: true });
                } else if (thumbnailUrl) {
                    attachThumbnailImage(thumbnailUrl);
                } else {
                    thumbnail.classList.add('is-fallback');
                    thumbnail.textContent = '♪';
                }
            });
        } else if (thumbnailUrl) {
            attachThumbnailImage(thumbnailUrl);
        } else {
            thumbnail.classList.add('is-fallback');
            thumbnail.textContent = '♪';
        }

        const songInfo = document.createElement("div");
        songInfo.className = "song-info";
        songInfo.style.cursor = 'pointer';
        songInfo.addEventListener('click', () => {
            togglePlay(song);
        });

        const titleDiv = document.createElement("div");
        titleDiv.className = "song-title";
        titleDiv.title = song.title;
        titleDiv.textContent = song.title;

        const metaDiv = document.createElement("div");
        metaDiv.className = "song-meta";

        const visibilitySpan = document.createElement("span");
        visibilitySpan.className = song.is_public ? 'public' : 'private';
        visibilitySpan.textContent = song.is_public ? '🌐 Public' : '🔒 Private';
        metaDiv.appendChild(visibilitySpan);

        if (song.is_liked) {
            const likedSpan = document.createElement("span");
            likedSpan.textContent = ' • ❤️ Liked';
            likedSpan.style.color = '#e91e63';
            metaDiv.appendChild(likedSpan);
        }

        if (song.is_stem) {
            const stemSpan = document.createElement("span");
            stemSpan.textContent = ' • 🎹 Stem';
            stemSpan.style.color = '#9c27b0';
            metaDiv.appendChild(stemSpan);
        }

        if (song.created_at) {
            metaDiv.appendChild(document.createTextNode(' • ' + formatDate(song.created_at)));
        }

        if (cachedSongIds.has(song.id)) {
            const cachedSpan = document.createElement("span");
            cachedSpan.textContent = ' • 💾 Cached';
            cachedSpan.title = 'Audio stored in browser database';
            cachedSpan.style.color = '#4caf50';
            metaDiv.appendChild(cachedSpan);
        }

        songInfo.appendChild(titleDiv);
        songInfo.appendChild(metaDiv);

        const actionsDiv = document.createElement("div");
        actionsDiv.className = "song-actions";

        const playBtn = document.createElement("button");
        playBtn.className = "song-action-btn play-btn";
        playBtn.title = "Play Song";
        playBtn.textContent = (currentPlayingSongId === song.id && !audioElement.paused) ? '⏸' : '▶';
        playBtn.onclick = (e) => {
            e.stopPropagation();
            togglePlay(song);
        };

        const gotoBtn = document.createElement("button");
        gotoBtn.className = "song-action-btn goto-btn";
        gotoBtn.title = "Go to Song";
        gotoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5c-7.633 0-12 7-12 7s4.367 7 12 7 12-7 12-7-4.367-7-12-7zm0 12a5 5 0 1 1 .001-10.001A5 5 0 0 1 12 17zm0-8a3 3 0 1 0 .001 6.001A3 3 0 0 0 12 9z"/></svg>`;
        gotoBtn.onclick = (e) => {
            e.stopPropagation();
            window.open(`https://suno.com/song/${song.id}`, '_blank');
        };

        actionsDiv.appendChild(playBtn);
        actionsDiv.appendChild(gotoBtn);

        item.appendChild(checkbox);
        item.appendChild(thumbnail);
        item.appendChild(songInfo);
        item.appendChild(actionsDiv);
        return item;
    }

    function renderSongListChunk(count = SONG_RENDER_BATCH_SIZE) {
        if (!sortedFilteredSongs.length) {
            updateSelectedCount();
            return;
        }

        ensureSongListSentinel();

        const start = renderedSongCount;
        const end = Math.min(start + count, sortedFilteredSongs.length);
        if (start >= end) {
            updateSongListSentinelState();
            return;
        }

        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            const song = sortedFilteredSongs[index];
            let item = songItemCache.get(song.id);
            if (!item) {
                item = createSongListItem(song);
                songItemCache.set(song.id, item);
            }
            fragment.appendChild(item);
        }

        songList.insertBefore(fragment, songListSentinel);
        renderedSongCount = end;
        updateSongListSentinelState();
        updateSelectedCount();
    }

    function refreshVisibleSongSelectionState() {
        songList.querySelectorAll('input[type="checkbox"][data-id]').forEach(checkbox => {
            checkbox.checked = selectedSongIds.has(checkbox.dataset.id);
        });
    }

    function refreshVisibleSongPlaybackState() {
        const isPaused = !audioElement || audioElement.paused;
        songList.querySelectorAll('.song-item[data-song-id]').forEach(item => {
            const isCurrent = item.dataset.songId === currentPlayingSongId;
            item.classList.toggle('playing', isCurrent);
            const playBtn = item.querySelector('.play-btn');
            if (playBtn) {
                playBtn.textContent = (isCurrent && !isPaused) ? '⏸' : '▶';
            }
        });
    }

    function applyFilter(options = {}) {
        const { preserveScroll = false, minimumRenderCount = SONG_RENDER_BATCH_SIZE } = options;
        const filter = filterInput.value.toLowerCase();
        const showLikedOnly = filterLiked.checked;
        const showStemsOnly = filterStems.checked;
        const showPublicOnly = filterPublic.checked;
        const showOfflineOnly = !!filterOffline?.checked;

        filteredSongs = allSongs.filter(song => {
            // Text filter
            if (filter && !song.title.toLowerCase().includes(filter)) {
                return false;
            }

            // Liked filter
            if (showLikedOnly && !song.is_liked) {
                return false;
            }

            // Stems filter
            if (showStemsOnly && !song.is_stem) {
                return false;
            }

            // Public filter
            if (showPublicOnly && !song.is_public) {
                return false;
            }

            if (showOfflineOnly && !cachedSongIds.has(song.id)) {
                return false;
            }

            return true;
        });

        sortedFilteredSongs = [...filteredSongs].sort((a, b) => {
            const aTs = getSongTimestamp(a);
            const bTs = getSongTimestamp(b);
            if (bTs !== aTs) return bTs - aTs;
            return (a.title || '').localeCompare(b.title || '');
        });

        renderSongList({ preserveScroll, minimumRenderCount });
    }

    function renderSongList(options = {}) {
        const { preserveScroll = false, minimumRenderCount = SONG_RENDER_BATCH_SIZE } = options;
        const previousScrollTop = preserveScroll ? songList.scrollTop : 0;

        songList.textContent = '';
        renderedSongCount = 0;

        if (!sortedFilteredSongs.length) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'bettersuno-empty';
            if (filterOffline?.checked) {
                emptyDiv.textContent = cachedSongIds.size > 0
                    ? 'No offline songs match the current filters'
                    : 'No offline songs cached yet. Select songs and use Download to DB.';
            } else {
                emptyDiv.textContent = allSongs.length > 0 ? 'No songs match the current filters' : 'No songs loaded yet';
            }
            songList.appendChild(emptyDiv);
            updateSelectedCount();
            return;
        }

        ensureSongListSentinel();

        while (renderedSongCount < Math.min(minimumRenderCount, sortedFilteredSongs.length)) {
            renderSongListChunk();
        }

        if (preserveScroll) {
            songList.scrollTop = previousScrollTop;
        } else {
            songList.scrollTop = 0;
        }

        updateSelectedCount();
    }

    function getSelectedSongIds() {
        return Array.from(selectedSongIds).filter(id => allSongs.some(song => song.id === id));
    }

    function getDownloadOptions() {
        return {
            music: !!downloadMusicCheckbox?.checked,
            lyrics: !!downloadLyricsCheckbox?.checked,
            image: !!downloadImageCheckbox?.checked
        };
    }

    function updateSelectedCount() {
        const total = filteredSongs.length;
        const selected = filteredSongs.filter(song => selectedSongIds.has(song.id)).length;
        songCount.textContent = `${selected}/${total} selected`;

        // Update select all button state
        const allChecked = total > 0 && filteredSongs.every(song => selectedSongIds.has(song.id));
        const isPressed = allChecked && total > 0;
        selectAllButton.setAttribute('aria-pressed', String(isPressed));
        selectAllButton.textContent = isPressed ? 'Clear All' : 'Select All';
    }

    function formatDate(dateStr) {
        try {
            return new Date(dateStr).toLocaleDateString();
        } catch {
            return '';
        }
    }

    function getSongTimestamp(song) {
        const raw = song?.created_at || song?.createdAt || song?.timestamp;
        const ts = raw ? Date.parse(raw) : NaN;
        return Number.isFinite(ts) ? ts : 0;
    }
})();
