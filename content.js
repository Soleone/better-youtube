const STORAGE_KEY = "favoritePlaylists";
const CONTENT_SOURCE = "YTQF_CONTENT";
const PAGE_SOURCE = "YTQF_BRIDGE";

const REQUEST_TIMEOUT_MS = 10_000;
const PANEL_HOVER_CLOSE_DELAY_MS = 600;

const DEFAULT_TRIGGER_LABEL = "Quick add";

const CARD_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-rich-grid-media",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-compact-video-renderer",
  "yt-lockup-view-model.yt-lockup-view-model--wrapper",
].join(", ");

const PLAYLIST_ROW_SELECTOR = "ytd-playlist-video-renderer";

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
  remove: "Remove",
  removing: "Removing…",
  restoring: "Restoring…",
  restored: "Restored ✓",
};

const TRIGGER_RESET_MS = {
  already: 1800,
  failed: 2200,
  success: 1200,
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
    closeActivePanel("navigation");
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

    if (isQuickAddPage()) {
      injectQuickAddButtons();
    }

    if (isPlaylistPage()) {
      injectPlaylistRemoveButtons();
    }

    injectGuidePlaylistsEntry();
  });
}

function isQuickAddPage() {
  return ["/", "/feed/subscriptions", "/watch"].includes(location.pathname);
}

function isPlaylistPage() {
  return location.pathname === "/playlist";
}

function injectGuidePlaylistsEntry() {
  const guideItems = document.querySelector("ytd-guide-renderer #sections ytd-guide-section-renderer #items");
  if (!guideItems || guideItems.querySelector("[data-ytqf-guide-playlists='1']")) {
    return;
  }

  const shortsEntry = [...guideItems.querySelectorAll("ytd-guide-entry-renderer")].find(
    (entry) => entry.querySelector(".title")?.textContent.trim() === "Shorts"
  );

  if (!shortsEntry) {
    return;
  }

  const entry = document.createElement("div");
  entry.dataset.ytqfGuidePlaylists = "1";
  entry.className = "ytqf-guide-playlists-entry";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ytqf-guide-playlists-button";
  button.setAttribute("aria-label", "Playlists");
  button.title = "Playlists";

  const icon = document.createElement("span");
  icon.className = "ytqf-guide-playlists-icon";
  icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true"><path d="M16 15.395a.5.5 0 01.762-.426L22.5 18.5l-5.738 3.531a.5.5 0 01-.762-.425v-6.212ZM14 19H4a1 1 0 110-2h10v2Zm6-8a1 1 0 110 2H4a1 1 0 110-2h16Zm0-6a1 1 0 110 2H4a1 1 0 010-2h16Z"></path></svg>`;

  const label = document.createElement("span");
  label.className = "ytqf-guide-playlists-label";
  label.textContent = "Playlists";

  button.append(icon, label);
  entry.appendChild(button);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openGuidePlaylistsPanel(entry);
  });

  shortsEntry.after(entry);
}

function openGuidePlaylistsPanel(anchor) {
  closeActivePanel("replaced");

  const panel = buildPanel("Open playlist");
  const playlists = sortedPlaylists();

  if (playlists.length === 0) {
    appendEmptyPanelState(panel);
  } else {
    playlists.forEach((playlist) => {
      panel.appendChild(
        createPlaylistItem(playlist, {
          isDefault: playlist.pinned,
          onSelect: () => {
            closeActivePanel("selected");
            navigateToPlaylist(playlist.id);
          },
        })
      );
    });
  }

  document.body.appendChild(panel);
  positionPanel(panel, anchor);
  activePanelClose = bindPanelCloseHandlers(panel, anchor);
}

function navigateToPlaylist(playlistId) {
  const href = `/playlist?list=${encodeURIComponent(playlistId)}`;
  window.location.href = href;
}

