/**
 * Clawdbot + Cloudflare Sandbox
 *
 * This Worker runs Clawdbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Clawdbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - CLAWDBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, ClawdbotEnv } from './types';
import { CLAWDBOT_PORT, R2_MOUNT_PATH } from './config';
import { createAccessMiddleware } from './auth';
import { ensureClawdbotGateway, mountR2Storage } from './gateway';
import { api, admin, debug } from './routes';

export { Sandbox };

/**
 * Build sandbox options based on environment configuration.
 * 
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 * 
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: ClawdbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  
  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  
  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'clawdbot', options);
  c.set('sandbox', sandbox);
  await next();
});

// Health check endpoint (before starting clawdbot)
app.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'clawdbot-sandbox',
    gateway_port: CLAWDBOT_PORT,
  });
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', admin);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.use('/debug/*', createAccessMiddleware({ type: 'json' }));
app.route('/debug', debug);

// All other routes: start clawdbot and proxy
app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  // Ensure clawdbot is running (this will wait for startup)
  try {
    await ensureClawdbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('Failed to start Clawdbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json({
      error: 'Clawdbot gateway failed to start',
      details: errorMessage,
      hint,
    }, 503);
  }

  // Proxy to Clawdbot
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    console.log('Proxying WebSocket connection to Clawdbot');
    console.log('WebSocket URL:', request.url);
    console.log('WebSocket search params:', url.search);
    return sandbox.wsConnect(request, CLAWDBOT_PORT);
  }

  console.log('Proxying HTTP request:', url.pathname + url.search);
  return sandbox.containerFetch(request, CLAWDBOT_PORT);
});

/**
 * Scheduled handler for cron triggers.
 * Syncs clawdbot config/state from container to R2 for persistence.
 */
async function scheduled(
  _event: ScheduledEvent,
  env: ClawdbotEnv,
  _ctx: ExecutionContext
): Promise<void> {
  // Skip if R2 is not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log('[cron] R2 not configured, skipping backup');
    return;
  }

  const options = buildSandboxOptions(env);
  const sandbox = getSandbox(env.Sandbox, 'clawdbot', options);

  // Ensure R2 is mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    console.log('[cron] Failed to mount R2, skipping backup');
    return;
  }

  // Run rsync to backup config to R2
  // Exclude lock files, logs, and temp files
  // Write timestamp to .last-sync for tracking
  const syncCmd = `rsync -a --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${R2_MOUNT_PATH}/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;
  
  try {
    console.log('[cron] Starting backup sync to R2...');
    const proc = await sandbox.startProcess(syncCmd);
    
    // Wait for sync to complete (max 30 seconds)
    let attempts = 0;
    while (proc.status === 'running' && attempts < 60) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
    
    const logs = await proc.getLogs();
    if (proc.status === 'completed' || proc.exitCode === 0) {
      console.log('[cron] Backup sync completed successfully');
    } else {
      console.error('[cron] Backup sync failed:', logs.stderr || logs.stdout);
    }
  } catch (error) {
    console.error('[cron] Error during backup sync:', error);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
