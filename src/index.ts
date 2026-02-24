#!/usr/bin/env node

/**
 * 🐾 Clawd Cursor — AI Desktop Agent
 *
 * Your AI controls your desktop natively.
 */

import { Command } from 'commander';
import { Agent } from './agent';
import { createServer } from './server';
import { DEFAULT_CONFIG } from './types';
import { PROVIDERS } from './providers';
import type { ClawdConfig } from './types';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('clawd-cursor')
  .description('🐾 AI Desktop Agent — native screen control')
  .version('0.5.1');

program
  .command('start')
  .description('Start the Clawd Cursor agent')
  .option('--port <port>', 'API server port', '3847')
  .option('--provider <provider>', 'AI provider (anthropic|openai|ollama|kimi)', 'anthropic')
  .option('--model <model>', 'Vision model to use')
  .option('--api-key <key>', 'AI provider API key')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .action(async (opts) => {
    const config: ClawdConfig = {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        port: parseInt(opts.port),
      },
      ai: {
        provider: opts.provider as any,
        apiKey: opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
        model: opts.model || PROVIDERS[opts.provider]?.textModel || DEFAULT_CONFIG.ai.model,
        visionModel: opts.model || PROVIDERS[opts.provider]?.visionModel || DEFAULT_CONFIG.ai.visionModel,
      },
      debug: opts.debug || false,
    };

    console.log(`
🐾 ╔═══════════════════════════════════════╗
   ║       CLAWD CURSOR v0.5.1             ║
   ║   AI Desktop Agent — Smart Pipeline   ║
   ╚═══════════════════════════════════════╝
`);

    const agent = new Agent(config);

    try {
      await agent.connect();
    } catch (err) {
      console.error(`\n❌ Failed to initialize native desktop control: ${err}`);
      console.error(`\nThis usually means @nut-tree-fork/nut-js couldn't access the screen.`);
      console.error(`Make sure you're running this on a desktop with a display.`);
      process.exit(1);
    }

    // Start API server
    const app = createServer(agent, config);
    app.listen(config.server.port, config.server.host, () => {
      console.log(`\n🌐 API server: http://${config.server.host}:${config.server.port}`);
      console.log(`\nEndpoints:`);
      console.log(`  POST /task     — {"task": "Open Chrome and go to github.com"}`);
      console.log(`  GET  /status   — Agent state`);
      console.log(`  POST /confirm  — {"approved": true|false}`);
      console.log(`  POST /abort    — Stop current task`);
      console.log(`\nReady. Send a task to get started! 🐾`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down...');
      agent.disconnect();
      process.exit(0);
    });
  });

program
  .command('doctor')
  .description('🩺 Diagnose setup and auto-configure the pipeline')
  .option('--provider <provider>', 'AI provider (anthropic|openai|ollama|kimi)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--no-save', 'Don\'t save config to disk')
  .action(async (opts) => {
    const { runDoctor } = await import('./doctor');
    await runDoctor({
      apiKey: opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
      provider: opts.provider,
      save: opts.save !== false,
    });
  });

program
  .command('stop')
  .description('Stop a running Clawd Cursor instance')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    const url = `http://127.0.0.1:${opts.port}/stop`;
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json() as any;
      if (data.stopped) {
        console.log('🐾 Clawd Cursor stopped');
      } else {
        console.error('Unexpected response:', JSON.stringify(data));
      }
    } catch {
      console.error('No running instance found');
    }
  });

program
  .command('task <text>')
  .description('Send a task to a running Clawd Cursor instance')
  .option('--port <port>', 'API server port', '3847')
  .action(async (text, opts) => {
    const url = `http://127.0.0.1:${opts.port}/task`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: text }),
      });
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.error(`Failed to connect to Clawd Cursor at ${url}`);
      console.error('Is the agent running? Start it with: clawd-cursor start');
    }
  });

program.parse();
