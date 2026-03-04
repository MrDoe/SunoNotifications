let currentTabId = null;
let allNotifications=[];
let checkedNotifications=[];
let iconCheck = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" class="h-[20px] w-[20px]"><g><path d="M9.99 16.901a1 1 0 0 1-1.414 0L4.29 12.615c-.39-.39-.385-1.029.006-1.42.39-.39 1.029-.395 1.42-.005l3.567 3.568 8.468-8.468c.39-.39 1.03-.385 1.42.006.39.39.396 1.029.005 1.42z"></path></g></svg>';

function getTabIdFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const id = params.get("tabId")
  return id ? Number(id) : null
}

function localToUtcIso(localValue) {
  if (!localValue) return null
  const date = new Date(localValue)
  if (isNaN(date.getTime())) return null
  return date.toISOString()
}

// -------------------------------------------------------------
// Notification Expansion (Suno → Einzel-Notifications)
// -------------------------------------------------------------
function expandNotification(n) {
  const users = n.user_profiles || [];
  const total = n.total_users || users.length;
  const others = total - users.length;
  const expanded = [];

  // 1) Jeder echte User → eigener Eintrag
  var ix=0;
  for (const u of users) {
    expanded.push({
      ...n,
      ix: ix,
      _singleUser: u,
      _isOtherGroup: false,
      _otherCount: 0
    });
    ix++;
  }

  // 2) EIN Eintrag für alle "others"
  if (others > 0) {
    expanded.push({
      ...n,
      ix: ix,
      _singleUser: null,
      _isOtherGroup: true,
      _otherCount: others
    });
    ix++;
  }

  return expanded;
}

// -------------------------------------------------------------
// Notification Renderer Registry
// -------------------------------------------------------------
// Hilfsfunktion für Zeitformat
function formatTime(ts, param="") {
  const date = ts ? new Date(ts) : null;
  var datum = "";
  var uhrzeit = "";
  var short = "";
  var full = "";
  var fullago = "";
  if (date) {
    uhrzeit = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    datum = date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    short = uhrzeit;
    full = datum + " " + uhrzeit;
    fullago = full + " (" + Math.round((Date.now() - date) / 60000) + " Min.)"; 
  }
  if (param == "fullago") {
    return fullago;
  } else if (param == "full") {
    return full;
  } else { 
    return { short, full };
  }
}

// -------------------------------------------------------------
// Format: Time Ago
// -------------------------------------------------------------
function formatAgo(ts) {
  var ret = "";
  var ago = 0;
  var agoUnit = "";
  if (!! ts) {
    ts = new Date(ts);
    ago = Math.round((Date.now() - ts) / (1000));
    agoUnit = "seconds";
    if (ago > 60) {
      ago = Math.round((Date.now() - ts) / (1000 * 60));
      agoUnit = "minutes";
      if (ago > 60) {
        ago = Math.round((Date.now() - ts) / (1000 * 60 * 60));
        agoUnit = "hours";
        if (ago > 24) {
          ago = Math.round((Date.now() - ts) / (1000 * 60 * 60 * 24));
          agoUnit = "days";
        }
      }
    }
    ret = ago + ' ' + agoUnit + ' ago';
  }
  return ret;
}

// -------------------------------------------------------------
// RENDERER: TIME/DATE
// -------------------------------------------------------------
function renderTimeDate(ts) {
  const t = formatTime(ts);
  const ago = formatAgo(ts);
  return `
        <br>
        <span class="time" title="${t.full}">${ago}, ${t.full}</span>
  `
}

// -------------------------------------------------------------
// RENDERER: User Image
// -------------------------------------------------------------
function renderUserImage(handle,avatar) {
  return `
      <a href="https://suno.com/@${handle}" target="_blank">
        <img class="avatar" src="${avatar}">
      </a>
  `
}

