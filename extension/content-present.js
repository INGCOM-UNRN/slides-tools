/**
 * Google Slides Bridge - Content Script: Pantalla Principal de Proyección
 * Inyección de eventos de teclado y Mini-Dock retráctil
 */

(function () {
  "use strict";

  // La vista del orador es un popup about:blank que Slides escribe desde la pestaña principal
  // (el manifiesto inyecta ahí con match_about_blank). Ese contexto es de content-speaker.js:
  // si este script también respondiera, cada comando se aplicaría dos veces.
  if (window.location.protocol === "about:" || window.location.href.includes("presenter") ||
      document.querySelector(".punch-speaker-notes-text")) {
    return;
  }

  let daemonConnected = false;
  let currentPin = "----";
  let currentClientsCount = 0;
  let miniDockElement = null;

  // ---------------------------------------------------------------------------
  // 5.1. Inyección de Comandos Sintéticos de Teclado
  // ---------------------------------------------------------------------------

  // Al presentar desde el editor, Slides no cambia de URL: dibuja la presentación en un iframe
  // del mismo origen y escucha el teclado dentro de él. Un evento despachado en el documento
  // principal nunca llega a esos manejadores: por eso los comandos no hacían nada en modo
  // presentación. En /present (pestaña propia) no hay iframe y se usa el documento principal.
  const SELECTOR_IFRAME_PRESENTACION =
    "iframe.punch-present-iframe, .punch-present-iframe iframe, iframe[class*='punch-present']";

  function iframePresentacion() {
    for (const f of document.querySelectorAll(SELECTOR_IFRAME_PRESENTACION)) {
      // Slides puede dejar el iframe oculto al salir de la presentación.
      if (f.offsetWidth === 0 && f.offsetHeight === 0) continue;
      try {
        const doc = f.contentDocument;
        if (doc && doc.body) return { frame: f, doc: doc };
      } catch (e) {
        // De otro origen: inaccesible, se sigue con el siguiente.
      }
    }
    return null;
  }

  function documentoDestino() {
    const ifr = iframePresentacion();
    if (ifr) return { doc: ifr.doc, donde: "iframe_presentacion" };
    return { doc: document, donde: "documento" };
  }

  function dispatchPresentationKey(doc, code, key, keyCode) {
    const active = doc.activeElement;
    const target = active && active !== doc.documentElement ? active : (doc.body || doc);
    // Sin `view`: el evento se crea en este contexto y se despacha en el del iframe.
    const eventData = {
      key: key,
      code: code,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    target.dispatchEvent(new KeyboardEvent("keydown", eventData));
    // Una tecla real con carácter también genera keypress, y hay manejadores que sólo miran ése.
    if (key.length === 1) {
      target.dispatchEvent(new KeyboardEvent("keypress", { ...eventData, charCode: key.charCodeAt(0) }));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", eventData));
  }

  const TECLAS = {
    NEXT_SLIDE: ["ArrowRight", "ArrowRight", 39],
    PREV_SLIDE: ["ArrowLeft", "ArrowLeft", 37],
    FIRST_SLIDE: ["Home", "Home", 36],
    LAST_SLIDE: ["End", "End", 35],
    TOGGLE_BLACKOUT: ["KeyB", "b", 66],
    TOGGLE_WHITEOUT: ["KeyW", "w", 87],
    TOGGLE_LASER: ["KeyL", "l", 76]
  };

  /** Ejecuta el comando; null si no es de esta pestaña (p. ej. temporizador). */
  function handleCommand(msg) {
    const act = msg.action;
    const { doc, donde } = documentoDestino();

    if (TECLAS[act]) {
      dispatchPresentationKey(doc, ...TECLAS[act]);
    } else if (act === "GO_TO_SLIDE") {
      const targetSlide = parseInt(msg.payload?.slideNumber, 10);
      if (!(targetSlide > 0)) {
        return { status: "failed", details: "slideNumber inválido" };
      }
      for (const digit of String(targetSlide)) {
        dispatchPresentationKey(doc, `Digit${digit}`, digit, 48 + parseInt(digit, 10));
      }
      dispatchPresentationKey(doc, "Enter", "Enter", 13);
    } else {
      return null;
    }

    // Flash visual sutil en el dock
    if (miniDockElement) {
      miniDockElement.classList.add("slide-bridge-command-flash");
      setTimeout(() => miniDockElement.classList.remove("slide-bridge-command-flash"), 400);
    }
    return { status: "ok", details: `teclado:${donde}` };
  }

  // ---------------------------------------------------------------------------
  // Extracción de Estado en Ventana Principal
  // ---------------------------------------------------------------------------

  function scrapePresentationState() {
    const ifr = iframePresentacion();
    const data = {
      presentationTitle: document.title
        .replace(/ - Google Slides$/, "")
        .replace(/ - Presentaciones de Google$/, "")
        .trim(),
      isPresenting: Boolean(ifr) || Boolean(document.fullscreenElement) ||
        window.location.href.includes("/present") || window.location.href.includes("/fullscreen")
    };

    // El número de diapositiva está en el visor: dentro del iframe al presentar desde el editor.
    // Sólo se informa si se encontró; antes se mandaba 1/1 y pisaba el dato de la vista del orador.
    const docs = ifr ? [ifr.doc, document] : [document];
    for (const doc of docs) {
      const slideInput = doc.querySelector("input.punch-viewer-slide-number-input");
      if (!slideInput) continue;
      const actual = parseInt(slideInput.value, 10);
      if (actual > 0) data.currentSlide = actual;
      const m = (slideInput.parentElement?.textContent || "").match(/\/\s*(\d+)/);
      if (m) data.totalSlides = parseInt(m[1], 10);
      break;
    }
    return data;
  }

  function reportStateToBackground() {
    chrome.runtime.sendMessage({
      type: "UPDATE_PRESENTATION_STATE",
      role: "present",
      data: scrapePresentationState()
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Mini-Dock Retráctil (Sección 3.1)
  // ---------------------------------------------------------------------------

  function renderMiniDock() {
    if (miniDockElement) return;

    miniDockElement = document.createElement("div");
    miniDockElement.className = "slide-bridge-mini-dock";
    miniDockElement.id = "slide-bridge-mini-dock";

    const dot = document.createElement("span");
    dot.className = "slide-bridge-dot" + (daemonConnected ? "" : " disconnected");
    dot.id = "slide-bridge-dot";

    const clientsText = document.createElement("span");
    clientsText.id = "slide-bridge-clients-label";
    clientsText.textContent = `${currentClientsCount} disp.`;

    const pinBadge = document.createElement("span");
    pinBadge.className = "slide-bridge-pin-badge";
    pinBadge.id = "slide-bridge-pin-badge";
    pinBadge.title = "Hacé click para configurar o cambiar el PIN";
    pinBadge.textContent = (currentPin && currentPin !== "----") ? `PIN: ${currentPin}` : "Configurar PIN";
    pinBadge.onclick = showQrModal;

    const qrBtn = document.createElement("button");
    qrBtn.className = "slide-bridge-qr-btn";
    qrBtn.textContent = "QR / PIN";
    qrBtn.onclick = showQrModal;

    miniDockElement.appendChild(dot);
    miniDockElement.appendChild(clientsText);
    miniDockElement.appendChild(pinBadge);
    miniDockElement.appendChild(qrBtn);

    document.body.appendChild(miniDockElement);
  }

  function updateMiniDockUI() {
    const dot = document.getElementById("slide-bridge-dot");
    if (dot) {
      dot.className = "slide-bridge-dot" + (daemonConnected ? "" : " disconnected");
    }
    const clients = document.getElementById("slide-bridge-clients-label");
    if (clients) {
      clients.textContent = `${currentClientsCount} disp.`;
    }
    const pin = document.getElementById("slide-bridge-pin-badge");
    if (pin) {
      pin.textContent = (currentPin && currentPin !== "----") ? `PIN: ${currentPin}` : "Configurar PIN";
    }
  }

  function showQrModal() {
    let modalBackdrop = document.getElementById("slide-bridge-qr-backdrop");
    if (modalBackdrop) return;

    modalBackdrop = document.createElement("div");
    modalBackdrop.id = "slide-bridge-qr-backdrop";
    modalBackdrop.className = "slide-bridge-qr-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "slide-bridge-qr-modal";

    const h3 = document.createElement("h3");
    h3.textContent = "Emparejamiento Remoto";

    const pinDesc = document.createElement("p");
    pinDesc.textContent = "PIN actual: ";
    const pinStrong = document.createElement("strong");
    pinStrong.style.color = "#fbbc04";
    pinStrong.style.fontSize = "18px";
    pinStrong.textContent = currentPin;
    pinDesc.appendChild(pinStrong);

    const box = document.createElement("div");
    box.className = "slide-bridge-qr-code-box";
    const qrSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    qrSvg.setAttribute("viewBox", "0 0 100 100");
    qrSvg.setAttribute("width", "160");
    qrSvg.setAttribute("height", "160");

    const addRect = (x, y, w, h, fill) => {
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", x);
      r.setAttribute("y", y);
      r.setAttribute("width", w);
      r.setAttribute("height", h);
      r.setAttribute("fill", fill);
      qrSvg.appendChild(r);
    };

    addRect("0", "0", "100", "100", "#ffffff");
    addRect("10", "10", "30", "30", "#000000");
    addRect("15", "15", "20", "20", "#ffffff");
    addRect("20", "20", "10", "10", "#000000");
    addRect("60", "10", "30", "30", "#000000");
    addRect("65", "15", "20", "20", "#ffffff");
    addRect("70", "20", "10", "10", "#000000");
    addRect("10", "60", "30", "30", "#000000");
    addRect("15", "65", "20", "20", "#ffffff");
    addRect("20", "70", "10", "10", "#000000");
    addRect("50", "50", "10", "10", "#000000");
    addRect("65", "65", "15", "15", "#000000");
    box.appendChild(qrSvg);

    // Formulario interactivo para ingresar o cambiar el PIN
    const pinForm = document.createElement("div");
    pinForm.className = "slide-bridge-pin-form";

    const pinLabel = document.createElement("label");
    pinLabel.textContent = "Indicar PIN del Daemon (Obligatorio)";

    const row = document.createElement("div");
    row.className = "slide-bridge-pin-input-row";

    const pinInput = document.createElement("input");
    pinInput.type = "text";
    pinInput.className = "slide-bridge-pin-input";
    pinInput.placeholder = "Ej: 1234";
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
        statusMsg.textContent = "Ingresá un PIN válido";
        statusMsg.className = "slide-bridge-pin-status error";
        pinInput.focus();
        return;
      }

      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ daemonPin: val }, () => {
          currentPin = val;
          pinStrong.textContent = val;
          updateMiniDockUI();
          statusMsg.textContent = "PIN guardado. Reconectando...";
          statusMsg.className = "slide-bridge-pin-status success";

          chrome.runtime.sendMessage({
            type: "CONFIG_UPDATED",
            pin: val
          }).catch(() => {});
        });
      } else {
        currentPin = val;
        pinStrong.textContent = val;
        updateMiniDockUI();
        statusMsg.textContent = "PIN actualizado.";
        statusMsg.className = "slide-bridge-pin-status success";
      }
    };

    row.appendChild(pinInput);
    row.appendChild(saveBtn);
    pinForm.appendChild(pinLabel);
    pinForm.appendChild(row);
    pinForm.appendChild(statusMsg);

    const closeBtn = document.createElement("button");
    closeBtn.className = "slide-bridge-close-btn";
    closeBtn.textContent = "Cerrar";
    closeBtn.onclick = () => modalBackdrop.remove();

    modal.appendChild(h3);
    modal.appendChild(pinDesc);
    modal.appendChild(box);
    modal.appendChild(pinForm);
    modal.appendChild(closeBtn);
    modalBackdrop.appendChild(modal);

    document.body.appendChild(modalBackdrop);
    pinInput.focus();
  }

  // ---------------------------------------------------------------------------
  // Escucha de Mensajes desde Background
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "DAEMON_STATUS") {
      daemonConnected = msg.connected;
      currentPin = msg.pin || "----";
      currentClientsCount = msg.clientsCount || 0;
      updateMiniDockUI();
      sendResponse({ received: true });
      return true;
    }

    if (msg.type === "command") {
      const res = handleCommand(msg);
      // Si no es de esta pestaña no se contesta: así responde la que sí lo ejecuta
      // (antes un «unhandled» de acá le ganaba al «ok» de la vista del orador).
      if (!res) return false;
      reportStateToBackground();
      sendResponse(res);
      return true;
    }
  });

  // Inicializar dock y sincronización periódica
  window.addEventListener("DOMContentLoaded", () => {
    renderMiniDock();
    reportStateToBackground();
  });
  if (document.body) {
    renderMiniDock();
  }

  // Consultar estado inicial a background
  chrome.runtime.sendMessage({ type: "GET_DAEMON_INFO" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    daemonConnected = res.isConnected;
    currentPin = res.pin || "----";
    currentClientsCount = res.clientsCount || 0;
    updateMiniDockUI();
  });

  setInterval(reportStateToBackground, 1000);
})();
