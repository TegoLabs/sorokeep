<p align="center">
  <h1 align="center">Sorokeep</h1>
  <p align="center">
    <a href="README.md">English</a>
    &middot;
    <a href="README.es.md">Español</a>
    &middot;
    <a href="README.pt.md">Português (Brasil)</a>
    &middot;
    <a href="README.zh.md">简体中文</a>
  </p>
  <p align="center">
    La capa de operaciones faltante para contratos inteligentes Soroban desplegados.
    <br />
    Monitorea los TTLs. Recibe alertas antes de la expiración. Extiende el almacenamiento automáticamente. Restaura entradas archivadas.
    <br />
    <br />
    <a href="#install">Instalación</a>
    &middot;
    <a href="#quick-start">Inicio Rápido</a>
    &middot;
    <a href="#commands">Comandos</a>
    &middot;
    <a href="#alerting">Alertas</a>
    &middot;
    <a href="#contributing">Contribución</a>
  </p>
</p>

<br />

## Por qué existe esto

*(¿No estás familiarizado con la terminología de Soroban/Stellar como TTL, footprint o entrada del libro mayor? Consulta el [Glosario](docs/glossary.md).)*

El modelo de almacenamiento de Soroban es inusual entre las principales plataformas de contratos inteligentes: **el estado expira.** Cada entrada del libro mayor (instancias de contratos, almacenamiento persistente, código WASM) tiene un Tiempo de Vida (TTL). Cuando se agota, la entrada se archiva. Si la entrada de instancia de un contrato expira, el contrato completo deja de funcionar. Si las entradas de almacenamiento persistente expiran, los datos de los usuarios se vuelven inaccesibles hasta que alguien pague para restaurarlos.

Esto es por diseño: el archivado de estado mantiene a Stellar ligero y escalable. Pero significa que **debes gestionar activamente el ciclo de vida del estado de tu contrato, o morirá.**

Actualmente no existe una herramienta de código abierto dedicada que combine monitoreo de TTL, alertas, extensión automática, seguimiento de costos y restauración para contratos Soroban. Los desarrolladores usan comandos manuales de la CLI, construyen scripts ad-hoc o integran la lógica de extensión de TTL directamente en sus contratos.

Sorokeep es la capa de operaciones unificada que maneja todo esto.

