// background.js — Verbesserte Token-Verwaltung ohne Tab-Dependency

function logFormatDate(ts) {
  const date = ts ? new Date(ts) : null;
  if (date) {
    const uhrzeit = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const datum = date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    return datum + " " + uhrzeit + " = " + ts;
  } else {
    return ts;
  }
}

function log(...args) {
  console.log("[BACKGROUND]", ...args, "at", logFormatDate(Date.now()));
}

setInterval(() => {
  log("heartbeat");
}, 60000);

const tabState = {};
const DEFAULT_INTERVAL_MS = 120000;

function ensureTabState(tabId) {
  if (!tabState[tabId]) {
    tabState[tabId] = {
      enabled: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      initialAfterUtc: null,
      token: null,
      tokenTimestamp: null,
      requestCount: 0,
      totalRequests: 0,
      lastRequestTime: null,
      reloadCount: 0,
      lastReloadTime: null,
      lastNotificationTime: null,
      activatedAt: null,
      notifications: [],
      lastError: null,
      // NEU: Clerk Session Token
      clerkSessionToken: null,
      clerkSessionExpiry: null
    };
  }
  return tabState[tabId];
}

// ============================================================================
// LÖSUNG 1: Clerk Session Token aus Cookies + eigener Refresh
// ============================================================================

/**
 * Holt das Clerk Session Token (__session Cookie) direkt aus den Browser-Cookies
 * Dies funktioniert auch wenn der Tab schläft!
 */
async function getClerkSessionFromCookies() {
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://suno.com',
      name: '__session'
    });
    
    if (cookie?.value) {
      log("Clerk __session Cookie gefunden:", cookie.value.slice(0, 20) + "...");
      return cookie.value;
    }
    
    log("Clerk __session Cookie NICHT gefunden");
    return null;
  } catch (err) {
    log("Error getting Clerk session cookie:", err.message);
    return null;
  }
}

/**
 * Refresht das Bearer Token direkt über Clerk's API
 * Nutzt das Session Token aus dem Cookie
 */
async function refreshTokenViaClerkAPI(sessionToken) {
  try {
    // Clerk's Token-Endpoint (Standard für alle Clerk-Apps)
    const response = await fetch('https://clerk.suno.com/v1/client/sessions/active/tokens', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        template: ''  // Leerer Template-Name = Standard Bearer Token
      })
    });

    if (!response.ok) {
      log("Clerk API refresh failed:", response.status, response.statusText);
      return null;
    }

    const data = await response.json();
    
    if (data.jwt) {
      log("NEW Bearer Token via Clerk API:", data.jwt.slice(0, 20) + "...");
      return {
        token: data.jwt,
        expiresAt: Date.now() + (50 * 60 * 1000) // 50 Minuten
      };
    }

    return null;
  } catch (err) {
    log("Error refreshing token via Clerk API:", err.message);
    return null;
  }
}

/**
 * Hauptfunktion: Token bereitstellen - mit automatischem Refresh
 * Funktioniert OHNE aktiven Tab!
 */
async function ensureValidTokenCookieBased(tabId) {
  log("ensureValidTokenCookieBased called for tab", tabId);

  const st = ensureTabState(tabId);
  const now = Date.now();

  // Prüfen: Haben wir ein gültiges Token im Cache?
  if (st.token && st.tokenTimestamp && (now - st.tokenTimestamp < 45 * 60 * 1000)) {
    log("Returning CACHED token (age:", Math.floor((now - st.tokenTimestamp) / 60000), "min)");
    return st.token;
  }

  log("Token expired or missing - fetching new token via Clerk API");

  // Schritt 1: Session Token aus Cookie holen
  const sessionToken = await getClerkSessionFromCookies();
  if (!sessionToken) {
    log("FEHLER: Kein Clerk Session Cookie gefunden - User muss bei Suno eingeloggt sein!");
    return null;
  }

  // Schritt 2: Neues Bearer Token von Clerk API holen
  const tokenData = await refreshTokenViaClerkAPI(sessionToken);
  if (!tokenData) {
    log("FEHLER: Clerk API Token-Refresh fehlgeschlagen");
    return null;
  }

  // Schritt 3: Token cachen
  st.token = tokenData.token;
  st.tokenTimestamp = now;
  st.clerkSessionToken = sessionToken;
  st.clerkSessionExpiry = tokenData.expiresAt;

  log("Token successfully refreshed and cached");
  return tokenData.token;
}

// ============================================================================
// LÖSUNG 2: Tab Keep-Alive mit Chrome Alarms API
// ============================================================================

/**
 * Service Worker Alarm für automatischen Token-Refresh
 * Läuft alle 45 Minuten, unabhängig von Tab-Status
 */
chrome.alarms.create('tokenRefresh', {
  delayInMinutes: 1,        // Erste Ausführung nach 1 Minute
  periodInMinutes: 45       // Dann alle 45 Minuten
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tokenRefresh') {
    log("⏰ ALARM: Token Refresh triggered");
    
    // Für alle aktiven Collector: Token refreshen
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        log("⏰ Refreshing token for active collector tab", tabId);
        await ensureValidTokenCookieBased(Number(tabId));
      }
    }
  }
});

