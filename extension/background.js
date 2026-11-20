/**
 * Google Slides Remote Control Bridge - Background Service Worker
 * Versión 1.2
 */

let daemonHost = "127.0.0.1";
let daemonPort = 8766;
let daemonPin = "";
// Reconexión con espera exponencial (QoL #608): 1 s, 2 s, 4 s… hasta 30 s, con un poco de azar
// para no reintentar todos a la vez cuando vuelve la red del aula.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
let reconnectAttempts = 0;
let reconnectTimer = null;
// Si el daemon rechazó el PIN, reintentar con el mismo PIN sólo suma fallos: tras 5 en un
// minuto el daemon bloquea la IP y rechaza incluso el PIN correcto que se teclee después.
// Se espera a que llegue una configuración nueva (CONFIG_UPDATED) antes de volver a conectar.
let pinRechazado = false;

// Estado de la conexión con el daemon, para mostrarlo en las pestañas:
// sin_pin | conectando | emparejado | pin_rechazado | bloqueado | desconectado
let connState = "desconectado";
let connStateHasta = 0; // fin del bloqueo o momento del próximo reintento (ms epoch)

// Último comando recibido del daemon: qué, de quién, cuándo y cómo terminó.
let lastCommand = null;

// Pestañas con content script activo y su rol: "present" (presentación) o "speaker"
// (vista del orador). La vista del orador es un popup about:blank que tabs.query por URL
// no encuentra, así que se registran solas al reportar estado.
const bridgeTabs = new Map();
const TAB_VIVA_MS = 5000;
const ACCIONES_TEMPORIZADOR = new Set(["TIMER_RESET", "TIMER_TOGGLE_PAUSE"]);

function setConnState(estado, hasta = 0) {
  connState = estado;
  connStateHasta = hasta;
  notifyTabsConnectionStatus(isConnected, estado === "pin_rechazado" || estado === "bloqueado" || estado === "sin_pin");
}

function scheduleReconnect(delayMs) {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempts);
  const delay = delayMs ?? Math.round(base * (0.5 + Math.random() / 2));
  reconnectAttempts += 1;
  console.log(`[SlideBridge] Reconectando en ${Math.ceil(delay / 1000)} s (intento ${reconnectAttempts}).`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, delay);
  return Date.now() + delay;
}

let ws = null;
let isConnected = false;
let currentSessionState = {
  presentationTitle: "",
  isPresenting: false,
  presentationMode: "standard",
  currentSlide: 1,
  totalSlides: 1,
  isBlackout: false,
  isWhiteout: false,
  isLaserActive: false,
  timer: { elapsedSeconds: 0, formattedTime: "00:00", isPaused: false },
  speakerNotes: { hasNotes: false, currentSlideNotes: "" },
  connectedClients: 0,
  pin: ""
};

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  // Cada conexión nueva (configuración nueva o reintento tras un bloqueo) parte de cero.
  pinRechazado = false;
  if (!daemonPin) {
    isConnected = false;
    currentSessionState.pin = "----";
    console.log("[SlideBridge] Conexión en espera: PIN no configurado.");
    setConnState("sin_pin");
    return;
  }

  const wsUrl = `ws://${daemonHost}:${daemonPort}`;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    setConnState("desconectado", scheduleReconnect());
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    reconnectAttempts = 0;
    console.log("[SlideBridge] Conectado al daemon en", wsUrl);

    // Enviar solicitud de emparejamiento con PIN obligatorio
    const pairMsg = {
      version: "1.2",
      sessionId: "default",
      source: "extension",
      type: "command",
      action: "PAIR_REQUEST",
      payload: {
        pin: daemonPin,
        deviceType: "extension",
        clientName: "Google Slides Extension"
      }
    };
    ws.send(JSON.stringify(pairMsg));

    // Enviar estado inicial
    sendStateSync();
    setConnState("conectando");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleDaemonMessage(msg);
    } catch (e) {
      console.warn("[SlideBridge] Error procesando mensaje de daemon:", e);
    }
  };

  ws.onclose = () => {
    isConnected = false;
    ws = null;
    if (pinRechazado) {
      // El estado (pin_rechazado / bloqueado) ya quedó fijado al recibir el error.
      notifyTabsConnectionStatus(false, true, "ERR_INVALID_PIN");
    } else if (daemonPin) {
      setConnState("desconectado", scheduleReconnect());
    } else {
      setConnState("sin_pin");
    }
  };

  ws.onerror = () => {
    if (ws) ws.close();
  };
}

