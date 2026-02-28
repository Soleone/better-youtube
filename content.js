const STORAGE_KEY = "favoritePlaylists";
const CONTENT_SOURCE = "YTQF_CONTENT";
const PAGE_SOURCE = "YTQF_BRIDGE";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TRIGGER_LABEL = "Quick add";
const CARD_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-rich-grid-media",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
].join(", ");

const REQUEST_TYPES = {
  add: "YTQF_ADD_TO_PLAYLIST",
  remove: "YTQF_REMOVE_FROM_PLAYLIST",
};

const RESPONSE_TYPES = new Set(["YTQF_ADD_RESULT", "YTQF_REMOVE_RESULT"]);

const TRIGGER_LABELS = {
  adding: "Adding…",
  already: "Already ✓",
  undo: "Undo",
  undoing: "Undoing…",
  undone: "Undone ✓",
  failed: "Failed",
  undoFailed: "Undo failed",
};

const TRIGGER_RESET_MS = {
  already: 1800,
  failed: 2200,
  undone: 1200,
  undoFailed: 2200,
};

let favoritePlaylists = [];
let scanQueued = false;
let requestCounter = 0;
let activePanelClose = null;

const pendingRequests = new Map();
const triggerResetTimers = new WeakMap();
const undoActionsByTrigger = new WeakMap();

init().catch((error) => {
  console.error("[YTQF] init failed", error);
});

async function init() {
  await loadPlaylists();
  setupListeners();
  scheduleScan();
}

function setupListeners() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }

    favoritePlaylists = normalizePlaylists(changes[STORAGE_KEY].newValue);
    scheduleScan();
  });

  document.addEventListener("yt-navigate-finish", () => {
    closeActivePanel();
    scheduleScan();
  });

  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("message", onBridgeMessage);
}

async function loadPlaylists() {
  const data = await chrome.storage.sync.get({ [STORAGE_KEY]: [] });
  favoritePlaylists = normalizePlaylists(data[STORAGE_KEY]);
}

function normalizePlaylists(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      title: item.title || item.id,
      pinned: Boolean(item.pinned),
    }));
}

function scheduleScan() {
  if (scanQueued) {
    return;
  }

  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;

    if (!isTargetPage()) {
      return;
    }

    injectButtons();
  });
}

function isTargetPage() {
  return location.pathname === "/" || location.pathname === "/feed/subscriptions";
}

function injectButtons() {
  const processedCards = new Set();

  document.querySelectorAll(CARD_SELECTOR).forEach((candidate) => {
    const card = resolveCardRoot(candidate);
    if (!card || processedCards.has(card)) {
      return;
    }

    processedCards.add(card);

    if (card.dataset.ytqfInjected === "1" && card.querySelector(".ytqf-container")) {
      return;
    }

    const videoId = getVideoId(card);
    if (!videoId) {
      return;
    }

    const placement = resolvePlacement(card);
    if (!placement) {
      return;
    }

    injectTrigger(card, placement, videoId);
  });
}

function resolveCardRoot(candidate) {
  if (candidate.matches("ytd-rich-item-renderer")) {
    return candidate.querySelector("ytd-rich-grid-media") || candidate;
  }

  return candidate;
}

function resolvePlacement(card) {
  const inlineHost = findInlineHost(card);
  if (inlineHost) {
    return { mode: "inline", host: inlineHost };
  }

  const overlayHost = card.querySelector("#dismissible") || card;
  const reserveHost = card.querySelector("#details") || card.querySelector("#meta") || card.querySelector("#metadata");
  return { mode: "overlay", host: overlayHost, reserveHost };
}

function findInlineHost(card) {
  return (
    card.querySelector("#meta") ||
    card.querySelector("#metadata") ||
    card.querySelector("ytd-video-meta-block") ||
    card.querySelector("#text-container") ||
    null
  );
}

function injectTrigger(card, placement, videoId) {
  const container = document.createElement("div");
  container.className = "ytqf-container";

  if (placement.mode === "inline") {
    placement.host.classList.add("ytqf-inline-host");
    container.classList.add("ytqf-container--inline-right");
  } else {
    placement.host.classList.add("ytqf-card-host");
    container.classList.add("ytqf-container--overlay-right");
    placement.reserveHost?.classList.add("ytqf-inline-host");
  }

  const trigger = createTrigger(videoId);
  container.appendChild(trigger);
  placement.host.appendChild(container);

  card.dataset.ytqfInjected = "1";
}

