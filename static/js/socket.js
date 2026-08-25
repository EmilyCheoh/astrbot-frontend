/* ================================================================
   Den — WebSocket Connection
   Pure transport layer — NO UI knowledge.
   Exposes connect(token, onMessage), send(payload), isConnected().
   ================================================================ */

let ws = null;
let savedToken = null;
let reconnectDelay = 1000;
let reconnecting = false;
let messageHandler = null;

function scheduleReconnect() {
  reconnecting = true;
  setTimeout(() => {
    reconnecting = false;
    connectWS(savedToken, messageHandler);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  }, reconnectDelay);
}

export function connectWS(token, onMessage) {
  savedToken = token;
  messageHandler = onMessage;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", token: savedToken }));
    reconnectDelay = 1000;
  };

  ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (messageHandler) messageHandler(data);
  };

  ws.onclose = () => {
    if (savedToken && !reconnecting) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {};
}

export function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