> Los auditores de seguridad han comenzado a señalar el mal manejo del TTL como un área de riesgo en los contratos Soroban. [Veridise](https://veridise.com/audits/soroban/) incluye el manejo del TTL en el alcance de sus auditorías. La [auditoría del endpoint de LayerZero en Stellar](https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint) lista explícitamente los casos extremos de expiración del TTL como una preocupación. La [biblioteca de contratos Stellar de OpenZeppelin](https://docs.openzeppelin.com/stellar-contracts) deja deliberadamente la gestión del TTL del almacenamiento de instancias al desarrollador de la aplicación.

## Seguridad y SBOM

Sorokeep genera una Lista de Materiales de Software (SBOM) en formato CycloneDX para cada release. Puedes encontrar el archivo `bom.json` adjunto como recurso de la release en la [página de Releases de GitHub](https://github.com/AbdulmalikAlayande/sorokeep/releases).

## Características

- **Observación e Introspección** — Registra contratos, descubre footprints a partir de transacciones en cadena y especificaciones de introspección
- **Monitoreo** — Sondeo continuo del TTL con intervalos configurables mediante un demonio de larga duración
- **Alertas** — Notificaciones multicanal respaldadas por colas y desacopladas (Webhook con HMAC-SHA256, Slack Block Kit, Discord, Telegram, PagerDuty) con una robusta lógica de reintentos para TTLs bajos, picos de uso de recursos y cambios de estado
- **Auto-Extensión** — Extensión automática del TTL basada en políticas con simulación de transacciones antes del envío a través de `ExtendFootprintTTLOp`
- **Restauración** — Recupera entradas archivadas a través de `RestoreFootprintOp` con simulación previa al envío
- **Seguimiento de Costos y Recursos** — Rastrea el historial de extensiones, costos en XLM, proyecciones a 30 días, registros de uso de recursos e impone presupuestos mensuales configurables para evitar gastos descontrolados
- **Inspección** — Inspecciona el estado en la cadena, analiza saldos de tokens SAC y compara cambios de estado
- **Canales** — Gestiona cuentas de canal financiadas para envíos de transacciones concurrentes sin cuellos de botella en la secuencia
- **Local Primero** — Todo el estado se almacena en una cola respaldada por una base de datos SQLite. Sin servicios externos más allá de un endpoint RPC de Stellar
- **Preparado para IA** — Servidor Model Context Protocol (MCP) incorporado que expone herramientas para que los agentes de IA interactúen con los datos de Sorokeep de forma nativa
- **Seguridad Avanzada** — Se integra con AWS Secrets Manager y HashiCorp Vault para una resolución segura de claves
- **Implementaciones Listas para Producción** — Incluye Dockerfile, plantillas de servicio systemd y GitHub Actions para la integración CI/CD

## Instalación

**Requisitos:** Node.js 22+

```bash
# Desde el código fuente
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
npm run build

# Ejecutar directamente
npx tsx src/index.ts --help

# O enlazar globalmente después de compilar
npm link
sorokeep --help

# Instalar la página man local
mkdir -p ~/.local/share/man/man1
cp man/sorokeep.1 ~/.local/share/man/man1/
mandb 2>/dev/null || true
man sorokeep
```

<!--
# npm (próximamente)
npm install -g sorokeep
-->

## Inicio Rápido

```bash
# 1. Registrar un contrato para su monitoreo
sorokeep watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --network testnet \
  --name "XLM Native Token"

# 2. Verificar su estado de TTL actual
sorokeep status CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 3. Configurar una alerta de webhook (se activa cuando el TTL cae por debajo de 20,000 libros mayores)
sorokeep alerts add \
  --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --type webhook \
  --url https://your-server.com/webhook \
  --threshold 20000

# 4. Iniciar el demonio de monitoreo
sorokeep daemon --network testnet
```

El demonio comprobará los TTLs cada 5 minutos, disparará alertas cuando se crucen los umbrales, enviará notificaciones de resolución cuando los TTLs se recuperen y extenderá automáticamente las entradas si se configuran políticas de guardia.

## Comandos

### Opciones Globales

Las siguientes opciones se pueden usar con cualquier comando:

| Opción | Descripción |
|--------|-------------|
| `-y, --yes` | Omite todas las confirmaciones en comandos destructivos (p. ej., `unwatch`). Útil en scripts y pipelines de CI para ejecución no interactiva. |
| `-h, --help` | Muestra la ayuda de cualquier comando o subcomando. |
| `-V, --version` | Imprime la versión de Sorokeep. |

> **Nota:** `--yes` solo omite las confirmaciones interactivas. Para el comando `check`, usa `--force` (ver más abajo) para omitir los fallos de código de salida en CI.

### `sorokeep watch <contract-id>`

Registra un contrato para su monitoreo. Se conecta al RPC de Stellar, descubre la instancia del contrato y las entradas de código WASM, lee sus TTLs y almacena todo localmente.

```bash
sorokeep watch <contract-id> [options]
```

| Opción | Descripción | Por defecto |
|--------|-------------|---------|
| `-n, --name <name>` | Nombre legible por humanos del contrato | — |
| `--network <network>` | `testnet` o `mainnet` | `testnet` |
| `-r, --rpc-url <url>` | Endpoint RPC de Stellar personalizado | Valor por defecto de la red |
| `--storage-keys <keys>` | Claves de almacenamiento XDR en base64 separadas por comas a rastrear | — |

**Ejemplo de salida:**

```
$ sorokeep watch CDLZFC3S...CYSC --network testnet --name "XLM Native Token"

✔ Contract XLM Native Token registered successfully.

  Contract: XLM Native Token (CDLZFC3S...CYSC)
  Network:  testnet
  Entries:  1 discovered
  Instance TTL: 113,918 ledgers (~7d 6h)  OK

  Run 'sorokeep status CDLZFC3S...CYSC' to check TTLs anytime.
  Run 'sorokeep guard CDLZFC3S...CYSC' to enable auto-extension.
```

El descubrimiento de entradas ocurre en capas:

1. **Determinista** (automático) — Entradas de instancia de contrato y código WASM, derivadas del ID del contrato y el hash WASM. Siempre se rastrean.
2. **Basado en Footprint** (demonio) — Descubiertas escaneando eventos de transacciones en la cadena en busca de claves de almacenamiento que utiliza tu contrato.
3. **Manual** (opcional) — Claves de almacenamiento específicas declaradas a través de `--storage-keys`.

---

### `sorokeep status <contract-id>`

Muestra la salud actual del TTL para un contrato registrado. Lee de la base de datos local — sin llamadas RPC.

```bash
sorokeep status <contract-id>
```

Muestra el nombre del contrato, la red, el último libro mayor comprobado y una tabla con todas las entradas rastreadas con el TTL restante en libros mayores y tiempo legible por humanos, además de un indicador de estado (OK / Warning / Critical).

---

### `sorokeep daemon`

Inicia el proceso de monitoreo de larga duración.

```bash
sorokeep daemon [options]
```

| Opción | Descripción | Por defecto |
|--------|-------------|---------|
| `--network <network>` | Red a monitorear | `testnet` |
| `--interval <ms>` | Intervalo de sondeo en milisegundos (mín: 10,000) | `300000` (5 min) |
| `-r, --rpc-url <url>` | Endpoint RPC personalizado | Valor por defecto de la red |

Cada ciclo realiza tres fases:

1. **Monitorear** — Obtiene nuevos TTLs para todos los contratos, detecta el cruce de umbrales, resuelve alertas recuperadas.
2. **Entregar** — Envía las alertas pendientes a los webhooks y canales de Slack configurados.
3. **Auto-Extender** — Extiende los TTLs para los contratos con políticas de guardia activas.

El demonio maneja el apagado correcto con `SIGINT`/`SIGTERM` e incluye una protección de reingreso para evitar ciclos superpuestos.

---

### `sorokeep alerts`

Gestiona las configuraciones de alertas. Soporta cinco subcomandos.

#### `alerts add` — Crear una nueva alerta

```bash
sorokeep alerts add [options]
```

| Opción | Descripción |
|--------|-------------|
| `--contract <id>` | ID del contrato para la alerta (requerido) |
| `--type <type>` | `webhook` o `slack` (requerido) |
| `--url <url>` | URL POST del webhook (requerido para webhook) |
| `--channel <channel>` | Nombre o ID del canal de Slack (requerido para slack) |
| `--threshold <ledgers>` | Disparar cuando el TTL restante caiga por debajo de esto (requerido) |
| `--secret <secret>` | Secreto de firma HMAC para webhooks (generado automáticamente si se omite) |

Para las alertas de webhook, se genera automáticamente un secreto de firma HMAC (32 bytes hexadecimales) si no proporcionas uno. El secreto se muestra una vez al momento de la creación — guárdalo para verificar las firmas del webhook en tu servidor. Consulta [Firma de Webhook](#webhook-signing) para obtener detalles.

#### `alerts list` — Ver alertas configuradas

```bash
sorokeep alerts list --contract <id>
```

#### `alerts remove` — Eliminar una configuración de alerta

```bash
sorokeep alerts remove --id <config-id>
```

#### `alerts test` — Enviar una alerta de prueba

```bash
sorokeep alerts test --id <config-id>
```

Dispara un evento sintético `threshold_crossed` a través de la canalización de entrega real. Útil para verificar que tu endpoint de webhook o canal de Slack esté configurado correctamente antes de pasar a producción.

#### `alerts history` — Ver el historial de actividad de alertas

```bash
sorokeep alerts history --contract <id> [--limit 20]
```

Muestra una tabla de alertas disparadas: marca de tiempo, etiqueta de la entrada, TTL en el momento de disparo, tipo de canal, estado de entrega, recuento de reintentos y tiempo de resolución.

---

### `sorokeep guard`

Configura las políticas de auto-extensión. Cuando está habilitado, el demonio extiende automáticamente los TTLs enviando transacciones `ExtendFootprintTTLOp` usando un par de claves de Stellar financiado.

```bash
sorokeep guard <contract-id> [options]
```

| Opción | Descripción | Por defecto |
|--------|-------------|---------|
| `--target-ttl <ledgers>` | TTL al que extender las entradas | `100000` |
| `--threshold <ledgers>` | Extender cuando el TTL caiga por debajo de esto | `20000` |
| `--keypair <secret>` | Clave secreta de Stellar (para extensión única) | — |
| `--keypair-env <var>` | Nombre de la variable de entorno que contiene la clave secreta | — |
| `--auto-extend` | Habilitar auto-extensión por el demonio (requiere `--keypair-env`) | — |
| `--dry-run` | Simular extensión y mostrar tarifa estimada | — |
| `--disable` | Deshabilitar auto-extensión para este contrato | — |

**Modos de uso:**

```bash
# Comprobar la política actual
sorokeep guard <contract-id>

# Ejecución en seco — ver tarifa estimada sin enviar
sorokeep guard <contract-id> --keypair S... --dry-run

# Extensión inmediata de una sola vez
sorokeep guard <contract-id> --keypair S...

# Habilitar auto-extensión para el demonio
sorokeep guard <contract-id> --keypair-env STELLAR_SECRET_KEY --auto-extend

# Deshabilitar auto-extensión
sorokeep guard <contract-id> --disable
```

**Seguridad:** Las claves secretas nunca se almacenan en la base de datos. Al usar `--auto-extend`, solo la clave pública y el nombre de la variable de entorno se persisten. El demonio resuelve la clave secreta real desde el entorno en tiempo de ejecución.

---

### `sorokeep costs`

Ver el historial de extensiones y los gastos de alquiler para un contrato.

```bash
sorokeep costs <contract-id> [options]
```

| Opción | Descripción | Por defecto |
|--------|-------------|---------|
| `--period <days>` | Mostrar costos para los últimos N días | `30` |
| `--all` | Mostrar todo el historial | — |

**La salida incluye:**

- Extensiones totales y costo total en XLM
- Desglose por tipo de entrada (instancia, wasm, persistente) con cantidad y costo
- Proyección de costos a 30 días extrapolada a partir del período seleccionado
- Tabla de extensiones recientes: marca de tiempo, etiqueta de la entrada, TTL antiguo → nuevo TTL, costo en XLM, hash de la transacción

---

### `sorokeep restore`

Recuperar entradas del libro mayor archivadas a través de transacciones `RestoreFootprintOp`.

```bash
sorokeep restore <contract-id> [options]
```

| Opción | Descripción |
|--------|-------------|
| `--keypair <secret>` | Clave secreta de Stellar |
| `--keypair-env <var>` | Variable de entorno que contiene la clave secreta |
| `--entry <keyXdr>` | Entrada específica de clave XDR para restaurar (repetible) |
| `--all` | Restaurar todas las entradas rastreadas para el contrato |

Se requiere uno de `--keypair` o `--keypair-env`. Se requiere uno de `--entry` o `--all` (mutuamente excluyentes).

```bash
# Restaurar una entrada específica
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --entry <base64-xdr>

# Restaurar todas las entradas rastreadas
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all
```

---

### `sorokeep resources`

Ver registros de uso de recursos (instrucciones de CPU, bytes de memoria, estructuras de tarifas) para un contrato con el fin de realizar un seguimiento de la eficiencia de la ejecución a lo largo del tiempo.

---

### `sorokeep budget`

Establecer y monitorear un presupuesto mensual de extensión en XLM para un contrato. Previene costos descontrolados si un contrato requiere extensiones frecuentes.

---

### `sorokeep channels`

Gestionar cuentas de canal financiadas que se utilizan para enviar transacciones de extensión y restauración concurrentemente, evitando los cuellos de botella del número de secuencia.

---

### `sorokeep inspect`

Inspeccionar el estado en cadena directamente. Puede analizar saldos de tokens de Contratos de Activos de Stellar (SAC), comparar cambios de estado y decodificar XDR sin intervención manual.

---

### `sorokeep check`

Realizar una ejecución única y ad-hoc del ciclo de monitoreo sin iniciar el demonio de larga duración.

---

### `sorokeep db`

Tareas de gestión de la base de datos, incluyendo migraciones, copias de seguridad y gestión de la caché de introspección.

---

### `sorokeep completion`

Generar scripts de autocompletado del shell para bash/zsh para habilitar el completado con tabulador para todos los comandos de Sorokeep.

### `sorokeep contracts`

Lista todos los contratos monitoreados de un vistazo — una vista de índice útil cuando gestionas más de unos pocos contratos.

```bash
sorokeep contracts [options]
```

| Opción | Descripción |
|--------|-------------|
| `--network <network>` | Filtra por `testnet` o `mainnet` |
| `--json` | Salida en formato JSON legible por máquina |

Muestra una tabla con el ID del contrato (truncado), nombre, red, cantidad de entradas, TTL restante en el peor caso y estado (OK / Advertencia / Crítico / Expirado). Lee solo de la base de datos local — instantáneo, sin llamadas RPC.

## Alertas

Sorokeep entrega alertas a través de múltiples canales: **webhooks**, **Slack**, **Discord**, **Telegram**, **PagerDuty**, **Opsgenie**, **Microsoft Teams**, **Matrix**, **email**, **Google Chat**, y un segundo canal configurable de **Webhook v2**. Cada alerta incluye un nivel de severidad y un contexto rico sobre la entrada afectada. Sorokeep utiliza una arquitectura de detección y despacho robusta y desacoplada con una cola respaldada por base de datos.

### Comparación de Canales Compatibles

| Canal                | Método de Autenticación                                                | Límite de Tasa Típico                    | Formato del Payload              | Complejidad de Configuración |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------- | ----------------------------- |
| **Webhook**         | HMAC-SHA256 (`X-Sorokeep-Signature`) / Secreto                            | Ilimitado (según el destino)                | JSON genérico                       | Baja                          |
| **Webhook v2**      | HMAC-SHA256 (`X-Sorokeep-Signature`) / Secreto, headers personalizados     | Ilimitado (según el destino)                | JSON genérico                       | Baja                          |
| **Slack**           | Token OAuth de Bot (`xoxb-...`) / URL de Webhook                          | 1 solicitud/seg                             | JSON Slack Block Kit                | Baja                          |
| **PagerDuty**       | Clave de Enrutamiento Events API v2                                       | 120 solicitudes/min                         | JSON PagerDuty Event v2             | Baja                          |
| **Opsgenie**        | Clave de API                                                              | Según el plan                               | JSON Opsgenie Alert API             | Baja                          |
| **Discord**         | URL de Webhook                                                            | 30 solicitudes/min por webhook              | JSON Discord Embed                  | Baja                          |
| **Telegram**        | Token de Bot (`SOROKEEP_TELEGRAM_BOT_TOKEN`)                              | 30 msg/seg en total (1 msg/seg por chat)    | Texto formateado HTML / Markdown    | Media                         |
| **Microsoft Teams** | URL de Webhook (por tenant)                                               | Según el conector                           | JSON Teams MessageCard              | Baja                          |
| **Matrix**          | ID de Sala                                                                | Según el homeserver                         | Evento Matrix `m.room.message`      | Media                         |
| **Email**           | Credenciales SMTP (host/puerto/usuario/contraseña)                        | Según el proveedor SMTP                     | Texto plano + HTML                  | Media                         |
| **Google Chat**     | URL de Webhook                                                            | Según el espacio                            | JSON de tarjeta de Google Chat      | Baja                          |

> ¿Necesitas un canal que no está en la lista? Consulta [Agregar un Canal de Alerta](docs/adding-an-alert-channel.md) para implementar un plugin de canal personalizado.

### Ciclo de vida de la alerta

1. **Umbral Cruzado** — Durante cada ciclo de monitoreo, si el TTL restante de una entrada cae por debajo de un umbral configurado, el monitor escribe una alerta `threshold_crossed` en la cola de la base de datos.
2. **Entrega** — El despachador lee las filas no entregadas de la cola y enruta la alerta al canal configurado. Las entregas fallidas se reintentan en ciclos posteriores, hasta 5 intentos, y luego se abandonan de forma controlada. El éxito marca la fila como entregada.
3. **Resolución** — Cuando el TTL se recupera pasando el umbral (p. ej., después de una extensión), Sorokeep dispara una notificación `alert_resolved` a todos los canales configurados.

### Niveles de Severidad

La severidad se calcula automáticamente basándose en cuánto TTL queda en relación con el umbral configurado:

| Severidad | Condición | Descripción |
|----------|-----------|-------------|
| **critical** | TTL restante < 25% del umbral, o TTL = 0 | La entrada está en peligro inmediato de archivado |
| **warning** | TTL restante está por debajo del umbral pero por encima del 25% | La entrada necesita atención pronto |
| **info** | Alerta resuelta (TTL recuperado) | La entrada vuelve a estar saludable |

### Entrega por Webhook

Las alertas de webhook se entregan como solicitudes HTTP POST con un cuerpo JSON:

```json
{
  "type": "threshold_crossed",
  "severity": "warning",
  "contractId": "CDLZFC3S...",
  "contractName": "XLM Native Token",
  "network": "testnet",
  "entry": {
    "keyXdr": "AAAA1234...",
    "type": "instance",
    "label": "Contract Instance"
  },
  "threshold": {
    "configuredLedgers": 20000,
    "currentRemainingLedgers": 8500,
    "approximateTimeRemaining": "~13h 0m"
  },
  "firedAtLedger": 2500000,
  "timestamp": "2026-06-13T12:00:00.000Z"
}
```

### Firma de Webhook

Las solicitudes de webhook incluyen una firma HMAC-SHA256 en el encabezado `X-Sorokeep-Signature` para la verificación del payload:

```
X-Sorokeep-Signature: sha256=a1b2c3d4e5f6...
```

Para verificar en tu servidor:

```javascript
import { createHmac } from "node:crypto";

function verifySignature(payload, signature, secret) {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return signature === expected;
}
```

El secreto de firma se genera automáticamente cuando creas una alerta de webhook (o puedes proporcionar el tuyo propio con `--secret`). Se muestra una vez al momento de la creación — guárdalo de forma segura.

### Entrega por Slack

Las alertas de Slack se envían a través de la [API Web de Slack](https://api.slack.com/methods/chat.postMessage) usando Block Kit para formato enriquecido. Los mensajes incluyen iconos de severidad, detalles del contrato, TTL restante y sugerencias de acción.

**Configuración:**

1. Crea una aplicación de Slack con alcance `chat:write` en [api.slack.com/apps](https://api.slack.com/apps)
2. Instala la aplicación en tu espacio de trabajo y copia el Bot User OAuth Token (`xoxb-...`)
3. Proporciona el token mediante una variable de entorno:

```bash
export SOROKEEP_SLACK_TOKEN=xoxb-your-bot-token
```

Alternativamente, guarda el token en tu archivo de configuración en `~/.sorokeep/config.yaml`:

```yaml
slackToken: "xoxb-your-bot-token"
```

La variable de entorno tiene prioridad sobre el archivo de configuración.

### Política de Reintentos

Las entregas fallidas de alertas se reintentan automáticamente en ciclos posteriores del demonio. Después de **5 fallos consecutivos**, la alerta se abandona y no se realizan más intentos de entrega. Puedes ver el estado de entrega y los recuentos de reintentos con `sorokeep alerts history`.

## Cómo Funciona

Sorokeep es una herramienta de monitoreo fuera de la cadena. Lee datos del RPC de Stellar, los almacena localmente en SQLite y actúa sobre ellos (alertas, auto-extensión, restauración). No se ejecuta en la cadena y no requiere que modifiques tus contratos.

```mermaid
sequenceDiagram
    participant Loop as loop.ts
    participant Monitor as monitor.ts
    participant Extension as extension.ts
    participant Dispatcher as dispatcher.ts
    participant DB as repositories.ts

    Note over Loop: executeCycle() tick

    Loop->>Monitor: runMonitorCycle()
    activate Monitor
    
    Note over Monitor: 1. Batch-fetch TTLs<br/>2. Update DB<br/>3. Threshold detection
    
    Monitor->>Extension: runAutoExtensions()
    activate Extension
    Note over Extension: Evaluate policies &<br/>submit ExtendFootprintTTLOp
    Extension-->>Monitor: Extension results
    deactivate Extension
    
    Monitor-->>Loop: MonitorCycleResult
    deactivate Monitor

    Loop->>Dispatcher: deliverPendingAlerts()
    activate Dispatcher
    Note over Dispatcher: Route queued alerts to channels<br/>(Webhook, Slack, etc.)
    Dispatcher-->>Loop: Delivery stats
    deactivate Dispatcher

    Loop->>DB: aggregateDailyCostSnapshots()
    activate DB
    Note over DB: Roll extension_history<br/>into cost_daily_snapshots
    DB-->>Loop: void
    deactivate DB
```

### El Ciclo del Demonio

En cada intervalo de sondeo (por defecto: 5 minutos), el demonio ejecuta tres fases:

1. **Monitorear** — Para cada contrato registrado, obtiene nuevos TTLs del RPC, actualiza la base de datos, compara cada entrada con todos los umbrales de alerta configurados. Dispara `threshold_crossed` cuando el TTL cae por debajo de un umbral; dispara `alert_resolved` cuando el TTL se recupera.

2. **Entregar** — Procesa todas las alertas no entregadas de la cola de la base de datos. Enruta cada una a su canal configurado (Webhook, Slack, Discord, Telegram, PagerDuty), marca las entregas exitosas, incrementa los contadores de reintentos en fallos y abandona de forma controlada después de 5 reintentos.

3. **Auto-Extender** — Para los contratos con una política de guardia activa, comprueba qué entradas tienen el TTL por debajo del umbral de la política y simula una transacción `ExtendFootprintTTLOp` a través del RPC de Stellar. Si es exitosa, envía la transacción, registra el costo exacto en XLM y actualiza el uso del presupuesto mensual del contrato para prevenir gastos descontrolados.

Para el flujo de datos completo (orden exacto de llamadas, aislamiento de fallos entre fases, dónde suele aterrizar una nueva contribución), consulta [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Almacenamiento

Todo el estado es local. Sorokeep almacena datos en `~/.sorokeep/sorokeep.db` (SQLite con modo WAL). No se requieren servicios externos más allá de un endpoint RPC de Stellar.

**Tablas de la base de datos:**

| Tabla | Propósito |
|-------|---------|
| `contracts` | Contratos registrados con red, nombre, hash WASM |
| `contract_entries` | Entradas del libro mayor rastreadas con TTLs y fuente de descubrimiento |
| `extension_policies` | Reglas de auto-extensión por contrato (umbral, objetivo, referencia del par de claves) |
| `alert_configs` | Canales de alerta, umbrales y secretos de webhooks |
| `alerts_fired` | Registros de alertas disparadas con estado de entrega, recuento de reintentos y seguimiento de resolución |
| `extension_history` | Cada extensión de TTL con hash de transacción y costo en XLM |

### Configuración

Sorokeep almacena la configuración del usuario en `~/.sorokeep/config.yaml`:

```yaml
network: testnet
pollingIntervalSeconds: 300
slackToken: "xoxb-..."        # Opcional — también puedes usar la variable de entorno SOROKEEP_SLACK_TOKEN
rpcUrl: "https://..."         # Opcional — anula el valor por defecto de la red
```

El archivo de configuración se crea con permisos `0600` (lectura/escritura solo para el propietario) para proteger valores sensibles como el token de Slack.

## Estructura del Proyecto

```
sorokeep/
├── src/
│   ├── index.ts                 # Punto de entrada de la CLI (Commander.js)
│   ├── commands/                # Manejadores de comandos de la CLI (capa de presentación fina)
│   │   ├── watch.ts             # Registro de contrato
│   │   ├── status.ts            # Visualización de la salud del TTL
│   │   ├── daemon.ts            # Monitor de larga duración
│   │   ├── alerts.ts            # CRUD de alertas + prueba + historial
│   │   ├── guard.ts             # Políticas de auto-extensión
│   │   ├── costs.ts             # Reportes de costos de extensión
│   │   └── restore.ts           # Recuperación de entradas archivadas
│   ├── core/                    # Lógica de negocio (sin dependencias de CLI)
│   │   ├── watch.ts             # Registro y descubrimiento de contratos
│   │   ├── monitor.ts           # Ciclo de sondeo, detección de umbrales, resolución
│   │   ├── extension.ts         # Extensión de TTL, auto-extensión, restauración, registro de costos
│   │   └── discovery.ts         # Descubrimiento de claves de almacenamiento basado en footprints
│   ├── alerts/                  # Canal de entrega de alertas
│   │   ├── types.ts             # AlertEvent, AlertSeverity, buildAlertEvent
│   │   ├── dispatcher.ts        # Enrutamiento, lógica de reintentos, orquestación de la entrega
│   │   ├── webhook.ts           # HTTP POST con firma HMAC-SHA256
│   │   └── slack.ts             # API Web de Slack + formato Block Kit
│   ├── daemon/                  # Ciclo de vida del demonio
│   │   └── loop.ts              # Inicio/parada, protección de reingreso, orquestación del ciclo
│   ├── rpc/                     # Envoltura del cliente RPC de Stellar
│   │   └── client.ts            # Obtención de instancia/WASM, TTLs en lote, extender, restaurar
│   ├── db/                      # Capa de base de datos
│   │   ├── schema.sql           # Esquema completo de SQLite
│   │   ├── database.ts          # Inicialización, modo WAL, migraciones en vivo
│   │   └── repositories.ts      # Todas las funciones de consulta
│   ├── logging/                 # Registro estructurado (pino)
│   └── utils/                   # Cargador de configuración, formateo de TTL
├── tests/                       # Espejo de la estructura src/ — 891 pruebas en 66 archivos
├── .github/workflows/           # CI (pruebas + comprobación de tipos) y publicación
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile                   # Definición del contenedor Docker
├── systemd/                     # Plantillas de servicio Systemd para despliegues en Linux
├── LICENSE
└── CONTRIBUTING.md
```

**Capas de arquitectura:**

- **Comandos** (`src/commands/`) — Capa fina de la CLI. Analiza argumentos, llama al núcleo (core), formatea la salida en la terminal. Sin lógica de negocio.
- **Núcleo** (`src/core/`) — Lógica de negocio pura. Probable sin red o CLI. El demonio reutiliza las mismas funciones.
- **RPC** (`src/rpc/`) — Envoltura del SDK de Stellar. Todas las llamadas de red pasan por aquí. Maneja la creación, simulación, firma y envío de transacciones.
- **Alertas** (`src/alerts/`) — Canal de entrega. Formateo y transporte específico del canal, enrutamiento, gestión de reintentos.
- **DB** (`src/db/`) — Repositorios de SQLite. Todas las consultas centralizadas aquí. Modo en memoria para las pruebas.

## Pila Tecnológica

| Paquete | Propósito |
|---------|---------|
| [TypeScript](https://www.typescriptlang.org/) | Lenguaje de la aplicación (ESM) |
| [@stellar/stellar-sdk](https://github.com/nicktomlin/js-stellar-sdk) | Interacciones RPC de Stellar y Soroban |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Base de datos local (síncrona, cero dependencias externas) |
| [Commander.js](https://github.com/tj/commander.js) | Framework de la CLI |
| [pino](https://github.com/pinojs/pino) | Registro estructurado JSON |
| [chalk](https://github.com/chalk/chalk) / [ora](https://github.com/sindresorhus/ora) | Formato de terminal y spinners |
| [yaml](https://github.com/eemeli/yaml) | Análisis del archivo de configuración |
| [Vitest](https://vitest.dev/) | Framework de pruebas |

## Pruebas

```bash
# Ejecutar todas las pruebas
npm test

# Ejecutar un archivo de prueba específico
npx vitest run tests/core/monitor.test.ts

# Modo de observación
npx vitest
```

**891 pruebas** distribuidas en **66 archivos de prueba** cubriendo:

- **Formateo** — Conversión de TTL, clasificación de estado, tiempo legible por humanos
- **Base de datos** — CRUD, cascadas, inserciones/actualizaciones (upserts), deduplicación, colas de entrega de alertas
- **Cliente RPC** — Instancia de contrato, código WASM, consultas de TTL en lote, simulación de transacciones
- **Observación (Watch)** — Registro, re-observación, contratos SAC, manejo de errores, aislamiento de red, introspección
- **Ciclo de Monitoreo** — Actualización de TTL, detección de umbrales, deduplicación de alertas, resolución, aislamiento de fallos, escalada multi-umbral, respuestas RPC parciales
- **Extensión** — Extensión del TTL, evaluación de la política de auto-extensión, restauración, registro de costos, cumplimiento del presupuesto
- **Despachador de Alertas** — Enrutamiento del canal, lógica de reintentos, límite de reintentos máximos, alertas abandonadas (Slack, Discord, Telegram, Webhook, PagerDuty)
- **Webhook** — Firma HMAC-SHA256, manejo de tiempos de espera, respuestas de error HTTP
- **Slack** — Resolución de tokens, estructura Block Kit, validación de `body.ok`
- **Comandos CLI** — alertas, presupuesto, guardia, costos, observar, estado, demonio, comprobación, restaurar, db, canales
- **Configuración** — Cargar/guardar, valores por defecto, manejo de fallos en el análisis, permisos de archivo
- **Demonio** — Inicio/parada, protección de reingreso, aislamiento de errores de ciclo
- **Servidor MCP** — Cobertura de prueba para todas las herramientas expuestas por MCP

Todas las pruebas utilizan bases de datos SQLite en memoria y respuestas RPC simuladas — sin llamadas de red, sin efectos secundarios en el sistema de archivos. El TDD se practica en todo.

## Seguridad y Procedencia

Los paquetes de Sorokeep publicados en npm incluyen una [declaración de procedencia verificada](https://docs.npmjs.com/generating-provenance-statements). Esto proporciona un vínculo criptográfico y auditable entre el paquete npm publicado y la ejecución exacta de GitHub Actions y el commit que lo generó.

Para verificar la procedencia de tu paquete de Sorokeep instalado, puedes consultar la [página del paquete en el registro de npm](https://www.npmjs.com/package/sorokeep) en busca del distintivo de procedencia, o ejecutar el siguiente comando para verificar las firmas de auditoría de npm:

```bash
npm audit signatures
```

## Preguntas Frecuentes (FAQ)

### ¿Por qué TypeScript y no Rust?

Sorokeep es una herramienta operativa fuera de la cadena, no un contrato inteligente. TypeScript fue elegido porque:

1. El SDK de JS para Stellar es la biblioteca cliente más completa para las interacciones RPC de Soroban.
2. Los desarrolladores de Soroban ya tienen Node.js en su cadena de herramientas.
3. La distribución a través de npm significa una instalación sin fricciones.
4. Los requisitos de rendimiento (sondeo RPC periódico) están muy dentro de las capacidades de Node.js.
5. Maximiza el grupo de contribuyentes: la mayoría de los desarrolladores de Soroban conocen TypeScript.

### ¿Se almacena mi clave secreta en algún lugar?

No. Cuando configuras la auto-extensión con `--keypair-env`, Sorokeep almacena solo la **clave pública** y el **nombre de la variable de entorno** en la base de datos. La clave secreta real se resuelve desde tu entorno en tiempo de ejecución. Si usas `--keypair` para una operación única, la clave se usa en la memoria y nunca se persiste.

### ¿Qué sucede si el demonio falla en medio de un ciclo?

Cada fase (monitoreo, entrega, auto-extensión) está envuelta en un manejo de errores aislado. Un fallo en una fase no impide que se ejecuten las otras. Las entregas de alertas son idempotentes: si una entrega se marcó como exitosa, no se volverá a enviar. Si el demonio se reinicia, las alertas no entregadas se recogerán en el próximo ciclo.

### ¿Qué redes son compatibles?

Testnet (`https://soroban-testnet.stellar.org`) y Mainnet (`https://mainnet.sorobanrpc.com`). También puedes apuntar Sorokeep a cualquier endpoint RPC personalizado con `--rpc-url`.

### ¿Cómo registro un contrato para monitoreo?

Ejecuta `sorokeep watch <contract-id>` y proporciona las opciones de red y RPC necesarias para tu despliegue. Las configuraciones de alerta requieren que el contrato ya haya sido registrado; usa `sorokeep status <contract-id>` para inspeccionar su estado actual.

### ¿Cómo puedo verificar un canal de alerta antes de ponerlo en producción?

Crea la configuración de alerta y luego ejecuta `sorokeep alerts test --id <alert-config-id>`. El comando envía un evento sintético `threshold_crossed` a través de la ruta de entrega real; agrega `--dry-run` para imprimir el payload sin enviarlo.

### ¿Puede una alerta ir a más de un destino?

Sí. Para alertas de TTL, repite `--target <type:target>` al ejecutar `sorokeep alerts add`, por ejemplo `--target webhook:https://... --target slack:alerts`. Las alertas de recursos actualmente solo admiten su destino principal.

### ¿Por qué una alerta no llegó de inmediato?

Una alerta puede diferirse cuando su ventana de horario silencioso configurada está activa; permanece pendiente sin consumir un reintento. Los fallos de entrega son reintentados por el demonio, y una entrega se abandona una vez alcanzado el límite de reintentos del canal.

### ¿Qué canales de alerta están disponibles?

El registro integrado actualmente incluye Webhook, Webhook v2, Slack, PagerDuty, Google Chat, Discord, Telegram, Opsgenie, Microsoft Teams, Matrix y correo electrónico. Ejecuta `sorokeep alerts channels` para ver los canales registrados en la instalación actual, incluyendo los canales provistos por plugins.

### ¿Qué sucede cuando una entrada de contrato ya expiró?

Una entrada expirada se archiva y no puede extenderse hasta que se restaure. Ejecuta `sorokeep restore <contract-id> --entry <key-xdr> --keypair-env <var>` (o usa `--all`), y deja que el watch existente continúe; la restauración requiere una clave de firma y XLM para las tarifas de red.

### ¿Qué pasa con las alertas por correo electrónico?

Las alertas por correo electrónico son compatibles. Configura las credenciales SMTP (host/puerto/usuario/contraseña) en `~/.sorokeep/config.yaml` o mediante las variables de entorno correspondientes; los envíos por correo usan la misma cola de reintentos respaldada por base de datos que los demás canales. Consulta la [Referencia de Configuración](docs/config-reference.md) para conocer los nombres exactos de los campos.

### ¿Cómo uso un endpoint RPC personalizado?

Pasa `--rpc-url <url>` a `sorokeep watch` o `sorokeep daemon`, o define `rpcUrl` en `~/.sorokeep/config.yaml`. Un endpoint personalizado sustituye la URL RPC predeterminada de Testnet o Mainnet para ese comando.

### ¿Puedo ejecutar un ciclo de monitoreo sin el demonio?

Sí — `sorokeep check <contract-id> --fail-under <ledgers>` ejecuta un único ciclo de monitoreo puntual y sale con código 1 si alguna entrada rastreada está por debajo de ese TTL. Usa `--force` en CI cuando quieras reportar la salud del TTL sin hacer fallar el build.

### ¿Cómo restauro una entrada archivada?

Ejecuta `sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all` para restaurar todas las entradas rastreadas, o pasa `--entry <base64-xdr>` para restaurar una entrada específica. El comando requiere `--keypair` o `--keypair-env`.

### ¿Cómo veo cuánto he gastado en extensiones?

Ejecuta `sorokeep costs <contract-id>` para ver el total de extensiones, el costo total en XLM, un desglose por tipo de entrada y una proyección a 30 días. Usa `--period <days>` para cambiar la ventana de consulta o `--all` para el historial completo.

### ¿Qué hace `sorokeep guard --dry-run`?

Ejecuta `sorokeep guard <contract-id> --keypair S... --dry-run` para simular la transacción de extensión y ver la tarifa estimada sin enviar nada a la red. Esto es útil para verificar el costo antes de habilitar la extensión automática o realizar una extensión puntual.

## Hoja de Ruta

Sigue el progreso general en el [tablero de la Hoja de Ruta de Sorokeep](https://github.com/AbdulmalikAlayande/sorokeep/projects) — los problemas están agrupados por fase (`phase-1` a `phase-15`) con estados Todo/En progreso/Hecho.

> **Nota:** El tablero se configura a través de una propuesta en [`docs/roadmap-board-proposal.md`](docs/roadmap-board-proposal.md).
> Si eres un mantenedor, sigue ese documento para crear y vincular el tablero.

- Interfaz de plugins para canales de alertas — para que un canal nuevo (Matrix, MS Teams, correo electrónico) no requiera tocar el código central de despacho o el esquema de la base de datos
- Endpoint `/metrics` de Prometheus para equipos con pilas de observabilidad existentes
- GitHub Action reutilizable que envuelve `sorokeep check` para verificaciones de TTL integradas en CI
- Panel web para monitoreo visual del TTL
- Operaciones en lote para múltiples contratos

## Obtener Ayuda

**¿Problemas con el demonio?** Consulta [docs/troubleshooting.md](docs/troubleshooting.md) (en inglés) para una guía completa que cubre los modos de fallo más comunes (ciclos colgados, alertas que no se disparan, auto-extensión bloqueada, errores de RPC) con comandos de diagnóstico y pasos de resolución.

Si tienes dudas o problemas:
- Consulta las [issues abiertas](https://github.com/AbdulmalikAlayande/sorokeep/issues)
- Contacta por X: [@The_good_man02](https://twitter.com/The_good_man02)

Para problemas de seguridad (filtración de claves, transacciones no intencionadas), consulta [SECURITY.md](SECURITY.md) en lugar de abrir un issue público.

## Contribución

Las contribuciones son bienvenidas. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para ver las pautas, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) sobre cómo funciona el sistema en tiempo de ejecución, y [SECURITY.md](SECURITY.md) para informar sobre vulnerabilidades. Este proyecto sigue un [Código de Conducta](CODE_OF_CONDUCT.md).

## Licencia

[MIT](LICENSE)

## Autor

**Abdulmalik Alayande**

- GitHub: [@AbdulmalikAlayande](https://github.com/AbdulmalikAlayande)
- X: [@The_good_man02](https://twitter.com/The_good_man02)