/**
 * Sanfter Keep-Alive ohne Tab-Reload
 * Verhindert Tab-Discarding durch minimale Interaktion
 */
async function keepTabAlive(tabId) {
  try {
    // Prüfen ob Tab existiert
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return false;

    // Minimale Script-Injection um Tab "aktiv" zu halten
    // Dies verhindert dass Edge den Tab einfriert
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "ISOLATED",  // ISOLATED statt MAIN - weniger invasiv
      func: () => {
        // Timestamp setzen - minimal invasiv
        if (!window.__sunoKeepalive) {
          window.__sunoKeepalive = { count: 0 };
        }
        window.__sunoKeepalive.count++;
        window.__sunoKeepalive.lastPing = Date.now();
      }
    });

    log("✓ Keep-alive ping successful for tab", tabId);
    return true;
  } catch (err) {
    log("✗ Keep-alive failed for tab", tabId, ":", err.message);
    return false;
  }
}

/**
 * Keep-Alive Alarm - alle 5 Minuten
 * Deutlich seltener als Tab-Reload, aber genug um Discarding zu verhindern
 */
chrome.alarms.create('keepAlive', {
  delayInMinutes: 1,
  periodInMinutes: 5  // Alle 5 Minuten statt 10 Minuten Reload
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') {
    log("⏰ ALARM: Keep-Alive triggered");
    
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        await keepTabAlive(Number(tabId));
      }
    }
  }
});

// ============================================================================
// FALLBACK: Token aus MAIN World (nur wenn Cookie-Methode fehlschlägt)
// ============================================================================

async function fetchTokenDirect(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          if (!window.Clerk) return { ok: false, reason: "no-clerk" };
          if (!window.Clerk.session) return { ok: false, reason: "no-session" };
          const token = await window.Clerk.session.getToken();
          if (!token) {
            console.log("[BACKGROUND-ASYNC]", "fetchTokenDirect ERROR: Clerk returned null token at", Date.now());
            return { ok: false, reason: "null-token" };
          }
          console.log("[BACKGROUND-ASYNC]", "fetchTokenDirect NEW TOKEN created:", token.slice(0, 12), "…", "at", Date.now());
          return { ok: true, token };
        } catch(err) {
          console.log("[BACKGROUND-ASYNC]", "fetchTokenDirect ERROR:", err.message, "at", Date.now());
          return { ok: false, reason: err.message };
        }
      }
    });
    const result = results?.[0]?.result;
    if (!result?.ok) {
      log("fetchTokenDirect failed:", result?.reason);
      return null;
    }
    return result.token;
  } catch (err) {
    log("fetchTokenDirect exception:", err.message);
    return null;
  }
}

/**
 * Haupt-Token-Funktion mit Fallback-Strategie
 */
async function ensureValidToken(tabId) {
  log("ensureValidToken called for tab", tabId);

  // STRATEGIE 1: Cookie-basiert (funktioniert auch bei schlafendem Tab)
  const cookieToken = await ensureValidTokenCookieBased(tabId);
  if (cookieToken) {
    log("✓ Token via Cookie-Methode erhalten");
    return cookieToken;
  }

  log("⚠ Cookie-Methode fehlgeschlagen, versuche MAIN-World-Fallback...");

  // STRATEGIE 2: Fallback zu MAIN world (alter Ansatz)
  const st = ensureTabState(tabId);
  const MAX_AGE = 50 * 60 * 1000;

  // Cache prüfen
  if (st.token && st.tokenTimestamp && Date.now() - st.tokenTimestamp < MAX_AGE) {
    log("✓ Returning cached token from MAIN world method");
    return st.token;
  }

  // Versuche Token aus MAIN world zu holen
  for (let i = 0; i < 3; i++) {
    log(`Attempt ${i + 1}/3: fetchTokenDirect for tab`, tabId);
    const token = await fetchTokenDirect(tabId);
    
    if (token) {
      log("✓ NEW TOKEN via MAIN world:", token.slice(0, 12), "…");
      st.token = token;
      st.tokenTimestamp = Date.now();
      return token;
    }
    
    log("✗ fetchTokenDirect returned null, attempt", i + 1);
    await new Promise(r => setTimeout(r, 500));
  }

  log("❌ FEHLER: Beide Token-Strategien fehlgeschlagen!");
  st.lastError = "Token refresh failed - both strategies exhausted";
  return null;
}

// ============================================================================
// Offscreen-Dokument
// ============================================================================

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Suno polling"
    });
  }
}