function createTrigger(videoId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ytqf-trigger";
  setTriggerState(button, { label: DEFAULT_TRIGGER_LABEL });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const undoAction = undoActionsByTrigger.get(button);
    if (undoAction) {
      runUndo(button, undoAction);
      return;
    }

    openPlaylistPanel(button, videoId);
  });

  return button;
}

function getVideoId(card) {
  const link = card.querySelector(
    "a#thumbnail[href*='/watch'], a#video-title-link[href*='/watch'], a#video-title[href*='/watch'], a[href*='/watch?v=']"
  );

  if (!link) {
    return null;
  }

  const href = link.getAttribute("href") || link.href;
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, location.origin);
    return url.searchParams.get("v");
  } catch {
    const match = href.match(/[?&]v=([^&]+)/);
    return match ? match[1] : null;
  }
}

function sortedPlaylists() {
  return [...favoritePlaylists];
}

function openPlaylistPanel(anchor, videoId) {
  closeActivePanel();

  const panel = buildPanel();
  const playlists = sortedPlaylists();

  if (playlists.length === 0) {
    appendEmptyPanelState(panel);
  } else {
    playlists.forEach((playlist) => {
      panel.appendChild(createPlaylistItem(panel, anchor, videoId, playlist));
    });
  }

  document.body.appendChild(panel);
  positionPanel(panel, anchor);

  const close = bindPanelCloseHandlers(panel, anchor);
  activePanelClose = close;
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.className = "ytqf-panel";

  const title = document.createElement("div");
  title.className = "ytqf-panel-title";
  title.textContent = "Add to playlist";
  panel.appendChild(title);

  return panel;
}

function appendEmptyPanelState(panel) {
  const empty = document.createElement("div");
  empty.className = "ytqf-empty";
  empty.textContent = "No favorite playlists configured yet.";
  panel.appendChild(empty);

  const openOptions = document.createElement("button");
  openOptions.type = "button";
  openOptions.className = "ytqf-link";
  openOptions.textContent = "Open extension options";
  openOptions.addEventListener("click", async () => {
    await chrome.runtime.openOptionsPage();
    closeActivePanel();
  });

  panel.appendChild(openOptions);
}

function createPlaylistItem(panel, anchor, videoId, playlist) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "ytqf-item";

  if (playlist.pinned) {
    const pin = document.createElement("span");
    pin.className = "ytqf-item-pin";
    pin.textContent = "★";
    item.appendChild(pin);
  }

  const label = document.createElement("span");
  label.textContent = playlist.title;
  item.appendChild(label);

  item.addEventListener("click", async () => {
    disablePanelButtons(panel);

    setTriggerState(anchor, {
      label: TRIGGER_LABELS.adding,
      disabled: true,
      variant: "loading",
    });

    try {
      const result = await addVideoToPlaylist(videoId, playlist.id);

      if (result?.message === "Already in playlist") {
        setTriggerState(anchor, { label: TRIGGER_LABELS.already, variant: "success" });
        scheduleTriggerState(anchor, TRIGGER_RESET_MS.already, { label: DEFAULT_TRIGGER_LABEL });
      } else {
        undoActionsByTrigger.set(anchor, { videoId, playlistId: playlist.id });
        setTriggerState(anchor, { label: TRIGGER_LABELS.undo, variant: "undo" });
      }
    } catch (error) {
      console.error("[YTQF] add to playlist failed", error);
      setTriggerState(anchor, { label: TRIGGER_LABELS.failed, variant: "error" });
      scheduleTriggerState(anchor, TRIGGER_RESET_MS.failed, { label: DEFAULT_TRIGGER_LABEL });
    } finally {
      closeActivePanel();
    }
  });

  return item;
}

function disablePanelButtons(panel) {
  panel.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
}

