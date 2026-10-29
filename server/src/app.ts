import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config';
import { migrate, openDatabase, type DB } from './db/index';
import { AppError } from './http';
import { createMailer, ScanStorage, applyRetention, type Mailer } from './services/support';
import { authHook, authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { classRoutes } from './routes/classes';
import { studentRoutes } from './routes/students';
import { quizRoutes } from './routes/quizzes';
import { sessionRoutes } from './routes/sessions';
import { scanRoutes } from './routes/scans';
import { submissionRoutes } from './routes/submissions';
import { dashboardRoutes } from './routes/dashboard';
import { aiRoutes } from './routes/ai';
import { createAiService, type AiService } from './ai/service';
import type { AiProvider } from './ai/provider';

export interface Ctx {
  db: DB;
  config: Config;
  mailer: Mailer;
  storage: ScanStorage;
  ai: AiService;
}

export interface BuildOptions {
  config: Config;
  db?: DB;
  /** Inject an AI provider (tests). Defaults to the configured provider. */
  aiProvider?: AiProvider;
  mailer?: Mailer;
  logger?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = opts.db ?? openDatabase(config.databaseFile);
  migrate(db, (m) => app.log.info(m));
  const storage = new ScanStorage(config.uploadsDir);
  const mailer = opts.mailer ?? createMailer(config, (m) => app.log.warn(m));
  const ai = createAiService(db, config, opts.aiProvider);
  const ctx: Ctx = { db, config, mailer, storage, ai };

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.decorateRequest('user', null);

  // CSRF defence: state-changing API calls must carry a custom header, which browsers
  // only allow same-origin pages to send (there is no CORS configuration). Combined
  // with SameSite=Lax session cookies this blocks cross-site request forgery.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['x-quickgrade-csrf'] !== '1') throw new AppError(403, 'CSRF', 'Missing request header.');
  });
  app.addHook('onRequest', authHook(ctx));

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' } });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: `Files must be smaller than ${config.MAX_UPLOAD_MB} MB.` } });
    }
    // node:sqlite reports constraint violations as ERR_SQLITE_ERROR with SQLite's primary code 19.
    const sqliteErr = err as { code?: string; errcode?: number };
    if (sqliteErr.code === 'ERR_SQLITE_ERROR' && ((sqliteErr.errcode ?? 0) & 0xff) === 19) {
      req.log.warn({ err }, 'constraint violation');
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'This change conflicts with existing data.' } });
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
  });

  app.get('/api/health', async () => ({ ok: true, ai: ai.status() }));

  await app.register(async (api) => {
    await authRoutes(api, ctx);
    await settingsRoutes(api, ctx);
    await classRoutes(api, ctx);
    await studentRoutes(api, ctx);
    await quizRoutes(api, ctx);
    await sessionRoutes(api, ctx);
    await scanRoutes(api, ctx);
    await submissionRoutes(api, ctx);
    await dashboardRoutes(api, ctx);
    await aiRoutes(api, ctx);
  }, { prefix: '/api' });

  // Serve the built web app (production). In development Vite serves it and proxies /api.
  const webDist = [path.resolve(here, '../web'), path.resolve(process.cwd(), 'dist/web')].find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, maxAge: '1h' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  }

  // Periodic retention clean-up (scan images, expired sessions).
  const runRetention = () => {
    try {
      const n = applyRetention(db, storage);
      if (n) app.log.info(`retention: removed images for ${n} scans`);
    } catch (e) {
      app.log.error(e, 'retention failed');
    }
  };
  runRetention();
  const timer = setInterval(runRetention, 6 * 60 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    if (!opts.db) db.close();
  });

  return { app, ctx };
}
