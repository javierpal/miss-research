# MISS Research Service

Local, evidence-preserving web research service for Catalog Builder.  Only the API is published to the LAN on port 3210; SearXNG and SQLite remain on the private Compose network/volume.

Endpoints: `GET /health`, `POST /research/search`, and `POST /research/fetch`.

`search` requires `query`, `batchId`, and `queueItemId`; a third search requires `missingAttribute`. `fetch` requires `url`, `batchId`, and `queueItemId`.

Search results are snippets, not verified facts. Fetches retain original/final URL, timestamp, raw-content hash, text, and raw evidence in the persistent volume.
