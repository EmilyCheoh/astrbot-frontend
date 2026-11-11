
/* ================================================================
   Den — WebSocket Connection
   Pure transport layer — NO UI knowledge.
   Exposes connectWS(token, onMessage, getReconnectContext), send(payload),
   isConnected().

   Generation tracking: each openSocket() call increments a local
   counter.  Callbacks from stale sockets (whose generation no longer
   matches) are silently dropped — prevents a replaced connection's
   late onclose/onmessage from corrupting global state.

   Close code 4001: server-initiated session replacement.  Clears
   the saved token, cancels any pending reconnect timer, and does
   NOT schedule a new reconnect.  The message handler receives a
   synthetic {type: "session_replaced"} so the UI can react.

   Mobile resume: foreground/page restore probes an apparently open
   socket via the existing server-side ping/pong handler.  An unresponsive
   socket is replaced and the existing auth/history resume path runs.
   ================================================================ */

const RESUME_PROBE_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 10000;

let ws = null;
let savedToken = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let messageHandler = null;
let socketGeneration = 0;
let reconnectContextProvider = null;
let resumeProbeTimer = null;
let connectingSince = 0;

function clearResumeProbe() {
  if (resumeProbeTimer !== null) {
    clearTimeout(resumeProbeTimer);
    resumeProbeTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!savedToken) return;
    openSocket(true);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  }, reconnectDelay);
}

function openSocket(isReconnect) {
  clearResumeProbe();
  const gen = ++socketGeneration;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  connectingSince = Date.now();

  sock.onopen = () => {
    if (gen !== socketGeneration) return;

    const auth = { type: "auth", token: savedToken };

    if (isReconnect && reconnectContextProvider) {
      const context = reconnectContextProvider();
      if (context?.conversationId && context?.platformId) {
        auth.resume_conversation_id = context.conversationId;
        auth.resume_platform_id = context.platformId;
      }
    }

    sock.send(JSON.stringify(auth));
    connectingSince = 0;
    reconnectDelay = 1000;
  };

  sock.onmessage = (evt) => {
    if (gen !== socketGeneration) return;
    const data = JSON.parse(evt.data);
    if (data.type === "pong") {
      clearResumeProbe();
      return;
    }
    if (messageHandler) messageHandler(data);
  };

  sock.onclose = (event) => {
    if (gen !== socketGeneration) return;
    clearResumeProbe();
    connectingSince = 0;

    if (event.code === 4001) {
      // Server replaced this session — permanent stop, no reconnect.
      // The server already sent a JSON "session_replaced" message
      // before closing, so the UI handler has been (or will be)
      // called via onmessage.  Dispatch a fallback synthetic event
      // in case the JSON message was lost in transit.
      stopReconnect();
      if (messageHandler) messageHandler({ type: "session_replaced" });
      return;
    }

    if (savedToken) {
      if (messageHandler) {
        messageHandler({ type: "connection_lost" });
      }
      scheduleReconnect();
    }
  };

  sock.onerror = () => { };
}

function replaceUnresponsiveSocket() {
  if (!savedToken) return;
  const oldSocket = ws;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (messageHandler) messageHandler({ type: "connection_lost" });
  // Bump generation before closing: the old connection's late events
  // must not stop a valid replacement session.
  openSocket(true);
  if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
    try { oldSocket.close(); } catch (_) { }
  }
}

function checkConnectionOnResume() {
  if (!savedToken) return;

  // If the mobile browser suspended the reconnect timer in the
  // background, reconnect as soon as the page comes back.
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    openSocket(true);
    return;
  }

  const sock = ws;
  if (!sock) return;

  if (sock.readyState === WebSocket.CONNECTING) {
    if (connectingSince && Date.now() - connectingSince >= CONNECT_TIMEOUT) {
      replaceUnresponsiveSocket();
    }
    return;
  }

  // A socket can still claim OPEN after a phone's network was suspended.
  // Probe the actual server before trusting it, rather than replacing
  // every healthy connection whenever the user switches apps.
  if (sock.readyState !== WebSocket.OPEN) return;

  clearResumeProbe();
  const gen = socketGeneration;
  resumeProbeTimer = setTimeout(() => {
    resumeProbeTimer = null;
    if (!savedToken || gen !== socketGeneration || ws !== sock) return;
    if (document.visibilityState === "hidden") return;
    replaceUnresponsiveSocket();
  }, RESUME_PROBE_TIMEOUT);

  try {
    sock.send(JSON.stringify({ type: "ping" }));
  } catch (_) {
    clearResumeProbe();
    replaceUnresponsiveSocket();
  }
}

// Mobile Safari and other browsers can freeze timers and WebSocket events
// while hidden.  Check on both ordinary foreground return and bfcache restore.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkConnectionOnResume();
});
window.addEventListener("pageshow", checkConnectionOnResume);

export function connectWS(token, onMessage, getReconnectContext = null) {
  savedToken = token;
  messageHandler = onMessage;
  reconnectContextProvider = getReconnectContext;

  // Manual login — always false, never carries resume fields.
  openSocket(false);
}

export function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function stopReconnect() {
  savedToken = null;
  reconnectContextProvider = null;
  connectingSince = 0;
  clearResumeProbe();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
