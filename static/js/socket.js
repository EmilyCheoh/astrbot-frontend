/* ================================================================
   Den — WebSocket Connection
   Pure transport layer — NO UI knowledge.
   Exposes connect(token, onMessage), send(payload), isConnected().

   Generation tracking: each connectWS() call increments a local
   counter.  Callbacks from stale sockets (whose generation no longer
   matches) are silently dropped — prevents a replaced connection's
   late onclose/onmessage from corrupting global state.

   Close code 4001: server-initiated session replacement.  Clears
   the saved token, cancels any pending reconnect timer, and does
   NOT schedule a new reconnect.  The message handler receives a
   synthetic {type: "session_replaced"} so the UI can react.
   ================================================================ */

let ws = null;
let savedToken = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let messageHandler = null;
let socketGeneration = 0;

function scheduleReconnect() {
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Re-check: token may have been cleared while the timer was pending
    if (!savedToken) return;
    connectWS(savedToken, messageHandler);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  }, reconnectDelay);
}

export function connectWS(token, onMessage) {
  savedToken = token;
  messageHandler = onMessage;

  const gen = ++socketGeneration;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;

  sock.onopen = () => {
    if (gen !== socketGeneration) return;
    sock.send(JSON.stringify({ type: "auth", token: savedToken }));
    reconnectDelay = 1000;
  };

  sock.onmessage = (evt) => {
    if (gen !== socketGeneration) return;
    const data = JSON.parse(evt.data);
    if (messageHandler) messageHandler(data);
  };

  sock.onclose = (event) => {
    if (gen !== socketGeneration) return;

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
      scheduleReconnect();
    }
  };

  sock.onerror = () => {};
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
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
