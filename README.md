# MISS Research Service

Servicio local de investigación para Catalog Builder. Expone una API HTTP que busca fuentes públicas con SearXNG y descarga evidencia reproducible. No decide la identidad de un producto, su clasificación fiscal ni sus atributos clínicos: entrega fuentes que deben evaluarse aguas arriba.

## Arquitectura

```text
Cliente MCP (opencode) → API MISS Research :3210 → SearXNG (red interna) → buscadores públicos
                                      └────→ SQLite + evidencia persistente
```

Sólo la API se publica en la LAN, en el puerto `3210`. SearXNG y SQLite permanecen en la red privada de Docker. Los datos de caché y evidencia viven en el volumen `research_data`.

## Requisitos

- Docker Engine con Docker Compose v2.
- Acceso de red saliente hacia los buscadores configurados.
- Un archivo `searxng/settings.yml` local, creado desde `searxng/settings.yml.template` con una clave `server.secret_key` aleatoria.

## Instalación y ejecución

```bash
git clone git@github.com:javierpal/miss-research.git
cd miss-research
cp searxng/settings.yml.template searxng/settings.yml
# Edita settings.yml y reemplaza REPLACE_ON_DEPLOY por una clave aleatoria.
docker compose up -d --build
curl -fsS http://127.0.0.1:3210/health
```

La respuesta de salud esperada es:

```json
{"status":"ok","service":"miss-research-api"}
```

Para actualizar el servicio después de cambiar código o configuración:

```bash
docker compose up -d --build
docker compose restart searxng # sólo si cambió searxng/settings.yml
```

## API

### `GET /health`

Comprueba que la API esté en ejecución.

### `POST /research/search`

Busca snippets de fuentes públicas.

```json
{
  "query": "amikacina 500 mg 2 ml",
  "batchId": "checkpoint-012",
  "queueItemId": "legacy-research-000821",
  "missingAttribute": "opcional; sólo para la tercera búsqueda permitida"
}
```

`query`, `batchId` y `queueItemId` son obligatorios. El servicio permite dos búsquedas externas por producto; una tercera requiere `missingAttribute`. El límite se aplica por la pareja `batchId` + `queueItemId`.

### `POST /research/fetch`

Descarga una URL pública como evidencia.

```json
{
  "url": "https://example.org/fuente",
  "batchId": "checkpoint-012",
  "queueItemId": "legacy-research-000821"
}
```

No se permiten destinos privados o locales. Cada fetch conserva URL final, hora de recuperación, hash del contenido, texto extraído y el archivo original en el volumen persistente.

## Caché, errores y límites

- Búsquedas con resultados se comparten por consulta normalizada y devuelven `meta.cacheHit: true` cuando proceden de caché.
- Las respuestas vacías no se guardan: una degradación temporal de motores no debe convertirse en un resultado vacío permanente.
- `429`: presupuesto de búsqueda agotado o concurrencia externa temporalmente llena.
- `503`: todos los motores configurados estuvieron no disponibles para una búsqueda.
- `502`: fallo de transporte o respuesta no válida de un upstream/fetch.
- Los snippets de búsqueda son pistas, no evidencia calificante. Hay que llamar a `fetch` y evaluar el contenido antes de registrar un dato de catálogo.

## Pacing, rutas y circuit breakers

Las búsquedas externas se serializan globalmente (`MAX_EXTERNAL_CONCURRENCY=1`): entre intentos reales se aplica un mínimo de `SEARCH_MIN_INTERVAL_MS=2500` y jitter aleatorio de hasta `SEARCH_JITTER_MS=1500`. Los cache hits y motores omitidos por circuito abierto no esperan ni consumen presupuesto.

Cada búsqueda usa Bing primero y Yahoo sólo como fallback; nunca se consultan en paralelo. El estado de cada motor se persiste en SQLite y puede consultarse sin generar tráfico en `GET /health/search`. Tras tres fallos relevantes (429, CAPTCHA, timeout o error upstream), el circuito abre. El cooldown crece de 30 min a un máximo de 12 h; la primera prueba posterior es HALF_OPEN y sólo un intento controlado puede cerrarlo de nuevo.

El presupuesto usa `CANONICAL_RESEARCH_BATCH` junto con `queueItemId`, no el `batchId` que envía el cliente. Debe configurarse en el servidor con el batch canónico aprobado (por ejemplo `research-batch-0003`) antes de habilitar investigación; el valor seguro `research-batch-unassigned` rechaza búsquedas. Al cambiar al siguiente batch autorizado, se cambia esta configuración y se reinicia el API: así cada batch legítimo tiene su propio presupuesto sin permitir namespaces arbitrarios del cliente. Cada intento real contra un motor consume presupuesto incluso si falla; los fallos de circuito abierto y cache hits no lo consumen.

## Motores de búsqueda

La plantilla prioriza Bing y Yahoo, que se validaron desde la VM. Brave, DuckDuckGo y Google CSE se dejan deshabilitados porque el host recibió CAPTCHA o rate limits de esos proveedores. Antes de habilitar un motor, pruébalo desde el contenedor SearXNG y vigila sus logs:

```bash
docker compose logs --tail=200 searxng
```

## Operación segura

- No expongas SearXNG ni el volumen de evidencia fuera de la red Docker.
- No añadas tokens ni claves al repositorio. `searxng/settings.yml` está ignorado; sólo se versiona su plantilla.
- Haz copia de seguridad del volumen `research_data` antes de tareas de mantenimiento de Docker.
- No borres la base SQLite para "arreglar" una búsqueda. Para incidencias de caché, elimina únicamente entradas de búsqueda vacías y conserva siempre la evidencia.

## Desarrollo

```bash
npm install
npm run build
```

El servicio se implementa en `src/main.ts`; el despliegue está definido en `docker-compose.yml`.
