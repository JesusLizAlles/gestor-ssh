# Gestor SSH

Gestor de servidores por SSH de escritorio: **explorador de ficheros** (SFTP), **descargas y subidas** con progreso,
**editor** de ficheros remotos y **terminal**, todo sobre una misma conexión. Está hecho con Electron, TypeScript y React,
con el mismo estilo que [Gestor BBDD](https://github.com/JesusLizAlles/gestor-bbdd).

Es un proyecto de código abierto con [licencia MIT](LICENSE). Los instaladores para Linux (AppImage), Windows y macOS están en
[Releases](https://github.com/JesusLizAlles/gestor-ssh/releases), y la app se actualiza sola.

## Qué hace ya

- **Servidores guardados** con nombre, entorno (desarrollo, pruebas, producción) y carpeta inicial. Se prueba la conexión
  antes de guardar. En el campo del servidor se puede pegar `usuario@servidor:puerto` y se reparte solo.
- **Autenticación** con contraseña (también servidores con *keyboard-interactive*), clave privada (con o sin frase de paso)
  o agente SSH (ssh-agent, Pageant u OpenSSH de Windows).
- **Contraseñas y frases de paso** cifradas con el llavero del sistema (KWallet/libsecret, Keychain, DPAPI). Sin llavero,
  solo en memoria.
- **Huella del servidor**: la primera vez se enseña y se pide confirmación. Si después cambia, la conexión se bloquea hasta
  olvidarla a mano («Olvidar huella» al editar el servidor).
- **Explorador de ficheros** (SFTP):
  - Migas de pan (clic en el texto para escribir una ruta; admite `~`), atrás, carpeta superior, carpeta personal.
  - Columnas de tamaño, fecha, permisos (`-rwxr-xr-x`, con el octal en el tooltip) y propietario, ordenables.
  - Enlaces simbólicos resueltos (a carpeta o a fichero; los rotos se marcan). Ficheros ocultos visibles u ocultos.
  - Filtro por nombre, selección múltiple (<kbd>Ctrl</kbd>/<kbd>Shift</kbd>+clic, <kbd>Ctrl</kbd>+<kbd>A</kbd>), lista
    virtualizada para carpetas con miles de entradas.
  - Crear carpeta o fichero, renombrar (<kbd>F2</kbd>), eliminar (<kbd>Supr</kbd>; las carpetas con todo su contenido, sin
    seguir enlaces), copiar ruta, abrir un terminal en la carpeta.
  - Teclado: flechas, <kbd>Enter</kbd> abre, <kbd>Retroceso</kbd> sube, <kbd>F5</kbd> actualiza.
- **Transferencias** por SFTP (no SCP):
  - Descargar ficheros o carpetas completas; subir ficheros o una carpeta. Se conservan los permisos (el bit de ejecución).
  - Cola con progreso, velocidad y cancelación; lo que queda a medias se borra.
  - Si al subir ya existe algo con el mismo nombre, pregunta: sobrescribir o subir solo lo nuevo.
  - Cada transferencia usa su propio canal SFTP, así que el explorador sigue respondiendo mientras tanto.
- **Editor** (Monaco) para ficheros de texto de hasta 5 MB, con coloreado según la extensión. <kbd>Ctrl</kbd>+<kbd>S</kbd>
  guarda en el mismo fichero (conserva propietario y permisos). Si alguien lo modificó mientras estaba abierto, avisa antes
  de sobrescribir. Avisa también al cerrar con cambios sin guardar.
- **Terminal** (xterm.js) en pestañas, varios por servidor, con colores, cambio de tamaño, título de la ventana y enlaces
  clicables. Copiar <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>, pegar <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
  (en macOS, <kbd>Cmd</kbd>+<kbd>C</kbd>/<kbd>V</kbd>) o con el clic derecho. Al salir del shell, <kbd>Enter</kbd> abre otro.
- **Módulos de administración** por servidor. Se activan en el diálogo del servidor («Detectar qué hay instalado» los
  marca solos) y aparecen debajo del servidor en el panel lateral; cada uno se abre en su pestaña:
  - **Rendimiento**: gráficas de CPU (y espera a disco), carga 1/5/15 min con la línea de los núcleos, memoria y swap,
    red (recibido/enviado) y E/S de disco, con cruceta compartida: al pasar el ratón por una se marca la misma hora en
    todas. Arriba, los valores de ahora mismo y el tiempo encendido; abajo, el espacio libre de cada disco (`df`).
    - *En directo*: lee `/proc` cada 5 s mientras la pestaña está abierta (guarda la última hora). No instala nada.
    - *6 h, 24 h, 7 y 30 días*: el histórico sale de **sysstat** (`sar`/`sadf`), que guarda una muestra cada 10 minutos
      aunque la app esté cerrada. Si no está instalado (o, como en Debian/Ubuntu, viene desactivado), la vista ofrece
      instalarlo y activarlo con sudo (apt, dnf, yum, zypper o pacman). Debajo de cada gráfica, la media y el máximo del
      periodo y cuándo fue.
  - **Servicios** (systemd): lista con buscador y filtros (en marcha, fallidos, todos); estado, desde cuándo, PID y
    memoria; arrancar, parar, reiniciar, recargar, habilitar/deshabilitar al inicio; registro de `journalctl` y fichero de
    la unidad (se abre en el editor). Parar, reiniciar y deshabilitar piden confirmación; en producción, todo.
  - **Apache**: versión, servicio, sitios (activar/desactivar con `a2ensite`/`a2dissite` en Debian/Ubuntu, y después
    «probar configuración y recargar»), ficheros de configuración, `configtest`, hosts virtuales (`-S`), módulos (`-M`) y
    registro de errores.
  - **MySQL / MariaDB**: servicio, bases de datos con número de tablas y tamaño, variables de estado, procesos en curso
    (con «Matar»), ficheros `.cnf` y registro. Entra con `sudo mysql` (root por el socket, lo normal en Debian/Ubuntu) o,
    sin sudo, con el `~/.my.cnf` del usuario.
  - **Seguridad**:
    - *Resumen*: conexiones establecidas, IPs remotas, puertos expuestos, intentos SSH fallidos y accesos correctos de las
      últimas 24 h, usuarios conectados e IPs bloqueadas por fail2ban; las IPs con más intentos fallidos y las conectadas.
    - *Conexiones* (`ss`): agrupadas por IP (Internet, red interna, local; la tuya marcada como «tú») o todas, con
      filtro y refresco automático cada 5 s. Con sudo se ve qué proceso tiene cada conexión.
    - *Puertos abiertos*: qué escucha en cada puerto y si está **expuesto** (todas las interfaces) o solo en local.
    - *Accesos SSH* (journal, `auth.log` o `secure`): intentos fallidos por IP con los usuarios probados y accesos
      correctos, en 24 h, 7 o 30 días.
    - *Sesiones*: quién está conectado (`who`) y últimos accesos (`last`).
    - *Fail2ban*: jails con sus contadores, IPs bloqueadas (desbloquear) y bloqueo manual. Desde los intentos fallidos se
      puede bloquear una IP con la jail de SSH. **Nunca deja bloquear la IP desde la que estás conectado.**
    - *Cortafuegos*: estado y reglas de UFW, firewalld, nftables o iptables, solo lectura.
    - **País de cada IP** (bandera y nombre) en todas las tablas, y los intentos fallidos sumados por país. Usa la base de
      datos gratuita «IP to Country Lite» de [DB-IP](https://db-ip.com) (CC BY 4.0, unos 4 MB): se descarga cuando lo
      pides, se guarda en este equipo y las consultas son locales, así que **las IPs no se envían a ningún servicio**.
      Avisa cuando tiene más de mes y medio para actualizarla (DB-IP publica una nueva cada mes).
- **sudo**: lo que necesita root se intenta primero sin contraseña (`sudo -n`, para quien tiene NOPASSWD). Si sudo la pide,
  se pregunta una vez y se guarda solo en memoria mientras dura la conexión (si el servidor usa contraseña, se prueba
  primero esa). El editor ofrece «Abrir con sudo» / «Guardar con sudo» cuando falta permiso, y guarda sin cambiar
  propietario ni permisos del fichero.
- **Una sola conexión por servidor**: explorador, terminales y transferencias van por canales de la misma conexión SSH.
  Si se cae, las pestañas lo indican y ofrecen reconectar; el explorador vuelve a la carpeta donde estaba.

## Puesta en marcha

```bash
npm install
npm run dev          # desarrollo con recarga
npm run build        # compilar
npm start            # ejecutar lo compilado
npm run dist:linux   # AppImage (también dist:win y dist:mac)
```

Requiere Node 24.

## Actualizaciones automáticas

La app busca versiones nuevas al arrancar (a los 10 s) y cada 6 horas en las Releases publicadas de GitHub. No descarga
nada sin preguntar: en la barra de estado aparece «Versión X disponible», y desde ahí se descarga y se instala al reiniciar
(o al cerrar la app). Pulsando el número de versión de la barra de estado se busca a mano.

- **Linux**: solo con el AppImage (el fichero se sustituye por el nuevo).
- **Windows**: el instalador nuevo se ejecuta en silencio y vuelve a abrir la app.
- **macOS**: abre el `.dmg` en el navegador (ver limitaciones).

El registro queda en `logs/updater.log` dentro de la carpeta de datos.

Para publicar una versión: subir `version` en `package.json`, etiquetar `vX.Y.Z` y subir la etiqueta. El CI genera los
instaladores y los `latest*.yml` en una Release en borrador; al publicarla, las apps instaladas la detectan.

## Claude (servidor MCP)

La app incluye un servidor MCP local para que Claude analice y, si lo permites, administre tus servidores. Se configura
desde el botón «Claude MCP» de la barra de estado (viene desactivado).

> **Cuidado.** Un agente puede equivocarse, y los registros que lee pueden contener instrucciones maliciosas (*prompt
> injection*). Da el mínimo acceso necesario.

**Acceso por servidor** (por defecto, ninguno):

| Nivel | Qué puede hacer Claude |
| --- | --- |
| Sin acceso | No ve el servidor. |
| Solo lectura | `ssh_access_report` (fallos por IP con país, accesos correctos), `network_connections`, `active_sessions`, `fail2ban_status`, `firewall_status`, `services_list`, `service_logs`, `server_performance` (CPU, carga, memoria, red y disco de ahora y, con sysstat, resumen e histórico del periodo). |
| Ejecución con mi aprobación | Además `run_command`, `fail2ban_ban` y `service_action`: la app enseña el comando y no se ejecuta hasta pulsar «Ejecutar» (5 minutos para responder; si no, se rechaza). |
| Ejecución sin preguntar | Igual, sin confirmación. En producción se rebaja siempre a «con mi aprobación». |

- Si el servidor está conectado en la app, Claude usa esa conexión (y su contraseña de sudo, que nunca le llega). Si no,
  abre una conexión propia con los datos guardados, que se cierra tras 10 minutos sin uso o al cambiar el acceso.
- Escucha solo en `127.0.0.1` (puerto 47821 por defecto) con un token Bearer aleatorio (en `mcp.json`, 0600). Rechaza
  peticiones de navegador (con `Origin`) y cabeceras `Host` que no sean de loopback.
- Cada llamada aparece en «Actividad reciente», con el comando ejecutado.

**Claude Desktop:** «Crear extensión (.mcpb)…» y luego «Instalar en Claude Desktop» (o arrastra el fichero a Ajustes →
Extensiones). La extensión es un puente stdio ↔ HTTP (`src/mcp-bridge/bridge.cjs`) que lee puerto y token del
`mcp.json` de la app, así que no hay que reinstalarla si cambian. Con la app cerrada, explica a Claude qué hacer.

**Claude Code:** el diálogo da el comando, del estilo
`claude mcp add --scope user --transport http gestor-ssh http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"`.

## Arquitectura

```
┌──────────────── Proceso principal (Node) ────────────────┐      ┌──── Renderer (sandbox) ─────┐
│ ipc.ts        valida cada llamada con zod                │ IPC  │ React + Monaco + xterm.js   │
│ ssh/          ssh2: conexión, huellas, SFTP, shell       │◀────▶│ Sin acceso a Node ni red    │
│ transfers.ts  cola de descargas/subidas (fastGet/Put)    │      │ CSP: solo recursos propios  │
│ store/        servers.json · secrets.json (cifrado)      │ Port │                             │
│               known_hosts.json                           │◀────▶│ un MessagePort por terminal │
└──────────────────────────────────────────────────────────┘      └─────────────────────────────┘
```

| Carpeta | Contenido |
| --- | --- |
| `src/shared` | Tipos, rutas POSIX del servidor, formato (tamaños, permisos) y comillas de shell. Lo usan los dos procesos. |
| `src/main/ssh` | Conexión con verificación de huella, envoltorio de SFTP con promesas, sesiones por servidor y terminal. |
| `src/main/store` | Servidores, secretos cifrados y huellas conocidas, en ficheros JSON 0600. |
| `src/main/transfers.ts` | Cola de transferencias con progreso y cancelación. |
| `src/main/modules.ts` | Llamadas de los módulos (servicios, Apache, MySQL), con sus argumentos validados con zod. |
| `src/main/ssh/commands.ts` | Ejecución de scripts en el servidor, con sudo. |
| `src/main/security.ts` | Llamadas del módulo de seguridad (ss, registro de sshd, who/last, fail2ban, cortafuegos). |
| `src/main/performance.ts` | Llamadas del módulo de rendimiento: lectura de `/proc` y `df`, histórico con `sadf` e instalación de sysstat. |
| `src/main/updater.ts` | Actualizaciones con electron-updater: buscar, descargar con progreso e instalar al reiniciar. |
| `src/main/geoip.ts` | Descarga, comprobación y consulta local de la base de datos de países (mmdb-lib). |
| `src/shared/security.ts` | Analizadores de `ss`, del registro de sshd, de `who` y de fail2ban, y clasificación de IPs. |
| `src/shared/modules.ts` | Tipos de los módulos y analizadores de la salida de `systemctl`, `apachectl` y `mysql`. |
| `src/shared/performance.ts` | Analizadores de `/proc`, `df` y `sadf -d`, cálculo de tasas entre lecturas y resúmenes. |
| `src/shared/chart-scale.ts` | Escalas de las gráficas (divisiones redondas, marcas horarias). Las gráficas son SVG propio, sin librerías. |
| `src/preload` | Puente mínimo que expone `window.api` y entrega los MessagePort de los terminales. |
| `src/renderer` | Interfaz React. |
| `tests` | Unitarios e integración contra un `sshd` desechable (Vitest). |
| `e2e` | La app completa con Playwright contra ese mismo `sshd`. |

Decisiones:

- **SFTP en lugar de SCP**: `ssh2` no implementa SCP, y SFTP permite listar, leer por trozos en paralelo
  (`fastGet`/`fastPut`), dar progreso y cancelar.
- **Terminal por `MessagePort`**: cada terminal tiene su propio canal entre el proceso principal y la ventana. La salida se
  agrupa cada 5 ms y hay control de flujo (si la ventana no da abasto, se deja de leer del servidor hasta que pinte), así
  que un `cat` de un log enorme no bloquea la app.
- **Sin módulos nativos**: `ssh2` es JS puro y xterm.js corre en la ventana. No hace falta `node-pty` (solo serviría para
  un terminal *local*), así que se empaqueta igual en los tres sistemas sin recompilar nada.
- **Scripts en base64**: los comandos de los módulos se mandan como `sh -c 'eval "$(printf %s <base64> | base64 -d)"'`.
  Así el shell de login del usuario (bash, zsh, fish, csh…) no interpreta nada y el script llega intacto a `sh`. La entrada
  estándar queda solo para la contraseña de sudo, que solo se envía después de que `sudo -n` diga que hace falta; para
  escribir como root, el contenido va antes por SFTP a un temporal 0600 y `sudo` lo vuelca con `cat tmp > destino`.
- **Las rutas locales nunca vienen de la ventana**: los diálogos de guardar y abrir los abre el proceso principal, y la
  subida se confirma con un token, no con rutas.

Los datos de la app se guardan en la carpeta de datos de Electron (`~/.config/Gestor SSH/` en Linux): `servers.json`,
`secrets.json` y `known_hosts.json`, todos con permisos 0600, y la base de datos de países en `geoip/` si se descarga.

## Tests

```bash
npm run typecheck
npm test             # unitarios + integración
npm run test:e2e     # app completa (abre una ventana)
```

Los tests de integración y el E2E arrancan su propio servidor OpenSSH **sin root**, en `127.0.0.1` y un puerto libre, con
claves recién generadas, y entran con el usuario que ejecuta los tests (`tests/sshd.ts`). Solo necesitan `sshd`,
`sftp-server` y `ssh-keygen` instalados; si no están, se saltan. Trabajan en una carpeta temporal que se borra al acabar.

Los tests de sudo nunca envían una contraseña: con NOPASSWD (como en CI) prueban leer y escribir un fichero de root; sin
él, solo comprueban que la app pide la contraseña. Una contraseña incorrecta contaría como intento fallido y
`pam_faillock` podría bloquear la cuenta de quien ejecuta los tests.

`GEOIP_NETWORK=1` añade las pruebas que descargan la base de datos de países real de db-ip.com (en CI no se hacen, para
no depender de la red).

`E2E_SCREENSHOTS=/ruta npm run test:e2e` guarda una captura de cada paso. `GESTOR_SCREENSHOT=/ruta.png npm start` guarda una
captura de la ventana y cierra la app (solo fuera de la app empaquetada).

## Seguridad

- Renderer con `sandbox`, `contextIsolation`, sin `nodeIntegration`, sin navegación externa y con CSP estricta sin CDN.
- Todo lo que llega por IPC se valida con zod y solo se atiende si viene de la ventana de la app. Lo que llega por el
  `MessagePort` del terminal también se valida.
- El renderer nunca recibe contraseñas descifradas ni elige rutas locales.
- Contraseñas con `safeStorage`. En Linux, si el sistema solo ofrece `basic_text` (clave fija), no se escriben en disco.
- Huellas de servidor confirmadas por el usuario; una huella cambiada bloquea la conexión.
- Permisos de la ventana: solo el portapapeles (para el terminal); el resto se deniega.

## Limitaciones conocidas

- **Permisos**: el explorador y las transferencias van con el usuario de la conexión; solo el editor y los módulos usan
  sudo. Para subir ficheros a carpetas de root, súbelos a tu carpeta y muévelos desde el terminal.
- **Seguridad**: el cortafuegos es de solo lectura (cambiar reglas a distancia puede dejarte fuera); para bloquear IPs
  hace falta fail2ban. En los ficheros de syslog no se filtra por fecha (no guardan el año): se analiza lo último.
  Sin sudo, `ss` no enseña los procesos de otros usuarios y el registro de accesos puede estar incompleto.
- **Módulos**: necesitan systemd. Activar/desactivar sitios de Apache solo con la estructura de Debian/Ubuntu; en
  Red Hat y Arch se listan y se editan. MySQL sin sudo necesita un `~/.my.cnf` en el servidor.
- **Rendimiento**: solo Linux (lee `/proc`). Sin sysstat solo hay datos desde que se abre la pestaña; con sysstat, la
  resolución del histórico es la suya (10 minutos por defecto). La red no cuenta `lo` ni las interfaces virtuales de
  contenedores y puentes; el disco cuenta los discos enteros (no particiones ni LVM, para no contar dos veces).
- **SSH**: sin saltos encadenados (*jump hosts*), sin leer `~/.ssh/config` y sin reenvío de puertos todavía.
- **Transferencias**: no se reanudan; si se corta la conexión, hay que volver a empezar. No se puede arrastrar ficheros
  desde el escritorio a la ventana.
- **Editor**: ficheros UTF-8 de hasta 5 MB. Los binarios o con otra codificación se descargan.
- **Terminal**: si la conexión se cae, la sesión del shell se pierde (usa `tmux` en el servidor si necesitas que sobreviva).
- **Actualizaciones en macOS**: sin firma Developer ID, la app avisa de la versión nueva y abre el `.dmg` en el navegador;
  hay que instalarla a mano.

## Créditos

Países de las IPs: [IP Geolocation by DB-IP](https://db-ip.com), con licencia
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). La base de datos no va dentro de la app: se descarga aparte.
