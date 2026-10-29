import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type Ctx } from '../../server/src/app';
import { loadConfig } from '../../server/src/config';
import type { AiProvider } from '../../server/src/ai/provider';
import type { Mailer } from '../../server/src/services/support';

export interface TestServer {
  app: FastifyInstance;
  ctx: Ctx;
  dataDir: string;
  mail: { to: string; subject: string; text: string }[];
  close(): Promise<void>;
}

export async function startServer(opts: { aiProvider?: AiProvider; dataDir?: string; env?: Record<string, string> } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qg-api-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', APP_URL: 'http://localhost:5173', ...opts.env });
  const mail: TestServer['mail'] = [];
  const mailer: Mailer = { configured: true, send: async (to, subject, text) => void mail.push({ to, subject, text }) };
  const { app, ctx } = await buildApp({ config, aiProvider: opts.aiProvider, mailer, logger: false });
  await app.ready();
  return { app, ctx, dataDir, mail, close: () => app.close() };
}

/** A tiny cookie-keeping client around fastify.inject. */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async req(method: string, url: string, body?: unknown, extra: { headers?: Record<string, string>; payload?: Buffer | string } = {}) {
    const headers: Record<string, string> = { 'x-quickgrade-csrf': '1', ...extra.headers };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers,
      payload: extra.payload ?? (body === undefined ? undefined : (body as object)),
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const first = (Array.isArray(set) ? set : [set]).find((c) => c.startsWith('qg_session='));
      if (first) {
        const v = first.split(';')[0];
        this.cookie = v === 'qg_session=' ? '' : v;
      }
    }
    let json: any = null;
    if ((res.headers['content-type'] ?? '').toString().includes('application/json')) json = res.json();
    return { status: res.statusCode, json, body: res.rawPayload, headers: res.headers };
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  put = (url: string, body?: unknown) => this.req('PUT', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);

  async upload(url: string, filename: string, data: Buffer, contentType = 'image/jpeg') {
    const boundary = '----qgtest' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.req('POST', url, undefined, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  }
}

let counter = 0;
export async function registerTeacher(app: FastifyInstance, name = 'Teacher') {
  const c = new Client(app);
  const email = `t${Date.now()}${counter++}@school.test`;
  const r = await c.post('/api/auth/register', { email, password: 'correct horse 42', fullName: name });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
  return { client: c, email, user: r.json.user };
}