function injectQuickAddButtons() {
  const processedCards = new Set();

  document.querySelectorAll(CARD_SELECTOR).forEach((candidate) => {
    const card = resolveCardRoot(candidate);
    if (!card || processedCards.has(card)) {
      return;
    }

    processedCards.add(card);

    const injectedAncestor = card.parentElement?.closest("[data-ytqf-injected='1']");
    if (injectedAncestor) {
      return;
    }

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

    injectQuickAddTrigger(card, placement, videoId);
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
    const mode = card.matches("yt-lockup-view-model.yt-lockup-view-model--wrapper") ? "inline-static" : "inline";
    return { mode, host: inlineHost };
  }

  const overlayHost = card.querySelector("#dismissible") || card;
  const reserveHost = card.querySelector("#details") || card.querySelector("#meta") || card.querySelector("#metadata");

  return { mode: "overlay", host: overlayHost, reserveHost };
}

function findInlineHost(card) {
  if (card.matches("ytd-compact-video-renderer")) {
    return card.querySelector("#details") || null;
  }

  if (card.matches("yt-lockup-view-model.yt-lockup-view-model--wrapper")) {
    return card.querySelector(".yt-lockup-metadata-view-model__text-container") || null;
  }

  return (
    card.querySelector("#meta") ||
    card.querySelector("#metadata") ||
    card.querySelector("ytd-video-meta-block") ||
    card.querySelector("#text-container") ||
    null
  );
}

function injectQuickAddTrigger(card, placement, videoId) {
  const container = document.createElement("div");
  container.className = "ytqf-container";

  if (placement.mode === "inline") {
    placement.host.classList.add("ytqf-inline-host");
    container.classList.add("ytqf-container--inline-right");
  } else if (placement.mode === "inline-static") {
    placement.host.classList.add("ytqf-lockup-inline-host");
    container.classList.add("ytqf-container--lockup-inline");
  } else {
    placement.host.classList.add("ytqf-card-host");
    container.classList.add("ytqf-container--overlay-right");
    placement.reserveHost?.classList.add("ytqf-inline-host");
  }

  const trigger = createQuickAddTrigger(videoId);
  container.appendChild(trigger);
  placement.host.appendChild(container);

  card.dataset.ytqfInjected = "1";
}

function createQuickAddTrigger(videoId) {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ytqf-trigger";
  setTriggerState(trigger, { label: DEFAULT_TRIGGER_LABEL });

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const undoAction = undoActionsByTrigger.get(trigger);
    if (undoAction) {
      runUndoAction(trigger, undoAction);
      return;
    }

    openPlaylistPanel(trigger, videoId);
  });

  return trigger;
}

function injectPlaylistRemoveButtons() {
  const playlistId = getCurrentPlaylistId();
  if (!playlistId) {
    return;
  }

  document.querySelectorAll(PLAYLIST_ROW_SELECTOR).forEach((row) => {
    if (row.dataset.ytqfRemoveInjected === "1" && row.querySelector(".ytqf-playlist-remove-container")) {
      return;
    }

    const videoId = getVideoId(row);
    if (!videoId) {
      return;
    }

    const host = findPlaylistRemoveHost(row);
    if (!host) {
      return;
    }

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ytqf-trigger";
    setTriggerState(trigger, { label: TRIGGER_LABELS.remove, variant: "remove" });

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const undoAction = undoActionsByTrigger.get(trigger);
      if (undoAction) {
        runUndoAction(trigger, undoAction);
        return;
      }

      removeFromPlaylistRow(trigger, videoId, playlistId);
    });

    const container = document.createElement("div");
    container.className = "ytqf-container ytqf-playlist-remove-container";
    container.appendChild(trigger);

    host.prepend(container);
    row.dataset.ytqfRemoveInjected = "1";
  });
}

function findPlaylistRemoveHost(row) {
  return (
    row.querySelector("#menu #top-level-buttons-computed") ||
    row.querySelector("#menu") ||
    row.querySelector("#menu-container") ||
    row.querySelector("ytd-menu-renderer") ||
    null
  );
}

