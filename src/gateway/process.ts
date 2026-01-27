import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { ClawdbotEnv } from '../types';
import { CLAWDBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';

/**
 * Find an existing Clawdbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingClawdbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "clawdbot devices list"
      const isGatewayProcess = 
        proc.command.includes('start-clawdbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand = 
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Clawdbot gateway is running
 * 
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureClawdbotGateway(sandbox: Sandbox, env: ClawdbotEnv): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Check if Clawdbot is already running or starting
  const existingProcess = await findExistingClawdbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Clawdbot process:', existingProcess.id, 'status:', existingProcess.status);

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for Clawdbot gateway on port', CLAWDBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(CLAWDBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Clawdbot gateway is reachable');
      return existingProcess;
    } catch (e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new Clawdbot gateway
  console.log('Starting new Clawdbot gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-clawdbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('Waiting for Clawdbot gateway to be ready on port', CLAWDBOT_PORT);
    await process.waitForPort(CLAWDBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('Clawdbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('Clawdbot stdout:', logs.stdout);
    if (logs.stderr) console.log('Clawdbot stderr:', logs.stderr);
  } catch (e) {
    console.error('waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('Clawdbot startup failed. Stderr:', logs.stderr);
      console.error('Clawdbot startup failed. Stdout:', logs.stdout);
      throw new Error(`Clawdbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      console.error('Failed to get logs:', logErr);
      throw e;
    }
  }

  return process;
}