function positionPanel(panel, anchor) {
  const rect = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - panel.offsetHeight - 10, rect.bottom + 6);
  const left = Math.min(window.innerWidth - panel.offsetWidth - 10, rect.left);

  panel.style.top = `${Math.max(10, top)}px`;
  panel.style.left = `${Math.max(10, left)}px`;
}

function bindPanelCloseHandlers(panel, anchor) {
  const onOutsideClick = (event) => {
    if (panel.contains(event.target) || anchor.contains(event.target)) {
      return;
    }

    closeActivePanel();
  };

  const close = () => {
    document.removeEventListener("click", onOutsideClick, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close, true);
    panel.remove();

    if (activePanelClose === close) {
      activePanelClose = null;
    }
  };

  setTimeout(() => {
    document.addEventListener("click", onOutsideClick, true);
  }, 0);

  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close, true);

  return close;
}

function closeActivePanel() {
  if (activePanelClose) {
    activePanelClose();
  }
}

async function runUndo(trigger, undoAction) {
  setTriggerState(trigger, {
    label: TRIGGER_LABELS.undoing,
    disabled: true,
    variant: "loading",
  });

  try {
    await removeVideoFromPlaylist(undoAction.videoId, undoAction.playlistId);
    undoActionsByTrigger.delete(trigger);

    setTriggerState(trigger, { label: TRIGGER_LABELS.undone, variant: "success" });
    scheduleTriggerState(trigger, TRIGGER_RESET_MS.undone, { label: DEFAULT_TRIGGER_LABEL });
  } catch (error) {
    console.error("[YTQF] undo failed", error);
    setTriggerState(trigger, { label: TRIGGER_LABELS.undoFailed, variant: "error" });
    scheduleTriggerState(trigger, TRIGGER_RESET_MS.undoFailed, {
      label: TRIGGER_LABELS.undo,
      variant: "undo",
      clearUndo: false,
    });
  }
}

function setTriggerState(trigger, { label, disabled = false, variant = "default" }) {
  clearTriggerReset(trigger);

  trigger.textContent = label;
  trigger.disabled = disabled;

  trigger.classList.toggle("ytqf-trigger--loading", variant === "loading");
  trigger.classList.toggle("ytqf-trigger--success", variant === "success");
  trigger.classList.toggle("ytqf-trigger--error", variant === "error");
  trigger.classList.toggle("ytqf-trigger--undo", variant === "undo");
}

function scheduleTriggerState(trigger, delay, { label, variant = "default", clearUndo = true }) {
  clearTriggerReset(trigger);

  const timerId = setTimeout(() => {
    triggerResetTimers.delete(trigger);

    if (clearUndo) {
      undoActionsByTrigger.delete(trigger);
    }

    setTriggerState(trigger, { label, variant });
  }, delay);

  triggerResetTimers.set(trigger, timerId);
}

function clearTriggerReset(trigger) {
  const timerId = triggerResetTimers.get(trigger);
  if (!timerId) {
    return;
  }

  clearTimeout(timerId);
  triggerResetTimers.delete(trigger);
}

function addVideoToPlaylist(videoId, playlistId) {
  return sendBridgeRequest(REQUEST_TYPES.add, { videoId, playlistId }, "Timed out while adding to playlist.");
}

function removeVideoFromPlaylist(videoId, playlistId) {
  return sendBridgeRequest(REQUEST_TYPES.remove, { videoId, playlistId }, "Timed out while removing from playlist.");
}

function sendBridgeRequest(type, payload, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const requestId = `ytqf-${Date.now()}-${requestCounter++}`;

    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(timeoutMessage));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      resolve: (detail) => {
        clearTimeout(timeoutId);
        resolve(detail || null);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    });

    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type,
        requestId,
        payload,
      },
      "*"
    );
  });
}

function onBridgeMessage(event) {
  const { data, source } = event;
  if (source !== window || !data || data.source !== PAGE_SOURCE || !RESPONSE_TYPES.has(data.type)) {
    return;
  }

  const request = pendingRequests.get(data.requestId);
  if (!request) {
    return;
  }

  pendingRequests.delete(data.requestId);

  if (data.ok) {
    request.resolve(data.detail || null);
    return;
  }

  request.reject(new Error(data.error || "YouTube rejected the request."));
}
