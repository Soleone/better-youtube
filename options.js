const STORAGE_KEY = "favoritePlaylists";

const form = document.getElementById("add-form");
const playlistInput = document.getElementById("playlist-input");
const titleInput = document.getElementById("title-input");
const pinnedInput = document.getElementById("pinned-input");
const playlistList = document.getElementById("playlist-list");
const status = document.getElementById("status");

let playlists = [];

init().catch((error) => {
  console.error("[YTQF options] init failed", error);
  setStatus("Failed to load options.");
});

async function init() {
  form.addEventListener("submit", onSubmit);
  await loadPlaylists();
  render();
}

async function loadPlaylists() {
  const data = await chrome.storage.sync.get({ [STORAGE_KEY]: [] });
  playlists = normalizePlaylists(data[STORAGE_KEY]);
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

async function persist(message) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: playlists });
  render();
  setStatus(message);
}

async function onSubmit(event) {
  event.preventDefault();

  const rawInput = playlistInput.value.trim();
  const title = titleInput.value.trim();
  const shouldPin = pinnedInput.checked;

  let playlistId;
  try {
    playlistId = parsePlaylistId(rawInput);
  } catch (error) {
    setStatus(error.message);
    return;
  }

  const existing = playlists.find((playlist) => playlist.id === playlistId);
  if (existing) {
    existing.title = title || existing.title || playlistId;
    existing.pinned = shouldPin || existing.pinned;
  } else {
    playlists.push({
      id: playlistId,
      title: title || playlistId,
      pinned: shouldPin,
    });
  }

  if (shouldPin) {
    setPinned(playlistId);
  }

  await persist("Playlist saved.");
  form.reset();
}

function parsePlaylistId(value) {
  if (!value) {
    throw new Error("Please enter a playlist URL or ID.");
  }

  const normalized = value.trim();

  try {
    const url = new URL(normalized);
    const playlistId = url.searchParams.get("list");
    if (playlistId) {
      return validatePlaylistId(playlistId);
    }
  } catch {
    // Not a URL, continue as plain ID.
  }

  return validatePlaylistId(normalized);
}

function validatePlaylistId(id) {
  const candidate = id.trim();

  if (!/^[A-Za-z0-9_-]{10,}$/.test(candidate)) {
    throw new Error("That does not look like a valid YouTube playlist ID.");
  }

  return candidate;
}

function setPinned(id) {
  playlists = playlists.map((playlist) => ({
    ...playlist,
    pinned: playlist.id === id,
  }));
}

function sortedPlaylists() {
  return [...playlists];
}

function movePlaylist(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= playlists.length) {
    return false;
  }

  const [item] = playlists.splice(index, 1);
  playlists.splice(targetIndex, 0, item);
  return true;
}

function render() {
  playlistList.innerHTML = "";

  const items = sortedPlaylists();
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No favorites yet.";
    empty.className = "tiny";
    playlistList.appendChild(empty);
    return;
  }

  items.forEach((playlist, index) => {
    const row = document.createElement("li");
    row.className = `playlist-row ${playlist.pinned ? "pinned" : ""}`;

    const head = document.createElement("div");
    head.className = "playlist-head";

    const titleField = document.createElement("input");
    titleField.value = playlist.title;
    titleField.addEventListener("change", async () => {
      const target = playlists.find((item) => item.id === playlist.id);
      if (!target) {
        return;
      }

      target.title = titleField.value.trim() || target.id;
      await persist("Playlist label updated.");
    });

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const moveUpButton = document.createElement("button");
    moveUpButton.type = "button";
    moveUpButton.textContent = "↑";
    moveUpButton.disabled = index === 0;
    moveUpButton.addEventListener("click", async () => {
      if (!movePlaylist(index, -1)) {
        return;
      }

      await persist("Playlist order updated.");
    });

    const moveDownButton = document.createElement("button");
    moveDownButton.type = "button";
    moveDownButton.textContent = "↓";
    moveDownButton.disabled = index === items.length - 1;
    moveDownButton.addEventListener("click", async () => {
      if (!movePlaylist(index, 1)) {
        return;
      }

      await persist("Playlist order updated.");
    });

    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.textContent = playlist.pinned ? "Pinned" : "Pin";
    pinButton.addEventListener("click", async () => {
      setPinned(playlist.id);
      await persist("Pinned playlist updated.");
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", async () => {
      playlists = playlists.filter((item) => item.id !== playlist.id);
      await persist("Playlist removed.");
    });

    actions.appendChild(moveUpButton);
    actions.appendChild(moveDownButton);
    actions.appendChild(pinButton);
    actions.appendChild(removeButton);

    head.appendChild(titleField);
    head.appendChild(actions);

    const idText = document.createElement("div");
    idText.className = "playlist-id";
    idText.textContent = playlist.id;

    row.appendChild(head);
    row.appendChild(idText);
    playlistList.appendChild(row);
  });
}

function setStatus(message) {
  status.textContent = message;
  setTimeout(() => {
    if (status.textContent === message) {
      status.textContent = "";
    }
  }, 2200);
}