// -------------------------------------------------------------
// RENDERER: CLIP LIKE
// -------------------------------------------------------------
function renderClipLike(n) {
  const title = n.content_title || "";
  const contentId = n.content_id || "";
  const contentImg = n.content_image_url || "";
  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);
  let userHtml = "";

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        liked your song "${title}"
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others liked your song "${title}"
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="https://suno.com/song/${contentId}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: CLIP COMMENT
// -------------------------------------------------------------
function renderClipComment(n) {
  const title = n.content_title || ""
  const contentId = n.content_id || "";
  const contentImg = n.content_image_url || "";
  const message = n.content_message || "";

  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);

  const commentUrl = `https://suno.com/song/${contentId}?show_comments=true`

  let userHtml = ""

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    var msg = ': "' + message + '"';
    if (!! n.ix) { msg = ""; }
    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        commented${msg} on your song "${title}"
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others commented on your song
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="${commentUrl}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: COMMENT LIKE
// -------------------------------------------------------------
function renderCommentLike(n) {
  const title = n.content_title || ""
  const contentId = n.content_id || ""
  const contentImg = n.content_image_url || ""
  const message = n.content_message || ""

  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);

  const commentUrl = `https://suno.com/song/${contentId}?show_comments=true`

  let userHtml = ""

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        liked your comment: "${message}" on the song "${title}"
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others liked your comment "${message}" on the song "${title}"
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="${commentUrl}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: COMMENT REPLY
// -------------------------------------------------------------
function renderCommentReply(n) {
  const title = n.content_title || ""
  const contentId = n.content_id || ""
  const contentImg = n.content_image_url || ""
  const message = n.content_message || ""

  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);

  const commentUrl = `https://suno.com/song/${contentId}?show_comments=true`

  let userHtml = ""

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        replied to your comment: "${message}" on the song "${title}"
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others replied to your comment "${message}" on the song "${title}"
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="${commentUrl}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: VIDEO COVER HOOK LIKE (automatisch erstellte Hooks)
// -------------------------------------------------------------
function renderVideoCoverHookLike(n) {
  const title = n.content_title || ""
  const contentId = n.content_id || ""
  const contentImg = n.content_image_url || ""

  const ts = n.updated_at || n.created_at || n.notified_at
  const trow = renderTimeDate(ts);

  let userHtml = ""

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        liked your video cover in the Hooks feed
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others liked your video cover in the Hooks feed
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="https://suno.com/hook/${contentId}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: HOOK LIKE (manuell erstellte Hooks)
// -------------------------------------------------------------
function renderHookLike(n) {
  const title = n.content_title || ""
  const contentId = n.content_id || ""
  const contentImg = n.content_image_url || ""

  const ts = n.updated_at || n.created_at || n.notified_at
  const trow = renderTimeDate(ts);

  let userHtml = ""

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        liked your hook
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others liked your hook
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="https://suno.com/hook/${contentId}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: HOOK COMMENT
// -------------------------------------------------------------
function renderHookComment(n) {
  const title = n.content_title || ""
  const contentId = n.content_id || "";
  const contentImg = n.content_image_url || "";
  const message = n.content_message || "";

  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);

  const commentUrl = `https://suno.com/hook/${contentId}?show_comments=true`

  let userHtml = ""

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    var msg = ': "' + message + '"';
    if (!! n.ix) { msg = ""; }
    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        commented${msg} on your hook
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others commented on your hook
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="${commentUrl}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: PLAYLIST LIKE
// -------------------------------------------------------------
function renderPlaylistLike(n) {
  const title = n.content_title || "";
  const contentId = n.content_id || "";
  const contentImg = n.content_image_url || "";

  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);

  let userHtml = "";

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        liked your playlist "${title}"
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others liked your playlist "${title}"
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      <a href="https://suno.com/playlist/${contentId}" target="_blank">
        <img class="content" src="${contentImg}">
      </a>
    </div>
  `
}

// -------------------------------------------------------------
// RENDERER: FOLLOW
// -------------------------------------------------------------
function renderFollow(n) {
  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);

  let userHtml = "";
  let following = "";

  if (!n._isOtherGroup) {
    const u = n._singleUser;
    const name = u.display_name;
    const handle = u.handle;
    const avatar = u.avatar_image_url;
    const userImage = renderUserImage(handle,avatar);
    if (u.is_following) {
      following = iconCheck + ' Following';
    }

    userHtml = `
      ${userImage}
      <div class="text">
        <a href="https://suno.com/@${handle}" target="_blank">${name}</a>
        followed you
        ${trow}
      </div>
    `
  } else {
    userHtml = `
      <div class="text" style="margin-left:46px;">
        and ${n._otherCount} others followed you
        ${trow}
      </div>
    `
  }

  return `
    <div class="notif">
      ${userHtml}
      ${following}
    </div>
  `
}

// -------------------------------------------------------------
// Fallback
// -------------------------------------------------------------
function renderFallback(n) {
  const ts = n.updated_at || n.created_at || n.notified_at;
  const trow = renderTimeDate(ts);
  return `
    <div class="notif">
      <div class="text">
        Unknown notification (${n.notification_type || "?"})
        ${trow}
      </div>
    </div>
  `
}

// Registry
const renderers = {
  playlist_like: renderPlaylistLike,
  clip_like: renderClipLike,
  comment_like: renderCommentLike,
  comment_reply: renderCommentReply,
  clip_comment: renderClipComment,
  hook_like: renderHookLike,
  hook_comment: renderHookComment,
  video_cover_hook_like: renderVideoCoverHookLike,
  follow: renderFollow
}

function renderNotification(n) {
  const type = n.notification_type || n.type
  const renderer = renderers[type] || renderFallback
  return renderer(n)
}

//
// -------------------------------------------------------------
// UI
// -------------------------------------------------------------
//

async function init() {
  currentTabId = getTabIdFromUrl()

  if (!currentTabId) {
    document.body.innerHTML = "<p>Fehler: Keine Tab-ID übergeben.</p>"
    return
  }

  chrome.runtime.sendMessage(
    { type: "uiInit", tabId: currentTabId },
    response => {
      updateUI(response.state)
    }
  )
}

function convertUTCDateToLocalDate(date) {
  // getTimezoneOffset = difference in minutes between this date in the UTC time zone and local time zone
  if (! date.getTime) { date=new Date(date); }
  var newDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return newDate;   
}

function updateUI(state) {
  document.getElementById("enabled").checked = state.enabled;
  document.getElementById("interval").value = state.intervalMs;

  document.getElementById("initialAfterLocal").value =
    state.initialAfterUtc
      ? convertUTCDateToLocalDate(state.initialAfterUtc).toISOString().slice(0, 16)
      : convertUTCDateToLocalDate(new Date()).toISOString().slice(0, 16)

  //
  // TOKEN ANZEIGE
  //
  const tokenShort = state.token
    ? "Bearer " +
      state.token.slice(0, 5) +
      " [...] " +
      state.token.slice(-5) + " (" + ("Bearer " + state.token).length + ")"
    : "-"

  const tokenCopyButton = state.token
    ? `<span id="copyToken" style="cursor:pointer; margin-left:6px; margin-right:6px;">⮺</span>`
    : ""

  var tokenLine = `Token: ${tokenShort} ${tokenCopyButton}`;
  if (state.tokenTimestamp) {
    tokenLine+= " (" + Math.round((Date.now() - state.tokenTimestamp) / 60000) + " Min.)";
  }
    
  const activatedAt = formatTime(state.activatedAt, "fullago");
  const lastRequestTime = formatTime(state.lastRequestTime, "fullago");
  const lastNotificationTime = formatTime(state.lastNotificationTime, "fullago");
  const dateNow = formatTime(Date.now(), "full");
  
  var reloadLine = "";
  if (state.reloadCount) {
    reloadLine = "Reloads: " + state.reloadCount + ", Last: ";
    if (state.lastReloadTime) {
      reloadLine+= formatTime(state.lastReloadTime, "fullago");
    } else {
      reloadLine+= "-";
    }
  }

  const stats = [
    `Enabled: ${state.enabled}, Interval: ${state.intervalMs / 1000}s, Updated: ${dateNow}`,
    `Collector activated: ${activatedAt || "-"}`,
    `Last Notification: ${lastNotificationTime || "-"}`,
    `Last Request: ${lastRequestTime || "-"}`,
    tokenLine,
    `Requests (Token / Total): ${state.requestCount} / ${state.totalRequests}`,
    reloadLine,
  ].filter(Boolean).join("\n")

  document.getElementById("stats").innerHTML = stats

  if (state.token) {
    const btn = document.getElementById("copyToken")
    if (btn) {
      btn.onclick = () => {
        navigator.clipboard.writeText("Bearer " + state.token);
      }
    }
  }

  //
  // NOTIFICATIONS
  //
  const notifBox = document.getElementById("notifications");
  const expanded = state.notifications.flatMap(expandNotification);
  allNotifications = [];
  if (!expanded.length) {
    notifBox.innerHTML = "(noch keine)"
  } else {
    notifBox.innerHTML = expanded
      .map((exp) => {
        const key = exp.id + '_' + exp.ix;
        let chk='';
        let cla='';
        if (checkedNotifications.includes(key)) { chk=' checked="checked"'; cla=' class="checked"'; }
        allNotifications.push(key);
        return '<div' + cla + '><input type="checkbox" id="' + key + '" name="' + key + '"' + chk
         + ' style="float:left; margin-top:22px; margin-left:-2px; margin-right:4px;" />'
         + renderNotification(exp) + '</div>';
      })
      .join("");
  }
  //console.log("Starting setOnClickListeners ...");
  setOnClickListeners(); 
}

function setOnClickListeners() {
  var set=0;
  for (const key of allNotifications) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener("click", () => {
      toggleCheck(key, el);
    });
    set++;
  }
  //console.log("setOnClickListeners count set: " + set);
}
         
function toggleCheck(key, el) {
  //console.log('toggleCheck onclick key', key);
  if (checkedNotifications.includes(key)) {
    const index = checkedNotifications.indexOf(key);
    if (index > -1) { // only splice array when item is found
      checkedNotifications.splice(index, 1); // 2nd parameter means remove one item only
      el.parentNode.classList.remove("checked");
    }
  } else {
    checkedNotifications.push(key);
    el.parentNode.classList.add("checked");
  }
}

function sendConfig() {
  const enabled = document.getElementById("enabled").checked;
  const darkmode = document.getElementById("darkmode").checked;
  const intervalMs = Number(document.getElementById("interval").value);

  if (darkmode) {
    document.body.classList.add("darkmode");
  } else {
    document.body.classList.remove("darkmode");
  }

  let initialAfterUtc = null;
  const localValue = document.getElementById("initialAfterLocal").value;
  if (localValue) {
    initialAfterUtc = localToUtcIso(localValue);
  } else {
    initialAfterUtc = new Date().toISOString();
  }

  chrome.runtime.sendMessage({
    type: "setConfig",
    tabId: currentTabId,
    enabled,
    intervalMs,
    initialAfterUtc
  }, response => updateUI(response.state))
}

document.getElementById("enabled").addEventListener("change", sendConfig);
document.getElementById("darkmode").addEventListener("change", sendConfig);
document.getElementById("interval").addEventListener("change", sendConfig);
document.getElementById("initialAfterLocal").addEventListener("change", sendConfig);

document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "clearNotifications",
    tabId: currentTabId
  }, response => updateUI(response.state))
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "stateUpdate" && msg.tabId === currentTabId) {
    updateUI(msg.state);
  }
})

init()