function getCurrentPlaylistId() {
  try {
    const url = new URL(location.href);
    return url.searchParams.get("list");
  } catch {
    return null;
  }
}

async function removeFromPlaylistRow(trigger, videoId, playlistId) {
  setTriggerState(trigger, {
    label: TRIGGER_LABELS.removing,
    disabled: true,
    variant: "loading",
  });

  try {
    await removeVideoFromPlaylist(videoId, playlistId);

    setUndoAction(trigger, {
      type: REQUEST_TYPES.add,
      videoId,
      playlistId,
      pendingLabel: TRIGGER_LABELS.restoring,
      successLabel: TRIGGER_LABELS.restored,
      resetLabel: TRIGGER_LABELS.remove,
      resetVariant: "remove",
    });

    setTriggerState(trigger, { label: TRIGGER_LABELS.undo, variant: "undo" });
  } catch (error) {
    console.error("[YTQF] remove failed", error);
    setTriggerState(trigger, { label: TRIGGER_LABELS.failed, variant: "error" });
    scheduleTriggerState(trigger, TRIGGER_RESET_MS.failed, {
      label: TRIGGER_LABELS.remove,
      variant: "remove",
    });
  }
}

function setUndoAction(trigger, action) {
  undoActionsByTrigger.set(trigger, action);
}

async function runUndoAction(trigger, action) {
  setTriggerState(trigger, {
    label: action.pendingLabel,
    disabled: true,
    variant: "loading",
  });

  try {
    if (action.type === REQUEST_TYPES.add) {
      await addVideoToPlaylist(action.videoId, action.playlistId);
    } else {
      await removeVideoFromPlaylist(action.videoId, action.playlistId);
    }

    undoActionsByTrigger.delete(trigger);
    setTriggerState(trigger, { label: action.successLabel, variant: "success" });

    scheduleTriggerState(trigger, TRIGGER_RESET_MS.success, {
      label: action.resetLabel,
      variant: action.resetVariant,
    });
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

function getVideoId(scope) {
  const link = scope.querySelector(
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

function resolveDefaultPlaylist(playlists) {
  return playlists.find((playlist) => playlist.pinned) || playlists[0] || null;
}

function openPlaylistPanel(anchor, videoId) {
  closeActivePanel("replaced");

  const panel = buildPanel();
  const playlists = sortedPlaylists();
  const defaultPlaylist = resolveDefaultPlaylist(playlists);

  let isSubmitting = false;
  let hasManualSelection = false;

  const selectPlaylist = async (playlist, { closePanel = true } = {}) => {
    if (!playlist || isSubmitting) {
      return;
    }

    isSubmitting = true;
    disablePanelButtons(panel);

    if (closePanel) {
      closeActivePanel("selected");
    }

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
        setUndoAction(anchor, {
          type: REQUEST_TYPES.remove,
          videoId,
          playlistId: playlist.id,
          pendingLabel: TRIGGER_LABELS.undoing,
          successLabel: TRIGGER_LABELS.undone,
          resetLabel: DEFAULT_TRIGGER_LABEL,
        });

        setTriggerState(anchor, { label: TRIGGER_LABELS.undo, variant: "undo" });
      }
    } catch (error) {
      console.error("[YTQF] add to playlist failed", error);
      setTriggerState(anchor, { label: TRIGGER_LABELS.failed, variant: "error" });
      scheduleTriggerState(anchor, TRIGGER_RESET_MS.failed, { label: DEFAULT_TRIGGER_LABEL });
    } finally {
      isSubmitting = false;
    }
  };

  if (playlists.length === 0) {
    appendEmptyPanelState(panel);
  } else {
    playlists.forEach((playlist) => {
      panel.appendChild(
        createPlaylistItem(playlist, {
          isDefault: playlist.id === defaultPlaylist?.id,
          onSelect: () => {
            hasManualSelection = true;
            void selectPlaylist(playlist, { closePanel: true });
          },
        })
      );
    });
  }

  document.body.appendChild(panel);
  positionPanel(panel, anchor);
  activePanelClose = bindPanelCloseHandlers(panel, anchor, (reason) => {
    const shouldDefaultOnClose = reason === "hover-timeout";
    if (!shouldDefaultOnClose || hasManualSelection || isSubmitting || !defaultPlaylist) {
      return;
    }

    void selectPlaylist(defaultPlaylist, { closePanel: false });
  });
}

function buildPanel(titleText = "Add to playlist") {
  const panel = document.createElement("div");
  panel.className = "ytqf-panel";

  const title = document.createElement("div");
  title.className = "ytqf-panel-title";
  title.textContent = titleText;
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
    closeActivePanel("options");
  });

  panel.appendChild(openOptions);
}

