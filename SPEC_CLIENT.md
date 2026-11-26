# Especificación del cliente Android de slide-tools

| | |
|---|---|
| **Versión del documento** | 1.0 (2026-11-20) |
| **Daemon de referencia** | slide-tools 1.3.2 |
| **Protocolo** | JSON sobre WebSocket, `version: "1.2"` |
| **Plataforma** | Android 8.0+ (API 26), Kotlin 2.x, Jetpack Compose |

Este documento dice lo necesario para construir una app Android que controle Google Slides a
través del daemon de slide-tools. Describe el contrato **que el daemon implementa hoy**: cada
mensaje de ejemplo se capturó de un daemon 1.3.2 real. Lo que todavía no existe en el daemon se
marca como tal y se junta en la [sección 14](#14-brechas-del-daemon-y-trabajo-pendiente).

## Relación con otros documentos

- [`spec.md`](spec.md): arquitectura general del sistema (daemon, extensión, clientes).
- `cyberdeck/android-spec.md` (repositorio cyberdeck): visión de una app común para slide-tools y
  meet-tools, orientada a capacidades. **Describe un protocolo que slide-tools no implementa**
  (ver [§14.1](#141-diferencias-con-cyberdeckandroid-specmd)). Una app que siga solamente esa
  especificación no se conecta a este daemon.
- `tests/test_contrato_cyberdeck.py`: fija el puerto, el servicio mDNS y el URI de emparejamiento.
  Si este documento y ese test discrepan, manda el test.

Las palabras **DEBE**, **NO DEBE**, **DEBERÍA** y **PUEDE** se usan con el sentido de RFC 2119.

---

## 1. Objetivo y alcance

El docente proyecta una presentación de Google Slides desde su computadora y la maneja desde el
teléfono, en el aula, sin tocar el teclado. La app:

1. encuentra el daemon en la red local (mDNS, QR o datos cargados a mano);
2. se empareja con el PIN que muestra el daemon y después se reconecta con un token;
3. muestra en vivo la diapositiva actual, las notas del orador y el cronómetro;
4. envía comandos: avanzar, retroceder, ir a una diapositiva, pantalla negra o blanca, puntero
   láser y cronómetro;
5. sigue funcionando con la pantalla apagada (servicio en primer plano y botones de volumen).

**Fuera de alcance:** meet-tools, editar presentaciones, conectarse desde fuera de la red local
y cualquier conexión directa con Google.

```
┌────────────────────┐   ws://<IP>:8766   ┌──────────────────┐  ws://127.0.0.1  ┌────────────────┐
│  App Android       │ ─────────────────► │  slide-tools     │ ───────────────► │  Extensión del │
│  (este documento)  │ ◄───────────────── │  daemon          │ ◄─────────────── │  navegador     │
└────────────────────┘  STATE_SYNC / ACK  └──────────────────┘  STATE_SYNC/ACK  └───────┬────────┘
                                                                                          │ teclas
                                                                                          ▼
                                                                                   Google Slides
```

La app **nunca** habla con la extensión: todo pasa por el daemon, que reenvía los comandos y
difunde el estado.

---

## 2. Requisitos de plataforma

| Aspecto | Requisito |
|---|---|
| Lenguaje y UI | Kotlin 2.x, Jetpack Compose, Material 3 |
| SDK | `minSdk 26`, `targetSdk 35` |
| WebSocket | OkHttp 4.12+ (`OkHttpClient.newWebSocket`) |
| JSON | `kotlinx.serialization` con `ignoreUnknownKeys = true` y `explicitNulls = false` |
| Descubrimiento | `android.net.nsd.NsdManager` |
| QR | CameraX + ML Kit Barcode Scanning (o la API de escaneo de Google Code Scanner) |
| Persistencia | DataStore para la configuración; el token y el PIN cifrados con una clave de Android Keystore |
| Fondo | Servicio en primer plano `connectedDevice` |
| Idioma | Textos en español; ningún texto de la UI dentro del código |

### 2.1. Permisos

| Permiso | Para qué |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | WebSocket y detección de cambios de red |
| `CHANGE_WIFI_MULTICAST_STATE` | `WifiManager.MulticastLock` mientras se busca con mDNS (algunos equipos lo exigen) |
| `CAMERA` | Escanear el QR (se pide al tocar «Escanear», no al arrancar) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` | Mantener la sesión con la pantalla apagada |
| `POST_NOTIFICATIONS` (API 33+) | Notificación del servicio con botones Anterior/Siguiente |
| `VIBRATE` | Confirmación háptica |

### 2.2. Tráfico sin cifrar

El daemon habla `ws://`, sin TLS. Desde Android 9, OkHttp rechaza las conexiones en texto plano
(`CLEARTEXT communication not permitted`) salvo que la configuración de seguridad de red las
permita. Como los hosts son IP privadas, que `domain-config` no acepta con comodines, la app
**DEBE** declarar:

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
```

y referenciarla desde `android:networkSecurityConfig` en el manifiesto. La app **NO DEBE** abrir
URLs `http`/`ws` que no sean del daemon.

---

## 3. Preparación del host (lo que el docente tiene que hacer)

La app **DEBERÍA** mostrar estos pasos cuando no encuentra ningún daemon:

1. Arrancar el daemon escuchando en la red: `slide-tools daemon -H 0.0.0.0`.
   **Por defecto escucha sólo en `127.0.0.1`**, y desde el teléfono no se ve.
2. El daemon imprime el PIN (6 dígitos, nuevo en cada arranque) y un QR en la consola. Con
   `--pin 123456` el PIN queda fijo; con `slide-tools qr --pin <PIN>` se vuelve a mostrar el QR.
3. El teléfono y la computadora tienen que estar en la misma red, y el firewall tiene que dejar
   pasar el TCP 8766 (y el UDP 5353 de mDNS para el descubrimiento automático).
4. La extensión del navegador tiene que estar conectada y la presentación abierta; si no, el
   daemon contesta `ERR_NOT_PRESENTING` a los comandos.

> El QR del modal «QR / PIN» de la extensión **no es escaneable**: es un dibujo decorativo. Los
> QR válidos son el de la consola del daemon, el de `slide-tools qr` y el `qrSvg` del estado.

---

## 4. Descubrimiento del daemon

La app ofrece tres caminos, en este orden: mDNS automático, QR y carga manual. Los tres terminan
en el mismo dato:

```kotlin
data class HostDescriptor(
    val host: String,        // IP v4 de la LAN
    val port: Int = 8766,
    val name: String?,       // nombre descriptivo del equipo
    val pin: String?,        // sólo si vino del QR o se cargó a mano
)
```

### 4.1. mDNS / DNS-SD (implementado)

| Campo | Valor real |
|---|---|
| Tipo de servicio | `_slide-bridge._tcp.` (en `NsdManager`, sin el `local.` final) |
| Nombre de la instancia | `SlideBridge-<PIN>` (ver la advertencia de abajo) |
| Puerto | el del daemon (8766 por defecto) |
| Dirección | la IP de la LAN que detectó el daemon |
| TXT `service` | `slides` |
| TXT `version` | versión **del paquete** (`1.3.2`), no del protocolo |
| TXT `requires_pin` | `"1"` o `"0"` |

- La app **DEBE** filtrar por `service=slides`.
- En la lista, la app **DEBERÍA** mostrar un nombre legible; como el daemon no publica un nombre
  de equipo, se muestra `host:port`.
- Con varios resultados, se ordenan por el último usado y luego por IP.
- La búsqueda se detiene al salir de la pantalla de descubrimiento (consume batería y el
  `MulticastLock` se libera ahí).

> ⚠️ **El nombre de la instancia contiene el PIN.** Es un defecto del daemon
> ([§14.2](#142-defectos-y-limitaciones-del-daemon-que-la-app-debe-tolerar)): cualquiera en la red
> puede leerlo. La app **NO DEBE** usarlo para emparejarse sola ni mostrarlo; tiene que pedir el
> PIN o el QR igual. Cuando el daemon deje de publicarlo, la app no tiene que cambiar.

### 4.2. Código QR (implementado)

El QR codifica el URI que arma `build_pairing_uri` en cast-tools-common:

```
bridge://pair?v=1.3&host=10.73.32.233&port=8766&service=slides&pin=357860&name=mrtin
```

Reglas de interpretación:

- El esquema **DEBE** ser `bridge` y el host del URI `pair`; si no, se rechaza con
  «Este QR no es de slide-tools».
- `service` **DEBE** ser `slides`. Un `meet` se rechaza con «Este QR es de meet-tools».
- `v` es la versión del formato del URI (`1.3`); se aceptan `1.x` y se ignoran los parámetros
  desconocidos.
- `host` y `port` son obligatorios; `port` tiene que ser un entero entre 1 y 65535.
- `pin` puede faltar (por ejemplo, un daemon con `--no-pin`).
- `name` es el nombre del equipo (`socket.gethostname()`); llega sin codificar como URL, así que
  se lee sin fallar ante caracteres raros.
- Si `host` es `127.0.0.1` o `0.0.0.0`, la app avisa: el daemon escucha sólo en local y hay que
  arrancarlo con `-H 0.0.0.0`.

Al escanear un QR válido, la app conecta y se empareja sin más pasos.

### 4.3. Carga manual

Campos: IP (obligatoria), puerto (8766 por defecto) y PIN. La app valida que la IP tenga forma de
IPv4 antes de intentar conectar.

### 4.4. Beacon UDP (no implementado)

`cyberdeck/android-spec.md` describe un beacon UDP en el puerto 8760. **El daemon no lo
implementa.** La app **NO DEBE** depender de él.

---

## 5. Conexión WebSocket

| Aspecto | Contrato |
|---|---|
| URL | `ws://<host>:<port>/` (cualquier ruta funciona; se usa `/`) |
| Cabecera `Origin` | **NO DEBE enviarse.** Con un `Origin` web (`http://` o `https://`) el daemon responde **HTTP 403** al handshake. OkHttp no la agrega por defecto. |
| Subprotocolo | ninguno |
| Keepalive | El servidor manda ping cada 20 s y corta si no recibe pong en 20 s; OkHttp responde solo. La app **DEBERÍA** configurar además `pingInterval(15, SECONDS)` para detectar la caída del lado del cliente. |
| Timeout de conexión | 5 s |
| Tamaño de mensaje | Cada `STATE_SYNC` pesa unos **11,5 KB** (casi todo es `qrSvg`); el servidor acepta mensajes de hasta 1 MiB. |
| Codificación | Texto UTF-8; nunca binario |

### 5.1. Saludo

Apenas se abre la conexión, **sin que la app mande nada**, el daemon envía un `STATE_SYNC`. Si
la conexión todavía no está emparejada, ese estado llega **censurado**: `pin` vacío, y
`pairingUri` y `qrSvg` en `null`. Sirve para mostrar el título de la presentación antes de
emparejar.

### 5.2. Procesamiento por conexión: un comando a la vez

El daemon procesa los mensajes de cada conexión **en orden y de a uno**. Mientras espera la
respuesta de la extensión a un comando (hasta 2,5 s), no lee el siguiente mensaje de esa conexión.
Consecuencias para la app:

- Las respuestas (`ack` / `error`) llegan **en el mismo orden** en que se enviaron los comandos.
  La app **DEBE** correlacionarlas con una cola FIFO de comandos pendientes. No sirve un
  `requestId` propio: el daemon lo reemplaza por el suyo ([§14.2](#142-defectos-y-limitaciones-del-daemon-que-la-app-debe-tolerar)).
- Los `STATE_SYNC` se intercalan en cualquier momento y no cuentan como respuesta.
- La app **DEBE** limitar los comandos en vuelo a **1** y juntar las pulsaciones repetidas:
  tres «Siguiente» rápidos se envían uno detrás de otro, no en paralelo. Si la cola supera
  5 comandos, se descartan los más viejos y se avisa con una vibración larga.
- Si un comando no tiene respuesta en **4 s** (2,5 s del daemon + margen), se considera perdido:
  se cierra la conexión y se reconecta ([§9](#9-máquina-de-estados-y-reconexión)).

---

## 6. Formato de los mensajes

Todo mensaje es un objeto JSON con este sobre:

```json
{
  "version": "1.2",
  "sessionId": "default",
  "source": "android",
  "type": "command",
  "action": "NEXT_SLIDE",
  "payload": {}
}
```

| Campo | Al enviar | Al recibir |
|---|---|---|
| `version` | `"1.2"` | Se ignora; el daemon no la valida. |
| `sessionId` | `"default"` | Se ignora. |
| `source` | **Obligatorio**: `"android"`. Un valor fuera de `android`, `hardware`, `daemon`, `extension`, `client` produce `ERR_MALFORMED_MESSAGE`. | Siempre `"daemon"`. |
| `type` | **Obligatorio**: `"command"` | `state`, `event`, `ack` o `error` |
| `action` | **Obligatorio** ([§8](#8-comandos)) | Ver cada tipo |
| `payload` | Objeto (puede ser `{}`) | Objeto |

- Si faltan `source`, `type` o `action`, o el JSON no es válido, el daemon responde
  `ERR_MALFORMED_MESSAGE` (con un `reason` largo, en inglés, de pydantic) y la conexión sigue.
- La app **DEBE** ignorar los campos y los valores de `action` que no conoce (compatibilidad hacia
  adelante).
- La app **NO DEBE** enviar acciones que no estén en la [§8](#8-comandos): el daemon reenvía a la
  extensión **cualquier** `action` de tipo `command`, y lo que no conoce termina en un ACK «ok»
  falso.

Modelo sugerido:

```kotlin
@Serializable
data class Envelope(
    val version: String = "1.2",
    val sessionId: String = "default",
    val source: String,
    val type: String,
    val action: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)
```

---

## 7. Emparejamiento

### 7.1. Flujo

```
App                                   Daemon
 │──── abre ws ───────────────────────►│
 │◄─── STATE_SYNC (censurado) ─────────│
 │──── PAIR_REQUEST {token} ──────────►│   si tiene token guardado
 │      o PAIR_REQUEST {pin}           │
 │◄─── PAIRING_SUCCESS {token} ────────│   ok
 │◄─── STATE_SYNC (completo) ──────────│   difusión a todos
 │                                     │
 │◄─── ERROR ERR_INVALID_PIN ──────────│   PIN/token rechazado (1 s después)
```

### 7.2. `PAIR_REQUEST`

```json
{"version": "1.2", "sessionId": "default", "source": "android", "type": "command",
 "action": "PAIR_REQUEST",
 "payload": {"pin": "482113", "deviceType": "android", "clientName": "Pixel 8"}}
```

| Campo | Contrato |
|---|---|
| `pin` | El PIN como **texto**. El daemon lo compara en tiempo constante después de `strip()`; hoy son 6 dígitos, pero la app acepta de 4 a 12 caracteres para no depender de eso. |
| `token` | Alternativa al PIN, para reconectarse. Se puede mandar junto con `pin`; alcanza con que uno sea válido. |
| `deviceType` | `"android"`. Se usa para contar clientes y mostrar el origen de los comandos. |
| `clientName` | Nombre que ve el docente en la extensión («Último comando: Siguiente · Pixel 8 (android)»). Por defecto, `Build.MODEL`; editable en Ajustes. Máximo 40 caracteres. |

### 7.3. Respuesta exitosa

```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "event",
 "action": "PAIRING_SUCCESS",
 "payload": {"clientId": "c_94163", "deviceType": "android", "status": "ok",
             "token": "P3-KSTUDdL351EiryEabDTGvzBU2a2UoQqbo1jNdyaI", "expiresIn": 28800}}
```

- `token`: secreto de 256 bits para reconectarse sin PIN. Vale `expiresIn` segundos (8 h) **y
  mientras el daemon no se reinicie** (viven en memoria). Cada emparejamiento emite uno nuevo; la
  app guarda **sólo el último**, cifrado, asociado a `host:port`.
- `clientId`: identifica la conexión, no el dispositivo; cambia en cada conexión. No se persiste.
- Inmediatamente después llega un `STATE_SYNC` completo (con `pin`, `pairingUri` y `qrSvg`).

### 7.4. Rechazos y bloqueo

| Situación | Respuesta del daemon | Qué hace la app |
|---|---|---|
| PIN equivocado | `ERR_INVALID_PIN`, «PIN de emparejamiento incorrecto.», **1 s después** | Muestra «PIN incorrecto» y vuelve a pedirlo. **No reintenta sola.** |
| Token vencido o desconocido (p. ej. el daemon se reinició), sin PIN | `ERR_INVALID_PIN`, igual que arriba | Borra el token. Si tiene un PIN guardado lo prueba **una vez**; si no, lo pide. No cuenta como intento fallido. |
| 5 PIN equivocados en 60 s desde la misma IP | `ERR_INVALID_PIN`, «Demasiados intentos fallidos de PIN. Intente nuevamente en N s.», con `payload.retryAfter = N` | Muestra la cuenta regresiva y deshabilita «Emparejar» hasta que termine. **Durante el bloqueo, el PIN correcto también se rechaza.** |

Ejemplo de bloqueo:

```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "error", "action": "ERROR",
 "payload": {"reason": "Demasiados intentos fallidos de PIN. Intente nuevamente en 55 s.",
             "code": "ERR_INVALID_PIN", "retryAfter": 55}}
```

> **Regla dura:** la app **NO DEBE** reintentar sola un PIN rechazado. Reintentar con el mismo PIN
> suma fallos, y al quinto el daemon bloquea la IP, que puede ser la misma de la computadora del
> docente si comparten NAT. La extensión tenía exactamente este defecto hasta la 1.3.2.

### 7.5. Daemon sin PIN

Con `slide-tools daemon --no-pin`, cualquier `PAIR_REQUEST` se acepta (TXT `requires_pin=0`). La
app igual envía `PAIR_REQUEST` para obtener el token y registrar su nombre.

### 7.6. Antes de emparejar

Sin emparejar, la app **sólo** puede mandar `PAIR_REQUEST` y `GET_STATE`. Cualquier otro comando
recibe:

```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "error", "action": "ERROR",
 "payload": {"reason": "Emparejamiento requerido mediante PIN.", "code": "ERR_PAIRING_REQUIRED"}}
```

El daemon **no** envía nunca el evento `PAIRING_REQUIRED` que menciona `spec.md`: la necesidad de
emparejar se deduce del saludo censurado o de este error.

---

## 8. Comandos

### 8.1. Catálogo

| `action` | `payload` | Efecto | Notas |
|---|---|---|---|
| `NEXT_SLIDE` | `{}` | Siguiente diapositiva o animación | Tecla → |
| `PREV_SLIDE` | `{}` | Anterior | Tecla ← |
| `FIRST_SLIDE` | `{}` | Primera | Tecla Inicio |
| `LAST_SLIDE` | `{}` | Última | Tecla Fin |
| `GO_TO_SLIDE` | `{"slideNumber": n}` | Salta a la diapositiva `n` | Entero ≥ 1. La app lo limita a `1..totalSlides` antes de enviarlo (el daemon no valida). |
| `TOGGLE_BLACKOUT` | `{}` | Conmuta pantalla negra | Tecla B |
| `TOGGLE_WHITEOUT` | `{}` | Conmuta pantalla blanca | Tecla W |
| `TOGGLE_LASER` | `{}` | Conmuta el puntero láser | Tecla L |
| `TIMER_RESET` | `{}` | Reinicia el cronómetro | Ver [§8.3](#83-cronómetro-según-el-modo) |
| `TIMER_TOGGLE_PAUSE` | `{}` | Pausa o reanuda el cronómetro | Ver [§8.3](#83-cronómetro-según-el-modo) |
| `GET_STATE` | `{}` | Pide el estado | Responde un `STATE_SYNC`, no un ACK |
| `PAIR_REQUEST` | ver [§7](#7-emparejamiento) | Empareja | |

`UNPAIR_CLIENT` existe en el enum del protocolo, pero **el daemon no lo implementa**: lo
reenviaría a la extensión como un comando más. Para desconectarse, la app cierra el WebSocket
(código 1000) y borra el token.

### 8.2. Respuestas posibles a un comando

| Respuesta | Ejemplo de `payload` | Significado | Estado en la UI |
|---|---|---|---|
| `type: "ack"`, `status: "ok"` y `details` ausente o de la forma `teclado:…` | `{"action": "NEXT_SLIDE", "status": "ok", "details": "teclado:iframe_presentacion", "requestId": "cmd_1"}` | La extensión ejecutó el comando | ✓ confirmado |
| `type: "ack"`, `status: "ok"`, `details: "dispatched_to_tabs"` | | La extensión lo recibió pero ninguna pestaña lo confirmó | ⚠ sin confirmar |
| `type: "ack"`, `status: "ok"`, `details: "dispatched_timeout_ack"` | | La extensión no contestó en 2,5 s | ⚠ sin confirmar |
| `type: "ack"`, `status: "failed"` | `{"status": "failed", "details": "No hay pestañas de Google Slides abiertas"}` | No se pudo ejecutar | ✗ con `details` |
| `type: "error"` | `{"code": "ERR_NOT_PRESENTING", "reason": "…"}` | Ver [§10](#10-errores) | ✗ con `reason` |

Particularidades:

- El campo `action` **del sobre** de un ACK puede ser la acción original (`"NEXT_SLIDE"`, cuando
  responde la extensión) o `"COMMAND_ACK"` (cuando responde el propio daemon). La app **DEBE**
  identificar el ACK por `type == "ack"` y leer la acción de `payload.action`.
- `payload.requestId` es el identificador interno del daemon (`cmd_N`), no uno de la app.
- Un ACK «ok» **no garantiza** que la diapositiva haya cambiado: Slides puede ignorar la tecla
  (por ejemplo, si no se está presentando). La confirmación real es el `STATE_SYNC` siguiente.
  La app **DEBERÍA** marcar como dudoso un `NEXT_SLIDE` confirmado que no cambia `currentSlide`
  en 1,5 s, salvo que la diapositiva tenga animaciones (no se puede saber; se trata como
  información, no como error).

### 8.3. Cronómetro según el modo

| `presentationMode` | Quién maneja el cronómetro | Comportamiento |
|---|---|---|
| `presenter_view` | El cronómetro nativo de Slides, en la vista del orador, que la extensión aprieta | `TIMER_*` se reenvía a la extensión; `timer` refleja el de Slides. |
| `standard` / `edit` | Un cronómetro **emulado por el daemon** | El daemon responde `COMMAND_ACK` él mismo. El cronómetro arranca recién con el primer `TIMER_RESET`; antes queda en `00:00`. Mientras corre, el daemon difunde un `STATE_SYNC` **por segundo**. |

La app **DEBERÍA** mostrar «Cronómetro del daemon» o «Cronómetro de Slides» según el modo.

### 8.4. Reglas de la UI al enviar

- Vibración corta (≤ 20 ms) al **enviar**, no al recibir el ACK: la latencia percibida importa
  más que la confirmación.
- El número de diapositiva **no** se actualiza de forma optimista: se espera el `STATE_SYNC`.
  Mientras tanto, el botón muestra un indicador de pendiente.
- Los toggles (negra, blanca, láser) muestran el estado de `STATE_SYNC` (`isBlackout`,
  `isWhiteout`, `isLaserActive`). Hoy la extensión **no detecta** esos estados y siempre llegan
  `false` ([§14.2](#142-defectos-y-limitaciones-del-daemon-que-la-app-debe-tolerar)), así que se
  presentan como botones, no como interruptores con estado.

---

## 9. Máquina de estados y reconexión

```
            ┌──────────┐ abrir pantalla / QR / host guardado
            │   IDLE   │──────────────────────────────┐
            └──────────┘                              ▼
                 ▲                            ┌──────────────┐
                 │ usuario cancela            │  CONNECTING  │◄───────────────┐
                 │                            └──────┬───────┘                │
                 │                                   │ ws abierto + saludo    │ backoff
                 │                                   ▼                        │
                 │  ERR_INVALID_PIN          ┌──────────────┐                 │
  ┌──────────────┴───┐◄──────────────────────│   PAIRING    │                 │
  │ NEEDS_PIN /      │  (retryAfter → LOCKED)└──────┬───────┘                 │
  │ LOCKED(n s)      │──── usuario ingresa PIN ─────┘ PAIRING_SUCCESS         │
  └──────────────────┘                              ▼                        │
                                             ┌──────────────┐  ws cerrado /   │
                                             │    ACTIVE    │  sin pong /     │
                                             │ (STATE_SYNC) │  cmd sin resp.  │
                                             └──────┬───────┘                 │
                                                    └──────────► RECONNECTING ┘
```

| Estado | Entrada | Salida |
|---|---|---|
| `CONNECTING` | Hay un `HostDescriptor` | ws abierto → `PAIRING`; falla → `RECONNECTING` |
| `PAIRING` | Envía `PAIR_REQUEST` con token, o con PIN si no hay token | `PAIRING_SUCCESS` → `ACTIVE`; error → `NEEDS_PIN` o `LOCKED` |
| `NEEDS_PIN` | Pide el PIN al usuario | El usuario lo ingresa → `PAIRING` |
| `LOCKED` | `retryAfter` | Termina la cuenta → `NEEDS_PIN` (no reintenta sola) |
| `ACTIVE` | Recibe `STATE_SYNC`, envía comandos | Caída → `RECONNECTING` |
| `RECONNECTING` | Espera y reconecta | → `CONNECTING` |

Reconexión:

- Espera exponencial con azar: base 1 s, 2 s, 4 s… hasta 30 s, multiplicada por un factor
  aleatorio entre 0,5 y 1 (así no reintentan todos los teléfonos del aula a la vez).
- Siempre se reconecta **con el token** y nunca reintenta un PIN en bucle ([§7.4](#74-rechazos-y-bloqueo)).
- Ante un cambio de red (`ConnectivityManager.NetworkCallback.onAvailable`) se reintenta de
  inmediato y se reinicia la espera.
- Al reconectar, el `STATE_SYNC` del saludo y el que sigue al emparejamiento ya traen el estado
  completo: no hace falta `GET_STATE`.
- Los comandos que estaban en la cola al caer la conexión **se descartan** (no se reenvían al
  volver: un «Siguiente» de hace 20 s ya no corresponde).

---

## 10. Errores

| `code` | Cuándo | Acción de la app |
|---|---|---|
| `ERR_PAIRING_REQUIRED` | Comando antes de emparejar | Ir a `PAIRING` |
| `ERR_INVALID_PIN` | PIN o token rechazado; bloqueo con `retryAfter` | [§7.4](#74-rechazos-y-bloqueo) |
| `ERR_NOT_PRESENTING` | La extensión no está conectada al daemon | Banner «Abrí la presentación en el navegador con la extensión activa»; los controles quedan deshabilitados hasta que llegue un `STATE_SYNC` con `isPresenting: true` |
| `ERR_EXTENSION_DISCONNECTED` | Falló el envío a la extensión | Igual que el anterior |
| `ERR_MALFORMED_MESSAGE` | La app mandó algo inválido | Es un error de la app: se registra en el log y se reporta. No se muestra el `reason`, que viene en inglés. |
| `ERR_INVALID_SLIDE`, `ERR_INVALID_COMMAND`, `ERR_TIMEOUT` | Declarados en el protocolo, el daemon **no los emite** hoy | Mensaje genérico con `reason` |
| Desconocido | — | Mensaje genérico con `reason` |

El campo `reason` viene en español (salvo `ERR_MALFORMED_MESSAGE`) y **PUEDE** mostrarse tal cual.

---

## 11. Estado (`STATE_SYNC`)

```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "state", "action": "STATE_SYNC",
 "payload": {
   "presentationTitle": "P1#20 - matrices",
   "isPresenting": true,
   "presentationMode": "standard",
   "currentSlide": 4, "totalSlides": 20,
   "isBlackout": false, "isWhiteout": false, "isLaserActive": false,
   "timer": {"elapsedSeconds": 0, "formattedTime": "00:00", "isPaused": false},
   "speakerNotes": {"hasNotes": true, "currentSlideNotes": "Recordar el ejemplo de 3x3"},
   "connectedClients": 1,
   "pin": "482113",
   "pairingUri": "bridge://pair?v=1.3&host=10.73.32.233&port=8766&service=slides&pin=482113&name=mrtin",
   "qrSvg": "<?xml version='1.0' encoding='UTF-8'?>\n<svg …>"}}
```

| Campo | Tipo | Uso en la app |
|---|---|---|
| `presentationTitle` | texto | Título en la barra. Sin presentación: «Sin presentación activa». |
| `isPresenting` | bool | `false` → banner «No se está presentando» y controles de navegación deshabilitados. Pasa a `false` cuando se desconecta la extensión. |
| `presentationMode` | `presenter_view` \| `standard` \| `edit` | Etiqueta del modo y origen del cronómetro ([§8.3](#83-cronómetro-según-el-modo)). |
| `currentSlide`, `totalSlides` | entero ≥ 1 | «4 / 20» y límites de `GO_TO_SLIDE`. **`1/1` puede significar «desconocido»**: la extensión no siempre logra leer el número. Si `totalSlides == 1`, se muestra «—» y no se limita `GO_TO_SLIDE`. |
| `isBlackout`, `isWhiteout`, `isLaserActive` | bool | Hoy siempre `false` ([§8.4](#84-reglas-de-la-ui-al-enviar)). |
| `timer.formattedTime` | `MM:SS` o `H:MM:SS` | Se muestra tal cual. |
| `timer.elapsedSeconds`, `timer.isPaused` | entero, bool | Alerta opcional de tiempo (configurable por el usuario). |
| `speakerNotes.hasNotes`, `currentSlideNotes` | bool, texto plano UTF-8 | Notas con tamaño de letra ajustable (14–40 sp), desplazables. Vacías → «Sin notas». En modo `standard` la extensión no lee notas: se muestran sólo en `presenter_view`. |
| `connectedClients` | entero | Dispositivos emparejados (sin contar la extensión). |
| `pin` | texto | La app **NO DEBE** mostrarlo ni guardarlo desde acá. |
| `pairingUri`, `qrSvg` | texto \| null | Sólo para una función opcional de «emparejar otro teléfono» (mostrar el QR). Fuera de eso se ignoran. |

Reglas:

- Cada `STATE_SYNC` es el estado **completo**: se reemplaza el anterior, no se mezcla.
- Pueden llegar **varios por segundo** (la extensión reporta cada vez que cambia el DOM) y cada
  uno pesa ~11,5 KB. La app **DEBE** parsearlos fuera del hilo principal, ignorar `qrSvg` en el
  parseo (`@Transient` o un modelo sin ese campo) y emitir a la UI sólo si cambió algún campo
  visible (`distinctUntilChanged`).
- Los campos que falten toman los valores por defecto de la tabla.

---

## 12. Interfaz

### 12.1. Pantallas

1. **Conectar**: lista de daemons encontrados por mDNS, botón «Escanear QR», botón «Ingresar a
   mano» y la ayuda de la [§3](#3-preparación-del-host-lo-que-el-docente-tiene-que-hacer) si no
   aparece nada en 10 s.
2. **PIN**: teclado numérico, 4 a 12 caracteres; muestra el bloqueo con cuenta regresiva.
3. **Control** (pantalla principal, vertical y horizontal):
   - Barra superior: punto de estado (verde activo, amarillo reconectando, rojo sin presentación),
     título, «4 / 20», modo y cantidad de dispositivos.
   - Botones **Anterior** y **Siguiente** grandes (al menos 40 % del alto cada uno en vertical),
     operables con el pulgar sin mirar.
   - Cronómetro grande con pausa y reinicio (reinicio con pulsación larga, para no tocarlo sin
     querer).
   - Notas del orador con ajuste de letra (gesto de pellizco o botones A−/A+).
   - Fila de herramientas: Primera, Ir a…, Última, Negra, Blanca, Láser.
   - Línea de resultado del último comando: «Siguiente ✓», «Siguiente ⚠ sin confirmar»,
     «✗ No hay pestañas de Google Slides abiertas».
4. **Ajustes**: nombre del dispositivo, botones de volumen, mantener la pantalla encendida,
   vibración, alerta de tiempo, olvidar este equipo.

### 12.2. Entradas físicas

- **Volumen**: subir = Siguiente y bajar = Anterior (configurable e invertible). Con la app al
  frente se capturan en `onKeyDown`; con la pantalla apagada, mediante una `MediaSession` con
  `VolumeProviderCompat` en el servicio.
- **Control remoto Bluetooth/teclado** (presentadores USB o BT): `KEYCODE_PAGE_DOWN`,
  `KEYCODE_DPAD_RIGHT` y `KEYCODE_SPACE` = Siguiente; `KEYCODE_PAGE_UP` y `KEYCODE_DPAD_LEFT` =
  Anterior; `KEYCODE_B` = Negra.

### 12.3. Servicio en primer plano

- Arranca al pasar a `ACTIVE` y termina al desconectarse a propósito o tras 10 min en
  `RECONNECTING`.
- Notificación persistente: «P1#20 - matrices · 4 / 20 · 12:34», con acciones **Anterior** y
  **Siguiente**.
- El WebSocket vive en el servicio, no en la `Activity`; la UI lo observa con un `StateFlow`.

### 12.4. Accesibilidad

- Todos los controles con `contentDescription` en español.
- Contraste AA; tema oscuro por defecto (el aula suele estar a oscuras).
- La línea de resultado se anuncia con `LiveRegion` (sólo errores, para no saturar TalkBack).

---

## 13. Seguridad y privacidad

- El PIN y el token se guardan cifrados (Keystore) y **nunca** se escriben en el log.
- La app **NO DEBE** enviar la cabecera `Origin` ni abrir el daemon dentro de un WebView.
- El tráfico va sin cifrar por la red del aula: el PIN viaja en claro en `PAIR_REQUEST`. Es una
  limitación del diseño actual; la app no debe dar a entender lo contrario.
- La app no usa el PIN que aparece en el nombre mDNS ni el de `STATE_SYNC.pin`.
- «Olvidar este equipo» borra el token, el PIN y el host guardados.
- La app no tiene analíticas ni envía datos fuera de la red local.

---

## 14. Brechas del daemon y trabajo pendiente

### 14.1. Diferencias con `cyberdeck/android-spec.md`

| cyberdeck dice | slide-tools 1.3.2 hace | Para esta app |
|---|---|---|
| Protocolo `version: "1.3"` | `"1.2"` (no se valida) | Enviar `"1.2"` |
| `GET_CAPABILITIES` → `CAPABILITIES_LIST` / `CAPABILITIES_UPDATED` | No existen. `GET_CAPABILITIES` se reenviaría a la extensión y volvería un ACK «ok» sin datos | UI fija según la [§8](#8-comandos) |
| mDNS `_bridge-remote._tcp` con subtipo `_slide-bridge._sub` | `_slide-bridge._tcp`, sin subtipo | Buscar `_slide-bridge._tcp.` |
| TXT `id`, `name`, `service`, `version` (protocolo), `requires_pin` | Sólo `service`, `version` (paquete) y `requires_pin` | No depender de `id` ni de `name` |
| Beacon UDP en 8760 | No existe | No implementarlo |
| `PAIRING_SUCCESS` con `service` | Con `deviceType`, `token` y `expiresIn`; sin `service` | Leer `token` |
| PIN obligatorio | Obligatorio por defecto; `--no-pin` lo desactiva | [§7.5](#75-daemon-sin-pin) |

Si la app tiene que servir también para meet-tools, conviene una capa de «perfil» por servicio:
la de slides según este documento, y la de capacidades cuando algún daemon la implemente.

### 14.2. Defectos y limitaciones del daemon que la app debe tolerar

| # | Problema | Efecto en la app | Arreglo propuesto en el daemon |
|---|---|---|---|
| D1 | El nombre mDNS es `SlideBridge-<PIN>`: el PIN se publica en la red | La app lo ignora ([§4.1](#41-mdns--dns-sd-implementado)) | Usar `SlideBridge-<hostname>` y agregar TXT `name` e `id` |
| D2 | Cada `STATE_SYNC` difundido trae `qrSvg` (~11 KB), varias veces por segundo | Gasto de datos y CPU; la app ignora el campo | Mandar `qrSvg` sólo a pedido (`GET_PAIRING_QR`) o sólo a la extensión |
| D3 | El daemon reemplaza el `requestId` del cliente por el suyo | La app correlaciona por orden (FIFO) | Conservar el `requestId` del cliente y devolverlo en el ACK |
| D4 | El ACK puede llegar con `action` igual a la acción o a `COMMAND_ACK` | La app usa `type` y `payload.action` | Normalizar a `COMMAND_ACK` con `payload.action` |
| D5 | Una conexión no procesa el siguiente mensaje hasta que la extensión responde (hasta 2,5 s) | Un comando en vuelo por vez ([§5.2](#52-procesamiento-por-conexión-un-comando-a-la-vez)) | Despachar cada comando en una tarea propia |
| D6 | `isBlackout`, `isWhiteout` e `isLaserActive` siempre `false` | Botones sin estado | Que la extensión los detecte en el DOM |
| D7 | `UNPAIR_CLIENT` no implementado; `ERR_INVALID_SLIDE`, `ERR_INVALID_COMMAND` y `ERR_TIMEOUT` nunca se emiten | La app no los usa | Implementarlos o quitarlos del enum |
| D8 | Las acciones desconocidas se reenvían a la extensión y vuelven como «ok» | La app sólo envía acciones del catálogo | Responder `ERR_INVALID_COMMAND` |
| D9 | `GO_TO_SLIDE` no valida `slideNumber` | La app lo limita | Validar con `GoToSlidePayload` |
| D10 | El `reason` de `ERR_MALFORMED_MESSAGE` es el volcado de pydantic, en inglés | No se muestra | Mensaje corto en español |
| D11 | Sin TLS | [§13](#13-seguridad-y-privacidad) | `wss://` con certificado autofirmado anclado por el QR |

Cuando se arregle cada punto, este documento se actualiza y la app conserva la compatibilidad con
el comportamiento anterior durante al menos una versión del daemon.

---

## 15. Pruebas y criterios de aceptación

### 15.1. Pruebas unitarias (JVM)

- Parser del URI `bridge://`: válidos, `service=meet`, sin `port`, `port` fuera de rango, `name`
  con espacios, parámetros extra, `host=127.0.0.1`.
- Serialización: los mensajes de la [§16](#16-apéndice-transcripción-real) se parsean sin error;
  un `STATE_SYNC` sin `qrSvg` o con campos nuevos también.
- Clasificación de respuestas según la tabla de la [§8.2](#82-respuestas-posibles-a-un-comando).
- Máquina de estados: token vencido → un intento con PIN → `NEEDS_PIN`; `retryAfter` → `LOCKED`
  sin reintentos; caída de red → backoff con los tiempos de la [§9](#9-máquina-de-estados-y-reconexión).
- Cola de comandos: máximo 1 en vuelo, FIFO, descarte al superar 5, timeout de 4 s.

### 15.2. Integración contra el daemon real (sin Google Slides)

El repo trae un simulador de presentación: no hace falta un navegador.

```bash
slide-tools daemon -H 0.0.0.0 --pin 482113 &      # daemon en la LAN
slide-tools mock-slides --slides 10                # «presentación» de 10 diapositivas
```

Con el emulador de Android, el host es `10.0.2.2` (y el daemon tiene que escuchar en
`0.0.0.0`). Casos:

1. Emparejar con PIN correcto → `PAIRING_SUCCESS` y estado «1 / 10».
2. `NEXT_SLIDE` ×3 rápidos → ACK confirmados en ~2 ms cada uno y «4 / 10».
3. `GO_TO_SLIDE 8` → «8 / 10», notas «Nota de la diapositiva 8».
4. Detener `mock-slides` → `STATE_SYNC` con `isPresenting: false`; un comando → `ERR_NOT_PRESENTING`.
5. `TIMER_RESET` en modo `standard` sin extensión → `COMMAND_ACK` del daemon y cronómetro corriendo.
6. 5 PIN equivocados → `retryAfter`; la app no reintenta y el sexto intento llega después de la cuenta.
7. Reiniciar el daemon con el mismo `--pin` → la app reconecta, el token falla, prueba el PIN una
   vez y vuelve a `ACTIVE`.
8. Cortar el Wi-Fi 10 s → `RECONNECTING` y vuelta a `ACTIVE` sin intervención.
9. Conectar con `Origin: https://example.com` (prueba negativa) → HTTP 403.

Estos casos **DEBERÍAN** automatizarse como pruebas instrumentadas que arrancan el daemon en la
máquina de CI.

### 15.3. Prueba manual con Google Slides

- Presentar desde el editor (pantalla completa) y con «Vista del presentador»: Siguiente,
  Anterior, Ir a, Negra, Láser y el cronómetro funcionan en ambos modos.
- La barra de la vista del orador de la extensión muestra «Último comando: Siguiente · <nombre del
  teléfono> (android) · ✓».
- Con la pantalla del teléfono apagada, los botones de volumen siguen cambiando de diapositiva.

### 15.4. Criterios de aceptación

- **CA-1:** desde el toque hasta el ACK, p95 < 150 ms en una red Wi-Fi del aula con el simulador.
- **CA-2:** desde la caída de red hasta `ACTIVE`, menos de 5 s después de volver la red, sin pedir
  el PIN si el daemon no se reinició.
- **CA-3:** ningún escenario de la [§15.2](#152-integración-contra-el-daemon-real-sin-google-slides)
  genera más de un `PAIR_REQUEST` con PIN sin acción del usuario.
- **CA-4:** con `STATE_SYNC` a 5 por segundo, la UI no pierde cuadros (sin trabajo de parseo en el
  hilo principal).
- **CA-5:** el PIN y el token no aparecen en `logcat` en ningún nivel.

---

## 16. Apéndice: transcripción real

Capturada con slide-tools 1.3.2, un cliente que se presenta como `android` y la extensión
simulada. `qrSvg` está abreviado.

**Saludo sin emparejar**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "state", "action": "STATE_SYNC", "payload": {"presentationTitle": "Sin presentación activa", "isPresenting": false, "presentationMode": "standard", "currentSlide": 1, "totalSlides": 1, "isBlackout": false, "isWhiteout": false, "isLaserActive": false, "timer": {"elapsedSeconds": 0, "formattedTime": "00:00", "isPaused": false}, "speakerNotes": {"hasNotes": false, "currentSlideNotes": ""}, "connectedClients": 0, "pin": "", "pairingUri": null, "qrSvg": null}}
```

**Comando antes de emparejar**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "error", "action": "ERROR", "payload": {"reason": "Emparejamiento requerido mediante PIN.", "code": "ERR_PAIRING_REQUIRED"}}
```

**PIN incorrecto**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "error", "action": "ERROR", "payload": {"reason": "PIN de emparejamiento incorrecto.", "code": "ERR_INVALID_PIN"}}
```

**Emparejamiento exitoso**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "event", "action": "PAIRING_SUCCESS", "payload": {"clientId": "c_94163", "deviceType": "android", "status": "ok", "token": "P3-KSTUDdL351EiryEabDTGvzBU2a2UoQqbo1jNdyaI", "expiresIn": 28800}}
```

**Comando sin extensión conectada**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "error", "action": "ERROR", "payload": {"reason": "No hay ninguna presentación de Google Slides conectada.", "code": "ERR_NOT_PRESENTING"}}
```

**`TIMER_RESET` en modo `standard` (responde el daemon)**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "ack", "action": "COMMAND_ACK", "payload": {"action": "TIMER_RESET", "status": "ok"}}
```

**Lo que recibe la extensión cuando la app manda `NEXT_SLIDE`** (informativo)
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "command", "action": "NEXT_SLIDE", "payload": {"requestId": "cmd_1", "origin": {"clientId": "c_94163", "clientName": "Pixel 8", "deviceType": "android"}}}
```

**ACK de la extensión, reenviado a la app**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "ack", "action": "NEXT_SLIDE", "payload": {"action": "NEXT_SLIDE", "status": "ok", "details": "teclado:iframe_presentacion", "requestId": "cmd_1"}}
```

**Estado posterior**
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "state", "action": "STATE_SYNC", "payload": {"presentationTitle": "P1#20 - matrices", "isPresenting": true, "presentationMode": "standard", "currentSlide": 4, "totalSlides": 20, "isBlackout": false, "isWhiteout": false, "isLaserActive": false, "timer": {"elapsedSeconds": 0, "formattedTime": "00:00", "isPaused": false}, "speakerNotes": {"hasNotes": true, "currentSlideNotes": "Recordar el ejemplo de 3x3"}, "connectedClients": 1, "pin": "482113", "pairingUri": "bridge://pair?v=1.3&host=127.0.0.1&port=0&service=slides&pin=482113&name=mrtin", "qrSvg": "<svg …>"}}
```

**Reconexión con token** (`PAIR_REQUEST` con `{"token": "P3-KSTU…", "deviceType": "android", "clientName": "Pixel 8"}`)
```json
{"version": "1.2", "sessionId": "default", "source": "daemon", "type": "event", "action": "PAIRING_SUCCESS", "payload": {"clientId": "c_69270", "deviceType": "android", "status": "ok", "token": "HuWErulQJEseArqlsBjtZNWVkPMbEmMJyINZ43vJh0s", "expiresIn": 28800}}
```

**Conexión con `Origin` web**: el handshake falla con `HTTP 403`.