// ============================================================================
// Nachrichten vom Offscreen
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "offscreenRequestToken") {
    log("[NVO] offscreenRequestToken received for tab", msg.tabId);
    ensureValidToken(msg.tabId).then(token => {
      if (!token) {
        log("[NVO] offscreenRequestToken → ensureValidToken returned NULL for tab", msg.tabId);
      } else {
        log("[NVO] offscreenRequestToken → returning token", token.slice(0, 12), "…", "for tab", msg.tabId);
      }
      sendResponse({ token });
    });
    return true;
  }

  if (msg.type === "offscreenStateUpdate") {
    const st = ensureTabState(msg.tabId);
    Object.assign(st, msg.state);

    chrome.runtime.sendMessage({
      type: "stateUpdate",
      tabId: msg.tabId,
      state: { ...st }
    });

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "offscreenTokenExpired" || msg.type === "offscreenNoToken") {
    log("[NVO] Token expired/missing for Tab", msg.tabId, "- triggering refresh");
    
    // WICHTIG: Kein Tab-Reload mehr nötig!
    // Token wird beim nächsten ensureValidToken() automatisch refreshed
    const st = ensureTabState(tabId);
    st.token = null;  // Token invalidieren
    st.tokenTimestamp = null;
    
    sendResponse({ ok: true });
    return true;
  }
});

// ============================================================================
// UI → Hintergrund
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "uiInit") {
    const st = ensureTabState(msg.tabId);
    sendResponse({ state: { ...st } });
    return true;
  }

  if (msg.type === "setConfig") {
    const st = ensureTabState(msg.tabId);

    const oldEnabled = st.enabled;
    st.enabled = msg.enabled;
    st.intervalMs = msg.intervalMs;

    if (st.initialAfterUtc !== msg.initialAfterUtc) {
      st.initialAfterUtc = msg.initialAfterUtc;
      st.lastNotificationTime = null;
      st.notifications = [];
    }

    if (st.enabled) {
      if (oldEnabled !== st.enabled || !st.activatedAt) {
        st.activatedAt = new Date().toISOString();
        st.requestCount = 0;
        st.totalRequests = 0;
        
        log("✓ Collector aktiviert für Tab", msg.tabId);
        
        // Token sofort holen (nicht auf Alarm warten)
        ensureValidToken(msg.tabId).then(token => {
          if (token) {
            log("✓ Initial token fetch successful");
          } else {
            log("⚠ Initial token fetch failed - will retry on next alarm");
          }
        });
      }
    } else {
      st.activatedAt = null;
      log("Collector deaktiviert für Tab", msg.tabId);
    }

    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({
        type: "offscreenSetState",
        tabId: msg.tabId,
        state: { ...st }
      });
    });

    sendResponse({ state: { ...st } });
    return true;
  }

  if (msg.type === "clearNotifications") {
    const st = ensureTabState(msg.tabId);
    st.notifications = [];

    chrome.runtime.sendMessage({
      type: "offscreenSetState",
      tabId: msg.tabId,
      state: { ...st }
    });

    sendResponse({ state: { ...st } });
    return true;
  }

  if (msg.type === "offscreenKeepalivePing") {
    // Keepalive wird jetzt über Chrome Alarms gehandelt
    // Dieser Handler kann bleiben für manuelle Triggers
    for (const [tabId, st] of Object.entries(tabState)) {
      if (st.enabled) {
        keepTabAlive(Number(tabId));
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "pingMainWorld") {
    const activeTabId = Object.keys(tabState).find(id => tabState[id].enabled);
    if (!activeTabId) {
      log("pingMainWorld → no active tab");
      sendResponse({ ok: false, reason: "no-active-tab" });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId: Number(activeTabId), allFrames: false },
      world: "MAIN",
      func: () => {
        window.__suno_ping = (window.__suno_ping || 0) + 1;
        return { pong: window.__suno_ping, ts: Date.now() };
      }
    }, results => {
      if (chrome.runtime.lastError) {
        log("pingMainWorld executeScript error", chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      log("pingMainWorld result", results);
      sendResponse({ ok: true, result: results });
    });
    return true;
  }
});

// ============================================================================
// Tab geschlossen
// ============================================================================

chrome.tabs.onRemoved.addListener(tabId => {
  log("tab removed", tabId);
  chrome.runtime.sendMessage({
    type: "offscreenClearTab",
    tabId
  });
  if (tabState[tabId]) {
    delete tabState[tabId];
  }
});

// ============================================================================
// Action → Detached-Fenster öffnen
// ============================================================================

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  const url = chrome.runtime.getURL(`detached.html?tabId=${tab.id}`);

  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 555,
    height: 700
  });

  const st = ensureTabState(tab.id);
  st.detachedWindowId = win.id;
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [tabId, st] of Object.entries(tabState)) {
    if (st.detachedWindowId === windowId) {
      st.enabled = false;
      st.activatedAt = null;

      chrome.runtime.sendMessage({
        type: "offscreenSetState",
        tabId: Number(tabId),
        state: { ...st }
      });

      chrome.runtime.sendMessage({
        type: "stateUpdate",
        tabId: Number(tabId),
        state: { ...st }
      });

      delete st.detachedWindowId;
    }
  }
});

// ============================================================================
// Initialisierung beim Start
// ============================================================================

log("🚀 Background Service Worker gestartet");
log("Token-Refresh via Clerk API alle 45 Minuten");
log("Tab Keep-Alive alle 5 Minuten");
