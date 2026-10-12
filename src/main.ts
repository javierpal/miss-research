import 'reflect-metadata';
import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsArray, IsOptional, IsString, IsUrl, MaxLength, ValidateIf } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import Database = require('better-sqlite3');
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { isIP } from 'net';
import { join } from 'path';

class SearchRequest {
  @IsString() @MaxLength(500) query!: string;
  @IsString() @MaxLength(120) batchId!: string;
  @IsString() @MaxLength(120) queueItemId!: string;
  @IsOptional() @IsString() @MaxLength(300) missingAttribute?: string;
}
class FetchRequest {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(2048) url!: string;
  @IsString() @MaxLength(120) batchId!: string;
  @IsString() @MaxLength(120) queueItemId!: string;
}

function validate<T>(type: new () => T, raw: unknown): T {
  const value = plainToInstance(type, raw);
  const errors = require('class-validator').validateSync(value, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) throw new HttpException('invalid request', HttpStatus.BAD_REQUEST);
  return value;
}
function normalizeQuery(query: string) { return query.trim().replace(/\s+/g, ' '); }
function keyOf(...parts: string[]) { return createHash('sha256').update(parts.join('\u001f')).digest('hex'); }

@Injectable()
class ResearchService {
  private readonly db: Database.Database;
  private readonly dataDir = process.env.DATA_DIR || '/var/lib/miss-research';
  private readonly searx = process.env.SEARXNG_URL || 'http://searxng:8080';
  private readonly maxBytes = Number(process.env.FETCH_MAX_BYTES || 1500000);
  private readonly timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 12000);
  private readonly active = new Map<string, Promise<unknown>>();
  private activeExternal = 0;
  private readonly maxExternal = Number(process.env.MAX_EXTERNAL_CONCURRENCY || 2);
  private pausedUntil = 0;

  constructor() {
    require('fs').mkdirSync(this.dataDir, { recursive: true });
    this.db = new Database(join(this.dataDir, 'research.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (cache_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (batch_id TEXT NOT NULL, queue_item_id TEXT NOT NULL, external_searches INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch_id, queue_item_id));
      CREATE TABLE IF NOT EXISTS external_attempts (id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, queue_item_id TEXT NOT NULL, kind TEXT NOT NULL, query TEXT, url TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, queue_item_id TEXT NOT NULL, url TEXT NOT NULL, retrieved_at TEXT NOT NULL, content_type TEXT, content_hash TEXT NOT NULL, content_path TEXT NOT NULL, text TEXT NOT NULL);
    `);
  }
  private now() { return new Date().toISOString(); }
  private cached(key: string) { const row = this.db.prepare('SELECT payload FROM cache WHERE cache_key=?').get(key) as { payload: string } | undefined; return row && JSON.parse(row.payload); }
  private cache(key: string, kind: string, payload: unknown) { this.db.prepare('INSERT OR REPLACE INTO cache VALUES (?, ?, ?, ?)').run(key, kind, JSON.stringify(payload), this.now()); }
  private budget(batchId: string, queueItemId: string) {
    this.db.prepare('INSERT OR IGNORE INTO budgets(batch_id,queue_item_id) VALUES (?,?)').run(batchId, queueItemId);
    return this.db.prepare('SELECT external_searches as searches, locked FROM budgets WHERE batch_id=? AND queue_item_id=?').get(batchId, queueItemId) as { searches: number; locked: number };
  }
  private attempt(batchId: string, queueItemId: string, kind: string, status: string, query?: string, url?: string, error?: string) {
    this.db.prepare('INSERT INTO external_attempts(batch_id,queue_item_id,kind,query,url,status,error,created_at) VALUES(?,?,?,?,?,?,?,?)').run(batchId, queueItemId, kind, query || null, url || null, status, error || null, this.now());
  }
  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (Date.now() < this.pausedUntil) throw new HttpException('external requests paused after upstream rate limit', 503);
    if (this.activeExternal >= this.maxExternal) throw new HttpException('external concurrency limit reached; retry later', 429);
    this.activeExternal++; try { return await work(); } finally { this.activeExternal--; }
  }
  async search(raw: unknown) {
    const input = validate(SearchRequest, raw); const query = normalizeQuery(input.query);
    const cacheKey = keyOf('search', query); const hit = this.cached(cacheKey);
    if (hit) return { ...hit, meta: { ...hit.meta, cacheHit: true, externalSearches: this.budget(input.batchId, input.queueItemId).searches } };
    const inflight = this.active.get(cacheKey); if (inflight) return inflight;
    const run = this.searchExternal(input, query, cacheKey).finally(() => this.active.delete(cacheKey)); this.active.set(cacheKey, run); return run;
  }
  private async searchExternal(input: SearchRequest, query: string, cacheKey: string) {
    const budget = this.budget(input.batchId, input.queueItemId);
    const allowed = budget.searches < 2 || (budget.searches === 2 && Boolean(input.missingAttribute));
    if (budget.locked || !allowed) { this.db.prepare('UPDATE budgets SET locked=1 WHERE batch_id=? AND queue_item_id=?').run(input.batchId, input.queueItemId); throw new HttpException('search budget exhausted for this product', 429); }
    try {
      const result = await this.slot(async () => {
        const url = `${this.searx}/search?q=${encodeURIComponent(query)}&format=json`;
        const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.status === 429) { this.pausedUntil = Date.now() + 60_000; throw new Error('upstream HTTP 429'); }
        if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
        const json = await response.json() as { results?: Array<Record<string, unknown>>; unresponsive_engines?: unknown[] };
        const results = (json.results || []).map(r => ({ title: r.title, url: r.url, content: r.content, engine: r.engine }));
        if (results.length === 0 && (json.unresponsive_engines || []).length > 0) {
          throw new HttpException('search upstream failure: all configured search engines were unresponsive', HttpStatus.SERVICE_UNAVAILABLE);
        }
        return { query, results, meta: { cacheHit: false, externalSearches: budget.searches + 1, evidenceType: 'search-snippet' } };
      });
      this.db.prepare('UPDATE budgets SET external_searches=external_searches+1, locked=CASE WHEN external_searches+1>=3 THEN 1 ELSE 0 END WHERE batch_id=? AND queue_item_id=?').run(input.batchId, input.queueItemId);
      this.attempt(input.batchId, input.queueItemId, 'search', 'ok', query);
      // Do not permanently poison the shared query cache during an upstream outage or for a true no-result query.
      if (result.results.length > 0) this.cache(cacheKey, 'search', result);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      this.attempt(input.batchId, input.queueItemId, 'search', 'error', query, undefined, message);
      if (e instanceof HttpException) throw e;
      throw new HttpException(message, 502);
    }
  }
  private async isPublic(url: URL) {
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || isIP(host) && (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1')) return false;
    const addresses = await require('dns').promises.lookup(host, { all: true });
    return addresses.every((a: { address: string }) => !(/^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) || a.address === '::1'));
  }
  async fetch(raw: unknown) {
    const input = validate(FetchRequest, raw); const cacheKey = keyOf('fetch', input.url); const hit = this.cached(cacheKey);
    if (hit) return { ...hit, meta: { ...hit.meta, cacheHit: true } };
    const target = new URL(input.url); if (!(await this.isPublic(target))) throw new HttpException('private or local fetch target denied', 400);
    try { return await this.slot(async () => {
      const response = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'user-agent': 'MISS-Research/0.1 (+local evidence fetcher)' } });
      if (!response.ok) throw new Error(`fetch HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length') || 0); if (length > this.maxBytes) throw new Error('response exceeds size limit');
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > this.maxBytes) throw new Error('response exceeds size limit');
      const contentType = response.headers.get('content-type') || 'application/octet-stream'; const html = bytes.toString('utf8'); const text = contentType.includes('html') ? cheerio.load(html)('body').text().replace(/\s+/g, ' ').trim() : html.trim();
      const hash = createHash('sha256').update(bytes).digest('hex'); const path = join(this.dataDir, 'evidence', `${hash}.bin`); await fs.mkdir(join(this.dataDir, 'evidence'), { recursive: true }); await fs.writeFile(path, bytes, { flag: 'w' });
      const result = { url: response.url, retrievedAt: this.now(), contentType, contentHash: hash, text, meta: { cacheHit: false, evidenceType: 'fetched-page' } };
      this.db.prepare('INSERT INTO evidence(batch_id,queue_item_id,url,retrieved_at,content_type,content_hash,content_path,text) VALUES(?,?,?,?,?,?,?,?)').run(input.batchId, input.queueItemId, response.url, result.retrievedAt, contentType, hash, path, text);
      this.attempt(input.batchId, input.queueItemId, 'fetch', 'ok', undefined, response.url); this.cache(cacheKey, 'fetch', result); return result;
    }); } catch (e) { const message = e instanceof Error ? e.message : 'unknown'; this.attempt(input.batchId, input.queueItemId, 'fetch', 'error', undefined, input.url, message); throw new HttpException(message, 502); }
  }
}

@Controller()
class ResearchController {
  constructor(private readonly service: ResearchService) {}
  @Get('/health') health() { return { status: 'ok', service: 'miss-research-api' }; }
  @Post('/research/search') search(@Body() body: unknown) { return this.service.search(body); }
  @Post('/research/fetch') fetch(@Body() body: unknown) { return this.service.fetch(body); }
}
@Module({ controllers: [ResearchController], providers: [ResearchService] }) class AppModule {}
async function bootstrap() { const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] }); await app.listen(Number(process.env.PORT || 3000), '0.0.0.0'); }
bootstrap();
