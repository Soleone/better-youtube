const STORAGE_KEY = "favoritePlaylists";
const CONTENT_SOURCE = "YTQF_CONTENT";
const PAGE_SOURCE = "YTQF_BRIDGE";

let favoritePlaylists = [];
let scanQueued = false;
let requestCounter = 0;
let activePanelClose = null;
const pendingRequests = new Map();

const CARD_SELECTOR = [
  "ytd-rich-grid-media",
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
].join(", ");

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
  const cards = document.querySelectorAll(CARD_SELECTOR);

  cards.forEach((card) => {
    if (card.dataset.ytqfInjected === "1") {
      return;
    }

    const videoId = getVideoId(card);
    if (!videoId) {
      return;
    }

    const target = findInsertTarget(card);
    if (!target) {
      return;
    }

    const container = document.createElement("div");
    container.className = "ytqf-container";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ytqf-trigger";
    button.textContent = "Quick add";

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPlaylistPanel(button, videoId, container);
    });

    container.appendChild(button);
    target.appendChild(container);

    card.dataset.ytqfInjected = "1";
  });
}

function findInsertTarget(card) {
  return (
    card.querySelector("#menu-container") ||
    card.querySelector("#buttons") ||
    card.querySelector("#menu") ||
    card.querySelector("#metadata") ||
    card.querySelector("#details") ||
    card.querySelector("#dismissible") ||
    card
  );
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
  return [...favoritePlaylists].sort((a, b) => {
    if (a.pinned && !b.pinned) {
      return -1;
    }

    if (!a.pinned && b.pinned) {
      return 1;
    }

    return a.title.localeCompare(b.title);
  });
}

function openPlaylistPanel(anchor, videoId, feedbackHost) {
  closeActivePanel();

  const panel = document.createElement("div");
  panel.className = "ytqf-panel";

  const title = document.createElement("div");
  title.className = "ytqf-panel-title";
  title.textContent = "Add to playlist";
  panel.appendChild(title);

  const playlists = sortedPlaylists();
  if (playlists.length === 0) {
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
  } else {
    playlists.forEach((playlist) => {
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
        const allButtons = panel.querySelectorAll("button");
        allButtons.forEach((button) => {
          button.disabled = true;
        });

        showFeedback(feedbackHost, "Adding...");

        try {
          const result = await addVideoToPlaylist(videoId, playlist.id);
          const prefix = result?.message === "Already in playlist" ? "Already in" : "Added to";
          showFeedback(feedbackHost, `${prefix} ${playlist.title}`);
        } catch (error) {
          showFeedback(feedbackHost, error?.message || "Could not add video.", true);
        } finally {
          closeActivePanel();
        }
      });

      panel.appendChild(item);
    });
  }

  document.body.appendChild(panel);

  const rect = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - panel.offsetHeight - 10, rect.bottom + 6);
  const left = Math.min(window.innerWidth - panel.offsetWidth - 10, rect.left);
  panel.style.top = `${Math.max(10, top)}px`;
  panel.style.left = `${Math.max(10, left)}px`;

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
  activePanelClose = close;
}

function closeActivePanel() {
  if (activePanelClose) {
    activePanelClose();
  }
}

function showFeedback(host, message, isError = false) {
  const existing = host.querySelector(".ytqf-feedback");
  if (existing) {
    existing.remove();
  }

  const feedback = document.createElement("span");
  feedback.className = `ytqf-feedback ${isError ? "ytqf-feedback--error" : "ytqf-feedback--ok"}`;
  feedback.textContent = message;
  host.appendChild(feedback);

  setTimeout(() => {
    feedback.remove();
  }, 2200);
}

function addVideoToPlaylist(videoId, playlistId) {
  return new Promise((resolve, reject) => {
    const requestId = `ytqf-${Date.now()}-${requestCounter++}`;

    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Timed out while adding to playlist."));
    }, 10000);

    pendingRequests.set(requestId, {
      resolve: (detail) => {
        clearTimeout(timeout);
        resolve(detail || null);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type: "YTQF_ADD_TO_PLAYLIST",
        requestId,
        payload: { videoId, playlistId },
      },
      "*"
    );
  });
}

function onBridgeMessage(event) {
  if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) {
    return;
  }

  if (event.data.type !== "YTQF_ADD_RESULT") {
    return;
  }

  const request = pendingRequests.get(event.data.requestId);
  if (!request) {
    return;
  }

  pendingRequests.delete(event.data.requestId);

  if (event.data.ok) {
    request.resolve(event.data.detail || null);
    return;
  }

  request.reject(new Error(event.data.error || "YouTube rejected the request."));
}

