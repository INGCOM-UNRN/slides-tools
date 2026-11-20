/**
 * Google Slides Bridge - Content Script: Ventana de Vista de Orador (Speaker Notes Popup)
 * Extracción de notas ricas, temporizador nativo e inyección de toolbar de diagnóstico
 */

(function () {
  "use strict";

  // La vista del orador es un popup about:blank que Slides escribe desde la pestaña principal
  // (el manifiesto inyecta ahí con match_about_blank). En la pestaña principal este script no
  // hace nada: antes registraba igual sus listeners y cada segundo informaba «diapositiva 1/1,
  // modo orador», pisando lo que reportaba content-present.js.
  function isPresenterWindow() {
    return window.location.protocol === "about:" ||
      window.location.href.includes("presenter") ||
      Boolean(document.querySelector(".punch-speaker-notes-text"));
  }

  let isInitialized = false;
  let daemonConnected = false;
  let currentPin = "----";
  let currentClientsCount = 0;
  let connState = "desconectado";
  let connStateHasta = 0;
  let lastCommand = null;
  let lastCommandShownAt = 0;
  let speakerDockElement = null;
  let observer = null;

  function initSpeakerNotes() {
    if (isInitialized) return;
    if (!isPresenterWindow()) return;
    isInitialized = true;

    chrome.runtime.onMessage.addListener(onBackgroundMessage);
    ensureSpeakerDock();
    reportSpeakerStateToBackground();

    // Consultar estado inicial
    chrome.runtime.sendMessage({ type: "GET_DAEMON_INFO" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      applyDaemonStatus(res);
    });

    setInterval(() => {
      ensureSpeakerDock();
      reportSpeakerStateToBackground();
      updateSpeakerDockUI(); // refresca «hace N s» y las cuentas regresivas
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Extracción de Notas y Temporizador Nativo (Sección 5.2)
  // ---------------------------------------------------------------------------

  function extractSpeakerNotes() {
    const notesEl = document.querySelector(".punch-speaker-notes-text");
    if (!notesEl) {
      return { hasNotes: false, currentSlideNotes: "" };
    }
    const cleanText = notesEl.innerText ? notesEl.innerText.trim() : "";
    return {
      hasNotes: cleanText.length > 0,
      currentSlideNotes: cleanText
    };
  }

  function extractNativeTimer() {
    const timerEl = document.querySelector(".punch-speaker-notes-timer-value");
    if (!timerEl) {
      return { elapsedSeconds: 0, formattedTime: "00:00", isPaused: false };
    }

    const formatted = timerEl.textContent.trim() || "00:00";
    const parts = formatted.split(":").map((p) => parseInt(p, 10));
    let seconds = 0;
    if (parts.length === 2) {
      seconds = (parts[0] || 0) * 60 + (parts[1] || 0);
    } else if (parts.length === 3) {
      seconds = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    }

    // Comprobar si el botón de pausa está en estado pausado o detenido
    const pauseBtn = document.querySelector(
      'button[aria-label*="Pause" i], button[aria-label*="Pausa" i], button[aria-label*="Resume" i], button[aria-label*="Reanudar" i]'
    );
    const label = (pauseBtn?.getAttribute("aria-label") || "").toLowerCase();
    const isPaused = label.includes("reanudar") || label.includes("resume");

    return {
      elapsedSeconds: seconds,
      formattedTime: formatted,
      isPaused: isPaused
    };
  }

  function reportSpeakerStateToBackground() {
    const data = {
      isPresenting: true,
      presentationMode: "presenter_view",
      speakerNotes: extractSpeakerNotes(),
      timer: extractNativeTimer()
    };

    // Número de diapositiva en la vista de orador: sólo si se encontró, para no pisar
    // con 1/1 el dato que informa la pestaña de la presentación.
    const slideInfo = document.querySelector(".punch-viewer-speaker-slide-info");
    const m = slideInfo?.textContent?.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      data.currentSlide = parseInt(m[1], 10);
      data.totalSlides = parseInt(m[2], 10);
    }

    chrome.runtime.sendMessage({
      type: "UPDATE_PRESENTATION_STATE",
      role: "speaker",
      data: data
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Control de Temporizador Nativo
  // ---------------------------------------------------------------------------

  function handleTimerReset() {
    const resetBtn = document.querySelector(
      'button[aria-label*="Reset" i], button[aria-label*="Reiniciar" i]'
    );
    if (resetBtn) {
      resetBtn.click();
      return true;
    }
    return false;
  }

  function handleTimerTogglePause() {
    const pauseBtn = document.querySelector(
      'button[aria-label*="Pause" i], button[aria-label*="Pausa" i], button[aria-label*="Resume" i], button[aria-label*="Reanudar" i]'
    );
    if (pauseBtn) {
      pauseBtn.click();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Barra Superior en Vista de Orador (Sección 3.2)
  // ---------------------------------------------------------------------------

  const NOMBRES_COMANDO = {
    NEXT_SLIDE: "Siguiente",
    PREV_SLIDE: "Anterior",
    FIRST_SLIDE: "Primera diapositiva",
    LAST_SLIDE: "Última diapositiva",
    GO_TO_SLIDE: "Ir a diapositiva",
    TOGGLE_BLACKOUT: "Pantalla negra",
    TOGGLE_WHITEOUT: "Pantalla blanca",
    TOGGLE_LASER: "Puntero láser",
    TIMER_RESET: "Reiniciar cronómetro",
    TIMER_TOGGLE_PAUSE: "Pausar/reanudar cronómetro"
  };

  function segundosHasta(ms) {
    return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  }

  function textoEstado() {
    switch (connState) {
      case "emparejado":
        return { texto: "Conectado al daemon", clase: "ok" };
      case "conectando":
        return { texto: "Emparejando…", clase: "pendiente" };
      case "sin_pin":
        return { texto: "Falta configurar el PIN", clase: "error" };
      case "pin_rechazado":
        return { texto: "PIN rechazado: revisalo", clase: "error" };
      case "bloqueado":
        return { texto: `Bloqueado por intentos fallidos · reintento en ${segundosHasta(connStateHasta)} s`, clase: "error" };
      default: {
        const s = segundosHasta(connStateHasta);
        return { texto: s > 0 ? `Sin daemon · reintento en ${s} s` : "Sin daemon", clase: "error" };
      }
    }
  }

  function textoUltimoComando() {
    if (!lastCommand) return { texto: "Último comando: —", titulo: "", clase: "" };

    let nombre = NOMBRES_COMANDO[lastCommand.action] || lastCommand.action;
    if (lastCommand.action === "GO_TO_SLIDE" && lastCommand.args?.slideNumber) {
      nombre += ` ${lastCommand.args.slideNumber}`;
    }
    const o = lastCommand.origin;
    const origen = o ? ` · ${o.clientName || "?"}${o.deviceType ? ` (${o.deviceType})` : ""}` : "";
    const hace = Math.max(0, Math.round((Date.now() - lastCommand.receivedAt) / 1000));

    let resultado = "";
    let clase = "";
    if (lastCommand.status === "pending") {
      resultado = "…";
      clase = "pendiente";
    } else if (lastCommand.status === "ok") {
      resultado = "✓";
      clase = "ok";
    } else if (lastCommand.status === "unconfirmed") {
      resultado = "sin confirmar";
      clase = "pendiente";
    } else {
      resultado = `✗ ${lastCommand.details || lastCommand.status}`;
      clase = "error";
    }

    return {
      texto: `Último comando: ${nombre}${origen} · hace ${hace} s · ${resultado}`,
      titulo: lastCommand.details ? `Detalle: ${lastCommand.details}` : "",
      clase: clase
    };
  }

  function ensureSpeakerDock() {
    // Slides puede reescribir el documento del popup (document.open/write) y borrar la barra.
    if (speakerDockElement && speakerDockElement.isConnected) return;
    if (!document.body) return;

    speakerDockElement = document.createElement("div");
    speakerDockElement.className = "slide-bridge-speaker-dock";
    speakerDockElement.id = "slide-bridge-speaker-dock";

    const leftGroup = document.createElement("div");
    leftGroup.className = "left-group";

    const dot = document.createElement("span");
    dot.className = "slide-bridge-dot";
    dot.id = "speaker-bridge-dot";

    const titleStrong = document.createElement("strong");
    titleStrong.textContent = "Slides Bridge";

    const estadoSpan = document.createElement("span");
    estadoSpan.className = "slide-bridge-estado";
    estadoSpan.id = "speaker-bridge-estado";

    leftGroup.appendChild(dot);
    leftGroup.appendChild(titleStrong);
    leftGroup.appendChild(estadoSpan);

    const centerGroup = document.createElement("div");
    centerGroup.className = "center-group";

    const ultimoSpan = document.createElement("span");
    ultimoSpan.className = "slide-bridge-ultimo-comando";
    ultimoSpan.id = "speaker-bridge-ultimo";
    centerGroup.appendChild(ultimoSpan);

    const rightGroup = document.createElement("div");
    rightGroup.className = "right-group";

    const clientsSpan = document.createElement("span");
    clientsSpan.id = "speaker-bridge-clients";

    const pinBadge = document.createElement("span");
    pinBadge.className = "slide-bridge-pin-badge";
    pinBadge.id = "speaker-bridge-pin";
    pinBadge.title = "Hacé click para cambiar o indicar el PIN";
    pinBadge.onclick = showSpeakerPinModal;

    rightGroup.appendChild(clientsSpan);
    rightGroup.appendChild(pinBadge);

    speakerDockElement.appendChild(leftGroup);
    speakerDockElement.appendChild(centerGroup);
    speakerDockElement.appendChild(rightGroup);

    document.body.prepend(speakerDockElement);
    document.body.style.paddingTop = "38px";

    setupObservers();
    updateSpeakerDockUI();
  }

  function updateSpeakerDockUI() {
    const dot = document.getElementById("speaker-bridge-dot");
    if (dot) {
      dot.className = "slide-bridge-dot" + (connState === "emparejado" ? "" : " disconnected");
    }
    const estado = document.getElementById("speaker-bridge-estado");
    if (estado) {
      const e = textoEstado();
      estado.textContent = e.texto;
      estado.className = `slide-bridge-estado ${e.clase}`;
    }
    const ultimo = document.getElementById("speaker-bridge-ultimo");
    if (ultimo) {
      const u = textoUltimoComando();
      ultimo.textContent = u.texto;
      ultimo.title = u.titulo;
      ultimo.className = `slide-bridge-ultimo-comando ${u.clase}`;
    }
    const clients = document.getElementById("speaker-bridge-clients");
    if (clients) {
      clients.textContent = `${currentClientsCount} disp. conectados`;
    }
    const pin = document.getElementById("speaker-bridge-pin");
    if (pin) {
      pin.textContent = (currentPin && currentPin !== "----") ? `PIN: ${currentPin}` : "Configurar PIN";
    }
  }

  function flashUltimoComando() {
    const ultimo = document.getElementById("speaker-bridge-ultimo");
    if (!ultimo) return;
    ultimo.classList.add("slide-bridge-command-flash");
    setTimeout(() => ultimo.classList.remove("slide-bridge-command-flash"), 400);
  }

  function applyDaemonStatus(msg) {
    daemonConnected = Boolean(msg.isConnected ?? msg.connected);
    currentPin = msg.pin || "----";
    currentClientsCount = msg.clientsCount || 0;
    if (msg.connState) connState = msg.connState;
    connStateHasta = msg.connStateHasta || 0;
    if (msg.lastCommand !== undefined) {
      lastCommand = msg.lastCommand;
      if (lastCommand && lastCommand.receivedAt !== lastCommandShownAt) {
        lastCommandShownAt = lastCommand.receivedAt;
        updateSpeakerDockUI();
        flashUltimoComando();
        return;
      }
    }
    updateSpeakerDockUI();
  }

  function showSpeakerPinModal() {
    let backdrop = document.getElementById("slide-bridge-speaker-pin-modal");
    if (backdrop) return;

    backdrop = document.createElement("div");
    backdrop.id = "slide-bridge-speaker-pin-modal";
    backdrop.className = "slide-bridge-qr-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "slide-bridge-qr-modal";

    const h3 = document.createElement("h3");
    h3.textContent = "Configurar PIN del Daemon";

    const desc = document.createElement("p");
    desc.style.fontSize = "12px";
    desc.style.color = "#bdc1c6";
    desc.textContent = "Ingresá el PIN requerido generado por el daemon para emparejar la extensión.";

    const pinForm = document.createElement("div");
    pinForm.className = "slide-bridge-pin-form";

    const row = document.createElement("div");
    row.className = "slide-bridge-pin-input-row";

    const pinInput = document.createElement("input");
    pinInput.type = "text";
    pinInput.className = "slide-bridge-pin-input";
    pinInput.placeholder = "Ej: 123456";
    pinInput.maxLength = 12;
    pinInput.value = (currentPin && currentPin !== "----") ? currentPin : "";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "slide-bridge-save-pin-btn";
    saveBtn.textContent = "Guardar PIN";

    const statusMsg = document.createElement("div");
    statusMsg.className = "slide-bridge-pin-status";

    saveBtn.onclick = () => {
      const val = pinInput.value.trim();
      if (!val) {
        statusMsg.textContent = "El PIN no puede estar vacío";
        statusMsg.className = "slide-bridge-pin-status error";
        pinInput.focus();
        return;
      }

      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ daemonPin: val }, () => {
          currentPin = val;
          updateSpeakerDockUI();
          statusMsg.textContent = "PIN guardado. Reconectando...";
          statusMsg.className = "slide-bridge-pin-status success";

          chrome.runtime.sendMessage({
            type: "CONFIG_UPDATED",
            pin: val
          }).catch(() => {});
        });
      } else {
        currentPin = val;
        updateSpeakerDockUI();
        statusMsg.textContent = "PIN actualizado.";
        statusMsg.className = "slide-bridge-pin-status success";
      }
    };

    row.appendChild(pinInput);
    row.appendChild(saveBtn);
    pinForm.appendChild(row);
    pinForm.appendChild(statusMsg);

    const closeBtn = document.createElement("button");
    closeBtn.className = "slide-bridge-close-btn";
    closeBtn.textContent = "Cerrar";
    closeBtn.onclick = () => backdrop.remove();

    modal.appendChild(h3);
    modal.appendChild(desc);
    modal.appendChild(pinForm);
    modal.appendChild(closeBtn);
    backdrop.appendChild(modal);

    document.body.appendChild(backdrop);
    pinInput.focus();
  }

  function setupObservers() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      // Ignorar los cambios de la propia barra (si no, cada refresco dispara otro reporte).
      if (mutations.every((m) => speakerDockElement && speakerDockElement.contains(m.target))) return;
      reportSpeakerStateToBackground();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ---------------------------------------------------------------------------
  // Manejo de Mensajes desde Background
  // ---------------------------------------------------------------------------

  function onBackgroundMessage(msg, sender, sendResponse) {
    if (msg.type === "DAEMON_STATUS") {
      applyDaemonStatus(msg);
      sendResponse({ received: true });
      return true;
    }

    if (msg.action === "TIMER_RESET") {
      const ok = handleTimerReset();
      reportSpeakerStateToBackground();
      sendResponse(ok ? { status: "ok" } : { status: "failed", details: "button_not_found" });
      return true;
    }

    if (msg.action === "TIMER_TOGGLE_PAUSE") {
      const ok = handleTimerTogglePause();
      reportSpeakerStateToBackground();
      sendResponse(ok ? { status: "ok" } : { status: "failed", details: "button_not_found" });
      return true;
    }
    return false;
  }

  window.addEventListener("DOMContentLoaded", initSpeakerNotes);
  if (document.body) {
    initSpeakerNotes();
    // El popup puede no ser reconocible al cargar (notas todavía sin escribir).
    setTimeout(initSpeakerNotes, 500);
    setTimeout(initSpeakerNotes, 2000);
  }
})();
