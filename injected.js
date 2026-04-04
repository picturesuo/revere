(function () {
  const eventName =
    document.currentScript?.dataset?.eventName || "website-updater-network-message";

  hookWebSocket(eventName);
  hookEventSource(eventName);
})();

function hookWebSocket(eventName) {
  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) {
    return;
  }

  window.WebSocket = function WebsiteUpdaterWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    socket.addEventListener("message", (event) => {
      emitNetworkEvent(eventName, {
        transport: "websocket",
        url: args[0] || "",
        payload: stringifyPayload(event.data)
      });
    });
    return socket;
  };

  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
}

function hookEventSource(eventName) {
  const NativeEventSource = window.EventSource;
  if (!NativeEventSource) {
    return;
  }

  window.EventSource = function WebsiteUpdaterEventSource(...args) {
    const source = new NativeEventSource(...args);
    source.addEventListener("message", (event) => {
      emitNetworkEvent(eventName, {
        transport: "eventsource",
        url: args[0] || "",
        payload: stringifyPayload(event.data)
      });
    });
    return source;
  };

  window.EventSource.prototype = NativeEventSource.prototype;
  Object.setPrototypeOf(window.EventSource, NativeEventSource);
}

function emitNetworkEvent(eventName, detail) {
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail
    })
  );
}

function stringifyPayload(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return `[arraybuffer:${payload.byteLength}]`;
  }

  if (ArrayBuffer.isView(payload)) {
    return `[typedarray:${payload.byteLength}]`;
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return String(payload);
  }
}
