# Gestor SSH

Gestor de servidores por SSH de escritorio: **explorador de ficheros** (SFTP), **descargas y subidas** con progreso,
**editor** de ficheros remotos y **terminal**, todo sobre una misma conexión. Está hecho con Electron, TypeScript y React,
con el mismo estilo que [Gestor BBDD](https://github.com/JesusLizAlles/gestor-bbdd).

Es un proyecto con [licencia MIT](LICENSE). Estado: **MVP (0.2.0)**.

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
  - **Servicios** (systemd): lista con buscador y filtros (en marcha, fallidos, todos); estado, desde cuándo, PID y
    memoria; arrancar, parar, reiniciar, recargar, habilitar/deshabilitar al inicio; registro de `journalctl` y fichero de
    la unidad (se abre en el editor). Parar, reiniciar y deshabilitar piden confirmación; en producción, todo.
  - **Apache**: versión, servicio, sitios (activar/desactivar con `a2ensite`/`a2dissite` en Debian/Ubuntu, y después
    «probar configuración y recargar»), ficheros de configuración, `configtest`, hosts virtuales (`-S`), módulos (`-M`) y
    registro de errores.
  - **MySQL / MariaDB**: servicio, bases de datos con número de tablas y tamaño, variables de estado, procesos en curso
    (con «Matar»), ficheros `.cnf` y registro. Entra con `sudo mysql` (root por el socket, lo normal en Debian/Ubuntu) o,
    sin sudo, con el `~/.my.cnf` del usuario.
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
| `src/shared/modules.ts` | Tipos de los módulos y analizadores de la salida de `systemctl`, `apachectl` y `mysql`. |
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
`secrets.json` y `known_hosts.json`, todos con permisos 0600.

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
- **Módulos**: necesitan systemd. Activar/desactivar sitios de Apache solo con la estructura de Debian/Ubuntu; en
  Red Hat y Arch se listan y se editan. MySQL sin sudo necesita un `~/.my.cnf` en el servidor.
- **SSH**: sin saltos encadenados (*jump hosts*), sin leer `~/.ssh/config` y sin reenvío de puertos todavía.
- **Transferencias**: no se reanudan; si se corta la conexión, hay que volver a empezar. No se puede arrastrar ficheros
  desde el escritorio a la ventana.
- **Editor**: ficheros UTF-8 de hasta 5 MB. Los binarios o con otra codificación se descargan.
- **Terminal**: si la conexión se cae, la sesión del shell se pierde (usa `tmux` en el servidor si necesitas que sobreviva).
- **Actualizaciones**: no hay actualización automática todavía; las versiones se publican en las Releases del repositorio.