function createPlaylistItem(playlist, { onSelect, isDefault = false }) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `ytqf-item${isDefault ? " ytqf-item--default" : ""}`;

  if (playlist.pinned) {
    const pin = document.createElement("span");
    pin.className = "ytqf-item-pin";
    pin.textContent = "★";
    item.appendChild(pin);
  }

  const label = document.createElement("span");
  label.textContent = playlist.title;
  item.appendChild(label);

  item.addEventListener("click", () => {
    void onSelect();
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

function bindPanelCloseHandlers(panel, anchor, onClose) {
  let hoverCloseTimer = null;
  let lastPointer = null;

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  };

  const pointInElement = (element, point) => {
    if (!point || !element.isConnected) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  };

  let isPointerInsideMenu = false;

  const isHoveringMenu = () =>
    isPointerInsideMenu || pointInElement(panel, lastPointer) || pointInElement(anchor, lastPointer);

  const scheduleHoverClose = () => {
    clearHoverCloseTimer();
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;

      if (!isHoveringMenu()) {
        closeActivePanel("hover-timeout");
      }
    }, PANEL_HOVER_CLOSE_DELAY_MS);
  };

  const syncHoverClose = () => {
    if (isHoveringMenu()) {
      clearHoverCloseTimer();
    } else if (!hoverCloseTimer) {
      scheduleHoverClose();
    }
  };

  const onPointerMove = (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    syncHoverClose();
  };

  const onMenuPointerEnter = (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    isPointerInsideMenu = true;
    clearHoverCloseTimer();
  };

  const onMenuPointerLeave = (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    isPointerInsideMenu = false;
    scheduleHoverClose();
  };

  const onOutsideClick = (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };

    if (panel.contains(event.target) || anchor.contains(event.target)) {
      syncHoverClose();
      return;
    }

    closeActivePanel("dismiss");
  };

  const close = (reason = "programmatic") => {
    clearHoverCloseTimer();
    document.removeEventListener("click", onOutsideClick, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    panel.removeEventListener("pointerenter", onMenuPointerEnter);
    panel.removeEventListener("pointerleave", onMenuPointerLeave);
    anchor.removeEventListener("pointerenter", onMenuPointerEnter);
    anchor.removeEventListener("pointerleave", onMenuPointerLeave);
    panel.remove();

    if (onClose) {
      onClose(reason);
      onClose = null;
    }

    if (activePanelClose === close) {
      activePanelClose = null;
    }
  };

  setTimeout(() => {
    document.addEventListener("click", onOutsideClick, true);
  }, 0);

  document.addEventListener("pointermove", onPointerMove, true);
  panel.addEventListener("pointerenter", onMenuPointerEnter);
  panel.addEventListener("pointerleave", onMenuPointerLeave);
  anchor.addEventListener("pointerenter", onMenuPointerEnter);
  anchor.addEventListener("pointerleave", onMenuPointerLeave);

  return close;
}

function closeActivePanel(reason = "programmatic") {
  if (activePanelClose) {
    activePanelClose(reason);
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
  trigger.classList.toggle("ytqf-trigger--remove", variant === "remove");
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
