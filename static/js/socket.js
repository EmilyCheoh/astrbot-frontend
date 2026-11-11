
/* ================================================================
   Den — WebSocket Connection
   Pure transport layer — NO UI knowledge.
   Exposes connectWS(token, onMessage, getReconnectContext), send(payload),
   isConnected().

   Generation tracking: each openSocket() call increments a local
   counter. Callbacks from stale sockets are silently dropped.

   Close code 4001: server-initiated session replacement.
   Do not reconnect after an intentional session takeover.

   Mobile resume: foreground/page restore checks the connection,
   probes apparently open sockets, and recovers stalled sockets.
   ================================================================ */

const RESUME_PROBE_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 10000;
const CLOSE_SETTLE_TIMEOUT = 1500;

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
    clearResumeProbe();

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
      // Intentional session takeover: do not reconnect.
      stopReconnect();

      if (messageHandler) {
        messageHandler({ type: "session_replaced" });
      }
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

  if (messageHandler) {
    messageHandler({ type: "connection_lost" });
  }

  // Change generation before closing the old socket.
  // Its late events must not affect the replacement.
  openSocket(true);

  if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
    try {
      oldSocket.close();
    } catch (_) { }
  }
}

function checkConnectionOnResume() {
  if (!savedToken) return;

  // A reconnect timer may have been frozen in the background.
  // Reconnect immediately when the page becomes active again.
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    openSocket(true);
    return;
  }

  const sock = ws;
  if (!sock) return;

  // CONNECTING: check again after the remaining timeout.
  if (sock.readyState === WebSocket.CONNECTING) {
    const remaining = CONNECT_TIMEOUT - (Date.now() - connectingSince);

    if (remaining <= 0) {
      replaceUnresponsiveSocket();
      return;
    }

    clearResumeProbe();
    const gen = socketGeneration;

    resumeProbeTimer = setTimeout(() => {
      resumeProbeTimer = null;

      if (!savedToken || gen !== socketGeneration || ws !== sock) return;
      if (document.visibilityState === "hidden") return;

      if (sock.readyState === WebSocket.CONNECTING) {
        replaceUnresponsiveSocket();
      }
    }, remaining);

    return;
  }

  // CLOSING/CLOSED: allow the normal close event to arrive first.
  // In particular, code 4001 must keep its takeover behavior.
  if (
    sock.readyState === WebSocket.CLOSING ||
    sock.readyState === WebSocket.CLOSED
  ) {
    clearResumeProbe();
    const gen = socketGeneration;

    resumeProbeTimer = setTimeout(() => {
      resumeProbeTimer = null;

      if (!savedToken || gen !== socketGeneration || ws !== sock) return;
      if (document.visibilityState === "hidden") return;

      if (
        sock.readyState === WebSocket.CLOSING ||
        sock.readyState === WebSocket.CLOSED
      ) {
        replaceUnresponsiveSocket();
      }
    }, CLOSE_SETTLE_TIMEOUT);

    return;
  }

  // OPEN: a mobile browser may report OPEN even when the
  // connection is no longer responsive. Probe the server.
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

// Mobile browsers may suspend timers and WebSocket events.
// Check when returning to the foreground or restoring a page.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkConnectionOnResume();
  }
});

window.addEventListener("pageshow", checkConnectionOnResume);

export function connectWS(token, onMessage, getReconnectContext = null) {
  savedToken = token;
  messageHandler = onMessage;
  reconnectContextProvider = getReconnectContext;

  // Manual login does not carry resume fields.
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