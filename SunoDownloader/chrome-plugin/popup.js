// popup.js
const api = (typeof browser !== 'undefined') ? browser : chrome;

let allSongs = [];
let filteredSongs = [];

document.addEventListener('DOMContentLoaded', () => {
    const statusDiv = document.getElementById("status");
    const folderInput = document.getElementById("folder");
    function getSelectedFormat() {
        const el = document.querySelector('input[name="format"]:checked');
        return el ? el.value : 'mp3';
    }
    const formatRadios = document.querySelectorAll('input[name="format"]');
    const publicCheckbox = document.getElementById("publicOnly");
    const maxPagesInput = document.getElementById("maxPages");
    const fetchBtn = document.getElementById("fetchBtn");
    const stopBtn = document.getElementById("stopBtn");
    const viewSongsBtn = document.getElementById("viewSongsBtn");
    const downloadBtn = document.getElementById("downloadBtn");
    const stopDownloadBtn = document.getElementById("stopDownloadBtn");
    const backBtn = document.getElementById("backBtn");
    const filterInput = document.getElementById("filterInput");
    const filterLiked = document.getElementById("filterLiked");
    const filterStems = document.getElementById("filterStems");
    const filterPublic = document.getElementById("filterPublic");
    const selectAllCheckbox = document.getElementById("selectAll");
    const downloadMusicCheckbox = document.getElementById("downloadMusic");
    const downloadLyricsCheckbox = document.getElementById("downloadLyrics");
    const downloadImageCheckbox = document.getElementById("downloadImage");
    const songList = document.getElementById("songList");
    const songCount = document.getElementById("songCount");
    const settingsPanel = document.getElementById("settingsPanel");
    const songListContainer = document.getElementById("songListContainer");
    const darkModeToggle = document.getElementById("darkModeToggle");
    const versionFooter = document.getElementById("versionFooter");

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

    // Load dark mode preference and apply it
    loadDarkModePreference();
    
    // Load from storage on startup
    loadFromStorage();
    
    // Save format preference when changed
    formatRadios.forEach(r => r.addEventListener("change", () => {
        api.storage.local.set({ sunoFormat: getSelectedFormat() });
    }));
    
    // Dark mode toggle
    darkModeToggle.addEventListener("click", () => {
        document.body.classList.toggle("dark-mode");
        const isDarkMode = document.body.classList.contains("dark-mode");
        api.storage.local.set({ sudoDarkMode: isDarkMode });
        updateDarkModeToggleIcon();
    });
    
    function updateDarkModeToggleIcon() {
        const isDarkMode = document.body.classList.contains("dark-mode");
        darkModeToggle.textContent = isDarkMode ? "☀️" : "🌙";
        darkModeToggle.title = isDarkMode ? "Toggle light mode" : "Toggle dark mode";
    }
    
    async function loadDarkModePreference() {
        try {
            const result = await api.storage.local.get('sudoDarkMode');
            let isDarkMode = result.sudoDarkMode;
            
            // If no preference saved, check system preference
            if (isDarkMode === undefined) {
                isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            }
            
            if (isDarkMode) {
                document.body.classList.add("dark-mode");
            }
            
            updateDarkModeToggleIcon();
        } catch (e) {
            console.error('Failed to load dark mode preference:', e);
        }
    }
    
    // Check if fetching is in progress
    checkFetchState();

    // Check if downloading is in progress (important when popup is reopened)
    checkDownloadState();

    function setDownloadUiState(isRunning) {
        if (isRunning) {
            downloadBtn.disabled = true;
            downloadBtn.textContent = "Downloading...";
            stopDownloadBtn.classList.remove("hidden");
            backBtn.disabled = true;
        } else {
            downloadBtn.disabled = false;
            downloadBtn.textContent = "Download Selected";
            stopDownloadBtn.classList.add("hidden");
            backBtn.disabled = false;
        }
    }
    
    async function checkFetchState() {
        try {
            const response = await api.runtime.sendMessage({ action: "get_fetch_state" });
            if (response && response.isFetching) {
                fetchBtn.disabled = true;
                fetchBtn.textContent = "Fetching...";
                stopBtn.classList.remove("hidden");
                statusDiv.innerText = "Fetching in progress...";
            }
        } catch (e) {
            // Ignore errors (e.g., no response)
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
            const result = await api.storage.local.get(['sunoSongsList', 'sunoFormat']);
            const data = result.sunoSongsList;
            
            // Load saved format preference first (outside data check so it always loads)
            if (result.sunoFormat) {
                const radio = document.querySelector(`input[name="format"][value="${result.sunoFormat}"]`);
                if (radio) radio.checked = true;
            }
            if (data) {
                allSongs = data.songs || [];
                filteredSongs = [...allSongs];
                
                // Restore settings
                if (data.folder) folderInput.value = data.folder;
                if (data.format) {
                    const radio = document.querySelector(`input[name="format"][value="${data.format}"]`);
                    if (radio) radio.checked = true;
                }
                if (data.publicOnly !== undefined) publicCheckbox.checked = data.publicOnly;
                if (data.maxPages !== undefined) maxPagesInput.value = data.maxPages;
                
                if (allSongs.length > 0) {
                    // Go directly to song list
                    settingsPanel.style.display = "none";
                    songListContainer.style.display = "block";
                    filterInput.value = "";
                    selectAllCheckbox.checked = true;
                    await loadFilterPreferences();
                    renderSongList();
                    statusDiv.innerText = `${allSongs.length} cached songs. Checking for new...`;

                    // Check for new songs
                    setTimeout(() => checkForNewSongs(), 100);
                    return;
                }
            }
        } catch (e) {
            console.error('Failed to load from storage:', e);
        }
        
        // Show settings panel by default
        settingsPanel.style.display = "block";
        songListContainer.style.display = "none";
    }

    function checkForNewSongs() {
        const isPublicOnly = publicCheckbox.checked;
        const maxPages = parseInt(maxPagesInput.value) || 0;
        const knownIds = allSongs.map(s => s.id);
        
        api.runtime.sendMessage({ 
            action: "fetch_songs", 
            isPublicOnly: isPublicOnly,
            maxPages: maxPages,
            checkNewOnly: true,
            knownIds: knownIds
        });
    }

    async function saveToStorage() {
        try {
            await api.storage.local.set({
                sunoSongsList: {
                    songs: allSongs,
                    folder: folderInput.value,
                    format: getSelectedFormat(),
                    publicOnly: publicCheckbox.checked,
                    maxPages: parseInt(maxPagesInput.value) || 0,
                    timestamp: Date.now()
                },
                sunoFormat: getSelectedFormat()
            });
        } catch (e) {
            console.error('Failed to save to storage:', e);
        }
    }
    
    async function saveFilterPreferences() {
        try {
            await api.storage.local.set({
                sunoFilterLiked: filterLiked.checked,
                sunoFilterStems: filterStems.checked,
                sunoFilterPublic: filterPublic.checked
            });
        } catch (e) {
            console.error('Failed to save filter preferences:', e);
        }
    }
    
    async function loadFilterPreferences() {
        try {
            const result = await api.storage.local.get(['sunoFilterLiked', 'sunoFilterStems', 'sunoFilterPublic']);
            if (result.sunoFilterLiked !== undefined) {
                filterLiked.checked = result.sunoFilterLiked;
            }
            if (result.sunoFilterStems !== undefined) {
                filterStems.checked = result.sunoFilterStems;
            }
            if (result.sunoFilterPublic !== undefined) {
                filterPublic.checked = result.sunoFilterPublic;
            }
        } catch (e) {
            console.error('Failed to load filter preferences:', e);
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
            await api.storage.local.remove('sunoSongsList');
        } catch (e) {}
    }

    // Fetch songs list
    fetchBtn.addEventListener("click", () => {
        const isPublicOnly = publicCheckbox.checked;
        const maxPages = parseInt(maxPagesInput.value) || 0;
        fetchBtn.disabled = true;
        fetchBtn.textContent = "Fetching...";
        stopBtn.classList.remove("hidden");
        statusDiv.innerText = "Fetching songs list...";
        
        api.runtime.sendMessage({ 
            action: "fetch_songs", 
            isPublicOnly: isPublicOnly,
            maxPages: maxPages
        });
    });

    // Stop fetching
    stopBtn.addEventListener("click", () => {
        api.runtime.sendMessage({ action: "stop_fetch" });
        stopBtn.classList.add("hidden");
        fetchBtn.disabled = false;
        fetchBtn.textContent = "Fetch Songs List";
        statusDiv.innerText = "Stopped by user.\n" + statusDiv.innerText;
    });

    // View cached songs
    viewSongsBtn.addEventListener("click", async () => {
        if (allSongs.length > 0) {
            filteredSongs = [...allSongs];
            settingsPanel.style.display = "none";
            songListContainer.style.display = "block";
            filterInput.value = "";
            selectAllCheckbox.checked = true;
            await loadFilterPreferences();
            renderSongList();
            statusDiv.innerText = `${allSongs.length} cached songs. Checking for new...`;
            
            // Check for new songs
            setTimeout(() => checkForNewSongs(), 100);
        }
    });

    // Back button
    backBtn.addEventListener("click", () => {
        settingsPanel.style.display = "block";
        songListContainer.style.display = "none";
        fetchBtn.disabled = false;
        fetchBtn.textContent = "Fetch Songs List";
        viewSongsBtn.classList.add("hidden");
        allSongs = [];
        filteredSongs = [];
        clearStorage();
    });

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

    // Select all checkbox
    selectAllCheckbox.addEventListener("change", () => {
        const checkboxes = songList.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = selectAllCheckbox.checked);
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
        
        api.runtime.sendMessage({ 
            action: "download_selected", 
            folderName: folder,
            format: format,
            songs: songsToDownload,
            downloadOptions: downloadOptions
        });
        
        const selectedTypes = [];
        if (downloadOptions.music) selectedTypes.push(format.toUpperCase());
        if (downloadOptions.lyrics) selectedTypes.push("lyrics");
        if (downloadOptions.image) selectedTypes.push("images");
        statusDiv.innerText = `Downloading ${songsToDownload.length} song(s): ${selectedTypes.join(", ")}...`;
    });

    // Stop downloading
    stopDownloadBtn.addEventListener("click", () => {
        api.runtime.sendMessage({ action: "stop_download" });
        statusDiv.innerText = "Stopping download...\n" + statusDiv.innerText;
        // Keep UI in running state until background confirms stop/complete
    });

    // Listen for messages from background
    api.runtime.onMessage.addListener((message) => {
        if (message.action === "log") {
            statusDiv.innerText = message.text + "\n" + statusDiv.innerText;
        }

        if (message.action === "download_state") {
            setDownloadUiState(!!message.isDownloading);
        }

        if (message.action === "download_stopped") {
            setDownloadUiState(false);
        }
        
        if (message.action === "songs_fetched") {
            const newSongs = message.songs || [];
            const wasCheckingNew = message.checkNewOnly && allSongs.length > 0;
            
            if (wasCheckingNew) {
                // Merge with existing songs
                const addedCount = mergeSongs(newSongs);
                if (addedCount > 0) {
                    statusDiv.innerText = `Found ${addedCount} new song(s). Total: ${allSongs.length}`;
                } else {
                    statusDiv.innerText = `${allSongs.length} songs (no new songs found).`;
                }
            } else {
                // Fresh fetch - replace all
                allSongs = newSongs;
                filteredSongs = [...allSongs];
                
                settingsPanel.style.display = "none";
                songListContainer.style.display = "block";
                
                filterInput.value = "";
                selectAllCheckbox.checked = true;
                
                loadFilterPreferences().then(() => {
                    renderSongList();
                });
                saveToStorage();
                statusDiv.innerText = `Found ${allSongs.length} songs.`;
            }
            
            // Update View Songs button
            viewSongsBtn.textContent = `View ${allSongs.length} Cached Songs`;
            viewSongsBtn.classList.remove("hidden");
            
            stopBtn.classList.add("hidden");
            fetchBtn.disabled = false;
            fetchBtn.textContent = "Fetch Songs List";
        }
        
        if (message.action === "fetch_error") {
            fetchBtn.disabled = false;
            fetchBtn.textContent = "Fetch Songs List";
            stopBtn.classList.add("hidden");
            statusDiv.innerText = message.error;
        }
        
        if (message.action === "download_complete") {
            setDownloadUiState(false);
        }
    });

    function applyFilter() {
        const filter = filterInput.value.toLowerCase();
        const showLikedOnly = filterLiked.checked;
        const showStemsOnly = filterStems.checked;
        const showPublicOnly = filterPublic.checked;
        
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
            
            return true;
        });
        renderSongList();
    }

    function renderSongList() {
        songList.innerHTML = "";
        
        filteredSongs.forEach(song => {
            const item = document.createElement("div");
            item.className = "song-item";
            
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.dataset.id = song.id;
            checkbox.checked = true;
            checkbox.addEventListener("change", updateSelectedCount);
            
            const songInfo = document.createElement("div");
            songInfo.className = "song-info";
            
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
            
            songInfo.appendChild(titleDiv);
            songInfo.appendChild(metaDiv);
            
            item.appendChild(checkbox);
            item.appendChild(songInfo);
            songList.appendChild(item);
        });
        
        updateSelectedCount();
    }

    function getSelectedSongIds() {
        const checkboxes = songList.querySelectorAll('input[type="checkbox"]:checked');
        return Array.from(checkboxes).map(cb => cb.dataset.id);
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
        const selected = getSelectedSongIds().length;
        songCount.textContent = `${selected}/${total} selected`;
        
        // Update select all checkbox state
        const allChecked = songList.querySelectorAll('input[type="checkbox"]').length === 
                          songList.querySelectorAll('input[type="checkbox"]:checked').length;
        selectAllCheckbox.checked = allChecked && total > 0;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatDate(dateStr) {
        try {
            return new Date(dateStr).toLocaleDateString();
        } catch {
            return '';
        }
    }
});

