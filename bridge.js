(() => {
  if (window.__YTQF_BRIDGE_INSTALLED__) {
    return;
  }

  window.__YTQF_BRIDGE_INSTALLED__ = true;

  const CONTENT_SOURCE = "YTQF_CONTENT";
  const PAGE_SOURCE = "YTQF_BRIDGE";
  const EDIT_ENDPOINTS = ["/youtubei/v1/browse/edit_playlist"];

  function getRuntimeConfig() {
    const ytcfgObj = window.ytcfg;
    if (!ytcfgObj || typeof ytcfgObj.get !== "function") {
      throw new Error("Could not access YouTube config (ytcfg).");
    }

    const apiKey = ytcfgObj.get("INNERTUBE_API_KEY");
    const context = ytcfgObj.get("INNERTUBE_CONTEXT");

    if (!apiKey || !context) {
      throw new Error("Missing YouTube internal API config.");
    }

    return {
      apiKey,
      context,
      clientName: ytcfgObj.get("INNERTUBE_CONTEXT_CLIENT_NAME") || 1,
      clientVersion:
        ytcfgObj.get("INNERTUBE_CONTEXT_CLIENT_VERSION") || ytcfgObj.get("INNERTUBE_CLIENT_VERSION") || "",
      sessionIndex: ytcfgObj.get("SESSION_INDEX") || 0,
      visitorData: ytcfgObj.get("VISITOR_DATA") || "",
      delegatedSessionId: ytcfgObj.get("DELEGATED_SESSION_ID") || "",
    };
  }

  function getCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function createAuthorizationHeader() {
    const sapisid = getCookie("SAPISID") || getCookie("__Secure-3PAPISID") || getCookie("APISID");
    if (!sapisid) {
      return "";
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const input = String(timestamp) + " " + sapisid + " https://www.youtube.com";
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return "SAPISIDHASH " + timestamp + "_" + hash;
  }

  async function buildHeaders(config) {
    const headers = {
      "content-type": "application/json",
      "x-origin": "https://www.youtube.com",
      "x-youtube-client-name": String(config.clientName),
      "x-youtube-client-version": String(config.clientVersion),
      "x-goog-authuser": String(config.sessionIndex),
      "x-goog-visitor-id": String(config.visitorData),
      "x-youtube-bootstrap-logged-in": "true",
    };

    if (config.delegatedSessionId) {
      headers["x-goog-pageid"] = String(config.delegatedSessionId);
    }

    const authorization = await createAuthorizationHeader();
    if (authorization) {
      headers.authorization = authorization;
    }

    return headers;
  }

  function parseEditResult(payload) {
    const statuses = [];
    let hasAddedResult = false;
    let hasAlreadyInPlaylistResult = false;

    if (typeof payload?.status === "string") {
      statuses.push(payload.status);
    }

    if (Array.isArray(payload?.playlistEditResults)) {
      payload.playlistEditResults.forEach((item) => {
        if (typeof item?.status === "string") {
          statuses.push(item.status);
        }

        if (item?.playlistEditVideoAddedResultData) {
          hasAddedResult = true;
          statuses.push("STATUS_SUCCEEDED");
        }

        if (item?.playlistEditVideoAlreadyInPlaylistResultData) {
          hasAlreadyInPlaylistResult = true;
          statuses.push("VIDEO_ALREADY_IN_PLAYLIST");
        }
      });
    }

    return {
      statuses: statuses.filter((status) => typeof status === "string"),
      hasAddedResult,
      hasAlreadyInPlaylistResult,
      hasPlaylistEditResults: Array.isArray(payload?.playlistEditResults),
    };
  }

  function isSuccessStatus(status) {
    return status === "STATUS_SUCCEEDED" || status === "VIDEO_ALREADY_IN_PLAYLIST";
  }

  function buildRequestContext(config) {
    const baseContext = config.context || {};
    const user = { ...(baseContext.user || {}) };

    if (config.delegatedSessionId) {
      user.onBehalfOfUser = String(config.delegatedSessionId);
    }

    return {
      ...baseContext,
      user,
    };
  }

  async function sendEditRequest(config, endpointPath, videoId, playlistId) {
    const url =
      "https://www.youtube.com" +
      endpointPath +
      "?key=" +
      encodeURIComponent(config.apiKey) +
      "&prettyPrint=false";

    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: await buildHeaders(config),
      body: JSON.stringify({
        context: buildRequestContext(config),
        playlistId,
        actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: videoId }],
      }),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return { response, payload };
  }

  async function addToPlaylist(videoId, inputPlaylistId) {
    const config = getRuntimeConfig();
    const attempts = [];

    const playlistIds = [inputPlaylistId];

    if (inputPlaylistId.startsWith("VL") && inputPlaylistId.length > 2) {
      playlistIds.push(inputPlaylistId.slice(2));
    } else {
      playlistIds.push("VL" + inputPlaylistId);
    }

    for (const playlistId of playlistIds) {
      for (const endpointPath of EDIT_ENDPOINTS) {
        let result;

        try {
          result = await sendEditRequest(config, endpointPath, videoId, playlistId);
        } catch (error) {
          attempts.push(endpointPath + "(" + playlistId + "): network " + (error?.message || "unknown"));
          continue;
        }

        const response = result.response;
        const payload = result.payload;

        if (!response.ok || (payload && payload.error)) {
          const message = payload?.error?.message || "HTTP " + response.status;
          attempts.push(endpointPath + "(" + playlistId + "): " + message);
          continue;
        }

        const editResult = parseEditResult(payload);
        const statuses = editResult.statuses;

        if (statuses.length === 0 && !editResult.hasPlaylistEditResults) {
          const payloadKeys = payload ? Object.keys(payload).slice(0, 8).join(",") : "no-payload";
          attempts.push(endpointPath + "(" + playlistId + "): no-playlistEditResults [" + payloadKeys + "]");
          continue;
        }

        const failed = statuses.find((status) => !isSuccessStatus(status));
        if (failed) {
          attempts.push(endpointPath + "(" + playlistId + "): " + failed);
          continue;
        }

        const already = editResult.hasAlreadyInPlaylistResult || statuses.includes("VIDEO_ALREADY_IN_PLAYLIST");

        return {
          message: already ? "Already in playlist" : "Added",
          statuses,
          endpoint: endpointPath,
          playlistId,
        };
      }
    }

    throw new Error(
      "YouTube rejected add action: " +
        attempts.join(" | ") +
        " (check playlist ownership/channel and that manual Save works for this playlist)"
    );
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== CONTENT_SOURCE) {
      return;
    }

    if (event.data.type !== "YTQF_ADD_TO_PLAYLIST") {
      return;
    }

    const requestId = event.data.requestId;
    const videoId = event.data.payload?.videoId;
    const playlistId = event.data.payload?.playlistId;

    if (!requestId || !videoId || !playlistId) {
      window.postMessage(
        {
          source: PAGE_SOURCE,
          type: "YTQF_ADD_RESULT",
          requestId,
          ok: false,
          error: "Missing request payload.",
        },
        "*"
      );
      return;
    }

    try {
      const detail = await addToPlaylist(videoId, playlistId);
      window.postMessage(
        {
          source: PAGE_SOURCE,
          type: "YTQF_ADD_RESULT",
          requestId,
          ok: true,
          detail,
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: PAGE_SOURCE,
          type: "YTQF_ADD_RESULT",
          requestId,
          ok: false,
          error: error?.message || "Unknown failure",
        },
        "*"
      );
    }
  });
})();