function sendStateSync() {
  if (!ws || !isConnected) return;
  const msg = {
    version: "1.2",
    sessionId: "default",
    source: "extension",
    type: "state",
    action: "STATE_SYNC",
    payload: currentSessionState
  };
  ws.send(JSON.stringify(msg));
}

function estadoParaPestanas(connected, requirePin, errorMsg) {
  return {
    type: "DAEMON_STATUS",
    connected: connected,
    pin: currentSessionState.pin || daemonPin || "----",
    clientsCount: currentSessionState.connectedClients,
    requirePin: requirePin,
    errorMsg: errorMsg,
    connState: connState,
    connStateHasta: connStateHasta,
    lastCommand: lastCommand
  };
}

function notifyTabsConnectionStatus(connected, requirePin = false, errorMsg = "") {
  const msg = estadoParaPestanas(connected, requirePin, errorMsg);
  chrome.tabs.query({ url: "*://docs.google.com/presentation/*" }, (tabs) => {
    const ids = new Set((tabs || []).map((t) => t.id));
    for (const id of bridgeTabs.keys()) ids.add(id);
    ids.forEach((id) => {
      chrome.tabs.sendMessage(id, msg).catch(() => {});
    });
  });
}

function handleDaemonMessage(msg) {
  if (msg.type === "error" && msg.payload?.code === "ERR_INVALID_PIN") {
    isConnected = false;
    pinRechazado = true;
    console.warn("[SlideBridge] Daemon rechazó el PIN:", msg.payload?.reason,
      "- no se reintenta hasta configurar el PIN de nuevo.");
    const retryAfter = Number(msg.payload?.retryAfter);
    if (retryAfter > 0) {
      // Bloqueo por intentos fallidos (quizás de otro dispositivo de la misma IP): un único
      // reintento al terminar. Si el PIN es el equivocado, suma un fallo por minuto y nunca
      // vuelve a llegar al límite.
      setConnState("bloqueado", scheduleReconnect((retryAfter + 1) * 1000));
    } else {
      setConnState("pin_rechazado");
    }
    if (ws) ws.close();
    return;
  }

  if (msg.action === "PAIRING_SUCCESS") {
    setConnState("emparejado");
    return;
  }

  if (msg.action === "STATE_SYNC") {
    if (msg.payload.pin) currentSessionState.pin = msg.payload.pin;
    if (typeof msg.payload.connectedClients === "number") {
      currentSessionState.connectedClients = msg.payload.connectedClients;
    }
    notifyTabsConnectionStatus(isConnected);
    return;
  }

  if (msg.type === "command") {
    const reqId = msg.payload?.requestId;
    const { requestId, origin, ...args } = msg.payload || {};
    lastCommand = {
      action: msg.action,
      args: args,
      origin: origin || null,
      receivedAt: Date.now(),
      status: "pending",
      details: ""
    };
    notifyTabsConnectionStatus(isConnected);
    pestanasPara(msg.action, (tabIds) => dispatchCommandToTabs(tabIds, msg, reqId));
  }
}

function pestanasVivas(rol) {
  const ahora = Date.now();
  const vivas = [];
  for (const [id, t] of bridgeTabs) {
    if (ahora - t.lastSeen > TAB_VIVA_MS) {
      bridgeTabs.delete(id);
    } else if (t.role === rol) {
      vivas.push([id, t]);
    }
  }
  return vivas;
}

// Comandos de diapositiva → pestaña de la presentación (la que está presentando, si hay);
// temporizador → vista del orador. Antes iban a la pestaña activa de cada ventana: con dos
// presentaciones abiertas avanzaban las dos, y el temporizador nunca llegaba al popup.
function pestanasPara(action, cb) {
  const rol = ACCIONES_TEMPORIZADOR.has(action) ? "speaker" : "present";
  const vivas = pestanasVivas(rol);
  if (rol === "present") {
    const presentando = vivas.filter(([, t]) => t.isPresenting);
    if (presentando.length > 0) {
      cb(presentando.map(([id]) => id));
      return;
    }
  }
  if (vivas.length > 0) {
    cb(vivas.map(([id]) => id));
    return;
  }
  // Sin registro todavía (el service worker recién despertó): todas las pestañas de Slides.
  chrome.tabs.query({ url: "*://docs.google.com/presentation/*" }, (tabs) => {
    cb((tabs || []).map((t) => t.id));
  });
}

