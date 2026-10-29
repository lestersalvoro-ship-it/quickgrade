import { loadConfig } from './config';
import { buildApp } from './app';

const config = loadConfig();
const { app, ctx } = await buildApp({ config });

if (!ctx.ai.status().enabled) app.log.warn('AI features are disabled: set ANTHROPIC_API_KEY to enable them. Scanning and grading work without AI.');
if (!ctx.mailer.configured) app.log.warn('SMTP is not configured: password-reset links will be written to this log instead of emailed.');

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
