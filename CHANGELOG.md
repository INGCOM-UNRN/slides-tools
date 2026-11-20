# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versiones según [SemVer](https://semver.org/lang/es/).

## [1.3.2] - 2026-11-20

### Corregido

- Los comandos no llegaban a la presentación: al presentar desde el editor, Slides dibuja la presentación en un iframe y la extensión despachaba las teclas en el documento principal. Ahora las envía al iframe visible de la presentación (o al documento en `/present`).
- El script de la vista del orador también corría en la pestaña principal, informaba «diapositiva 1/1» cada segundo y contestaba los comandos del cronómetro antes que la vista del orador.
- Los comandos iban a la pestaña activa de cada ventana: con dos presentaciones abiertas avanzaban las dos. Ahora van a la que está presentando, y los del cronómetro a la vista del orador.
- Ante un PIN rechazado la extensión reintentaba sola con el mismo PIN y en unos 15 s bloqueaba su propia IP; además podía quedar con dos conexiones abiertas al guardar el PIN.
- Un token de reconexión vencido contaba como intento fallido y bloqueaba al dispositivo cuando se tecleaba el PIN correcto.
- `mock-slides` confirmaba los comandos como daemon y cada uno esperaba los 2,5 s del tiempo límite; tampoco actualizaba las notas al saltar a una diapositiva.

### Agregado

- Barra de la vista del orador con el estado de la conexión (emparejado, PIN rechazado, bloqueado o reintento) y el último comando: cuál, de qué dispositivo, hace cuánto y cómo terminó.
- El daemon indica en `origin` quién envió cada comando reenviado a la extensión.
- El log del daemon explica cada rechazo de emparejamiento y cuánto falta para que termine un bloqueo; el error incluye `retryAfter`.

## [1.3.1] - 2026-10-28

### Corregido

- La extensión no se conectaba al daemon en Firefox: sin `content_security_policy`, Firefox aplica a las extensiones Manifest V3 un CSP con `upgrade-insecure-requests` que convierte `ws://127.0.0.1:8766` en `wss://`, y el daemon no habla TLS (sólo registraba «connection closed»). El manifest declara el CSP sin esa directiva. Reproducido y verificado con Firefox 158.


### Seguridad

- Cualquier conexión que dijera `source: extension` quedaba emparejada sin PIN y podía manejar la presentación desde la red: la extensión se empareja con el PIN como cualquier cliente (o es local).
- El saludo llevaba el PIN a cualquiera que se conectara: ahora sólo a conexiones emparejadas o locales.
- Cualquier página web abierta en el navegador podía conectarse al daemon en 127.0.0.1: ahora responde 403.
- PIN comparado en tiempo constante.

### Agregado

- Token de reconexión en `PAIRING_SUCCESS` (8 h, en memoria) que reemplaza al PIN en `PAIR_REQUEST`.
- `slide-tools atajos`: atajos de teclado globales (GNOME) para avanzar, retroceder, pantalla en negro y temporizador; `--notificar` en esos comandos.
- `slide-tools bandeja`: indicador de estado en la bandeja del sistema o notificaciones.
- Registro rotativo en `~/.local/state/p1/cast.log`.
- Variable `SLIDE_TOOLS_PIN` para un daemon de otro equipo.

### Cambiado

- Una conexión desde el mismo equipo sin origen web no necesita PIN (antes la CLI local lo pedía con `--pin`).

## [1.3.0] - 2026-09-28

Primera versión con registro de cambios; lo anterior está en el historial de git.

### Agregado

- **cli**: cumplir el contrato de línea de comandos de LINEAMIENTOS §3.2 (N-ECO-04) (`68a595e`)

### Corregido

- **seguridad**: PIN de emparejamiento de 6 dígitos con secrets (N-MEET-02) (`595b420`)

### Documentación

- agregar el texto de la licencia GPL-3.0-or-later que declara pyproject (N-ECO-06) (`c0c986b`)
- incorporar manual de uso integral y referencia tecnica (slide-tools) (`333b53e`)

### Mantenimiento

- **calidad**: verificar errores de Python y dependencias vulnerables (N-ECO-08, N-ECO-13) (`5544e09`)
- **deps**: declarar cast-tools-common como dependencia en lugar de cargarla por sys.path (N-SLIDE-01) (`5ad11ba`)
