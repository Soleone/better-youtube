(() => {
  if (window.__YTQF_BRIDGE_INSTALLED__) {
    return;
  }

  window.__YTQF_BRIDGE_INSTALLED__ = true;

  const CONTENT_SOURCE = "YTQF_CONTENT";
  const PAGE_SOURCE = "YTQF_BRIDGE";

  const EDIT_ENDPOINTS = ["/youtubei/v1/browse/edit_playlist"];

  const REQUEST_TYPES = {
    add: "YTQF_ADD_TO_PLAYLIST",
    remove: "YTQF_REMOVE_FROM_PLAYLIST",
  };

  const RESPONSE_TYPES = {
    [REQUEST_TYPES.add]: "YTQF_ADD_RESULT",
    [REQUEST_TYPES.remove]: "YTQF_REMOVE_RESULT",
  };

  const REMOVE_ACTION_VARIANTS = [
    [{ action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: "{videoId}" }],
    [{ action: "ACTION_REMOVE_VIDEO", removedVideoId: "{videoId}" }],
  ];

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
    const input = `${timestamp} ${sapisid} https://www.youtube.com`;
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return `SAPISIDHASH ${timestamp}_${hash}`;
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

  async function sendEditRequest(config, endpointPath, playlistId, actions) {
    const url =
      "https://www.youtube.com" + endpointPath + "?key=" + encodeURIComponent(config.apiKey) + "&prettyPrint=false";

    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: await buildHeaders(config),
      body: JSON.stringify({
        context: buildRequestContext(config),
        playlistId,
        actions,
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

  function parseEditResult(payload) {
    const statuses = [];
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
          statuses.push("STATUS_SUCCEEDED");
        }

        if (item?.playlistEditVideoAlreadyInPlaylistResultData) {
          hasAlreadyInPlaylistResult = true;
          statuses.push("VIDEO_ALREADY_IN_PLAYLIST");
        }
      });
    }

    return {
      statuses,
      hasAlreadyInPlaylistResult,
      hasPlaylistEditResults: Array.isArray(payload?.playlistEditResults),
    };
  }

  function buildPlaylistIds(inputPlaylistId) {
    const ids = [inputPlaylistId];

    if (inputPlaylistId.startsWith("VL") && inputPlaylistId.length > 2) {
      ids.push(inputPlaylistId.slice(2));
    } else {
      ids.push("VL" + inputPlaylistId);
    }

    return ids;
  }

  function renderActions(templateActions, videoId) {
    return templateActions.map((action) => {
      const mapped = { ...action };

      if (mapped.addedVideoId === "{videoId}") {
        mapped.addedVideoId = videoId;
      }

      if (mapped.removedVideoId === "{videoId}") {
        mapped.removedVideoId = videoId;
      }

      return mapped;
    });
  }

  function formatAttempt(endpointPath, playlistId, detail) {
    return `${endpointPath}(${playlistId}): ${detail}`;
  }

  function getHttpError(response, payload) {
    if (response.ok && !(payload && payload.error)) {
      return null;
    }

    return payload?.error?.message || `HTTP ${response.status}`;
  }

  async function runEditAttempts({
    videoId,
    inputPlaylistId,
    actionVariants,
    isStatusSuccess,
    mapSuccess,
    failurePrefix,
    failureHint,
  }) {
    const config = getRuntimeConfig();
    const failureReasons = [];

    for (const playlistId of buildPlaylistIds(inputPlaylistId)) {
      for (const endpointPath of EDIT_ENDPOINTS) {
        for (const templateActions of actionVariants) {
          let result;

          try {
            result = await sendEditRequest(config, endpointPath, playlistId, renderActions(templateActions, videoId));
          } catch (error) {
            failureReasons.push(formatAttempt(endpointPath, playlistId, `network ${error?.message || "unknown"}`));
            continue;
          }

          const httpError = getHttpError(result.response, result.payload);
          if (httpError) {
            failureReasons.push(formatAttempt(endpointPath, playlistId, httpError));
            continue;
          }

          const editResult = parseEditResult(result.payload);
          if (editResult.statuses.length === 0 && !editResult.hasPlaylistEditResults) {
            const payloadKeys = result.payload ? Object.keys(result.payload).slice(0, 8).join(",") : "no-payload";
            failureReasons.push(formatAttempt(endpointPath, playlistId, `no-playlistEditResults [${payloadKeys}]`));
            continue;
          }

          const failedStatus = editResult.statuses.find((status) => !isStatusSuccess(status));
          if (failedStatus) {
            failureReasons.push(formatAttempt(endpointPath, playlistId, failedStatus));
            continue;
          }

          return mapSuccess({
            endpointPath,
            playlistId,
            statuses: editResult.statuses,
            editResult,
          });
        }
      }
    }

    throw new Error(`${failurePrefix}: ${failureReasons.join(" | ")} ${failureHint}`);
  }

  async function addToPlaylist(videoId, playlistId) {
    return runEditAttempts({
      videoId,
      inputPlaylistId: playlistId,
      actionVariants: [[{ action: "ACTION_ADD_VIDEO", addedVideoId: "{videoId}" }]],
      isStatusSuccess: (status) => status === "STATUS_SUCCEEDED" || status === "VIDEO_ALREADY_IN_PLAYLIST",
      mapSuccess: ({ endpointPath, playlistId: resolvedPlaylistId, statuses, editResult }) => ({
        message: editResult.hasAlreadyInPlaylistResult || statuses.includes("VIDEO_ALREADY_IN_PLAYLIST") ? "Already in playlist" : "Added",
        statuses,
        endpoint: endpointPath,
        playlistId: resolvedPlaylistId,
      }),
      failurePrefix: "YouTube rejected add action",
      failureHint: "(check playlist ownership/channel and that manual Save works for this playlist)",
    });
  }

  async function removeFromPlaylist(videoId, playlistId) {
    return runEditAttempts({
      videoId,
      inputPlaylistId: playlistId,
      actionVariants: REMOVE_ACTION_VARIANTS,
      isStatusSuccess: (status) => status === "STATUS_SUCCEEDED",
      mapSuccess: ({ endpointPath, playlistId: resolvedPlaylistId, statuses }) => ({
        message: "Removed",
        statuses,
        endpoint: endpointPath,
        playlistId: resolvedPlaylistId,
      }),
      failurePrefix: "YouTube rejected remove action",
      failureHint: "(if this repeats, YouTube may require video-specific set IDs for removal)",
    });
  }

  async function handleMessage(requestType, videoId, playlistId) {
    if (requestType === REQUEST_TYPES.add) {
      return addToPlaylist(videoId, playlistId);
    }

    return removeFromPlaylist(videoId, playlistId);
  }

  function postBridgeResponse(type, requestId, ok, detailOrError) {
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type,
        requestId,
        ok,
        ...(ok ? { detail: detailOrError } : { error: detailOrError }),
      },
      "*"
    );
  }

  window.addEventListener("message", async (event) => {
    const { data, source } = event;
    if (source !== window || !data || data.source !== CONTENT_SOURCE) {
      return;
    }

    const requestType = data.type;
    if (requestType !== REQUEST_TYPES.add && requestType !== REQUEST_TYPES.remove) {
      return;
    }

    const responseType = RESPONSE_TYPES[requestType];
    const requestId = data.requestId;
    const videoId = data.payload?.videoId;
    const playlistId = data.payload?.playlistId;

    if (!requestId || !videoId || !playlistId) {
      postBridgeResponse(responseType, requestId, false, "Missing request payload.");
      return;
    }

    try {
      const detail = await handleMessage(requestType, videoId, playlistId);
      postBridgeResponse(responseType, requestId, true, detail);
    } catch (error) {
      postBridgeResponse(responseType, requestId, false, error?.message || "Unknown failure");
    }
  });
})();