function terminarComando(msg, status, details) {
  if (lastCommand && lastCommand.action === msg.action && lastCommand.status === "pending") {
    lastCommand.status = status;
    lastCommand.details = details || "";
    notifyTabsConnectionStatus(isConnected);
  }
}

function dispatchCommandToTabs(tabIds, msg, reqId) {
  if (!tabIds || tabIds.length === 0) {
    sendAck(msg.action, "failed", "No hay pestañas de Google Slides abiertas", reqId);
    terminarComando(msg, "failed", "No hay pestañas de Google Slides abiertas");
    return;
  }

  let handled = false;
  tabIds.forEach((id) => {
    // Sólo responde el content script que ejecutó el comando; los demás no contestan.
    chrome.tabs.sendMessage(id, msg, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && !handled) {
        handled = true;
        sendAck(msg.action, response.status || "ok", response.details, reqId);
        terminarComando(msg, response.status || "ok", response.details);
      }
    });
  });

  // Timeout de respaldo por si ningún tab respondió explícitamente
  setTimeout(() => {
    if (!handled) {
      sendAck(msg.action, "ok", "dispatched_to_tabs", reqId);
      terminarComando(msg, "unconfirmed", "ninguna pestaña confirmó");
    }
  }, 350);
}

function sendAck(action, status, details, requestId) {
  if (!ws || !isConnected) return;
  const ack = {
    version: "1.2",
    sessionId: "default",
    source: "extension",
    type: "ack",
    action: action,
    payload: {
      action: action,
      status: status,
      details: details,
      requestId: requestId
    }
  };
  ws.send(JSON.stringify(ack));
}

function registrarPestana(sender, role, data) {
  const id = sender?.tab?.id;
  if (id === undefined || (role !== "present" && role !== "speaker")) return;
  bridgeTabs.set(id, {
    role: role,
    isPresenting: Boolean(data?.isPresenting),
    lastSeen: Date.now()
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  bridgeTabs.delete(tabId);
});

// Escuchar mensajes internos desde los Content Scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "UPDATE_PRESENTATION_STATE") {
    registrarPestana(sender, message.role, message.data);
    Object.assign(currentSessionState, message.data);
    // Con la vista del orador abierta se está presentando en modo orador, aunque la pestaña
    // principal no lo detecte: si no, el modo alterna cada segundo entre los dos reportes.
    if (pestanasVivas("speaker").length > 0) {
      currentSessionState.isPresenting = true;
      currentSessionState.presentationMode = "presenter_view";
    } else {
      currentSessionState.presentationMode = currentSessionState.isPresenting ? "standard" : "edit";
    }
    sendStateSync();
    sendResponse({ received: true });
    return true;
  }
  if (message.type === "GET_DAEMON_INFO") {
    sendResponse({
      isConnected: isConnected,
      pin: currentSessionState.pin || daemonPin,
      clientsCount: currentSessionState.connectedClients,
      connState: connState,
      connStateHasta: connStateHasta,
      lastCommand: lastCommand
    });
    return true;
  }
  if (message.type === "GET_CONFIG_STATUS") {
    sendResponse({
      isConnected: isConnected,
      host: daemonHost,
      port: daemonPort,
      pin: daemonPin,
      clientsCount: currentSessionState.connectedClients
    });
    return true;
  }
  if (message.type === "CONFIG_UPDATED") {
    daemonHost = message.host || daemonHost;
    daemonPort = parseInt(message.port, 10) || daemonPort;
    daemonPin = message.pin !== undefined ? String(message.pin).trim() : daemonPin;
    currentSessionState.pin = daemonPin;
    pinRechazado = false;
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);
    console.log("[SlideBridge] Nueva configuración recibida. Reconectando a", daemonHost, daemonPort);
    if (ws) {
      ws.close();
    } else {
      connectWebSocket();
    }
    sendResponse({ status: "ok" });
    return true;
  }
});

function loadConfigAndConnect() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(["daemonHost", "daemonPort", "daemonPin"], (res) => {
      if (chrome.runtime.lastError || !res) {
        connectWebSocket();
        return;
      }
      if (res.daemonHost) daemonHost = res.daemonHost.trim();
      if (res.daemonPort) daemonPort = parseInt(res.daemonPort, 10);
      if (res.daemonPin !== undefined) daemonPin = String(res.daemonPin).trim();
      connectWebSocket();
    });
  } else {
    connectWebSocket();
  }
}

loadConfigAndConnect();
