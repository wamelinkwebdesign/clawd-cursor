/**
 * HTTP Server — REST API for controlling the agent.
 * 
 * Endpoints:
 *   POST /task          — submit a new task
 *   GET  /status        — get agent state
 *   POST /confirm       — approve/reject a pending action
 *   POST /abort         — abort current task
 *   GET  /screenshot    — get current screen
 */

import express from 'express';
import type { ClawdConfig } from './types';
import { Agent } from './agent';

export function createServer(agent: Agent, config: ClawdConfig): express.Express {
  const app = express();
  app.use(express.json());

  // Submit a task
  app.post('/task', async (req, res) => {
    const { task } = req.body;
    if (!task) {
      return res.status(400).json({ error: 'Missing "task" in body' });
    }

    const state = agent.getState();
    if (state.status !== 'idle') {
      return res.status(409).json({
        error: 'Agent is busy',
        state,
      });
    }

    console.log(`\n📨 New task received: ${task}`);

    // Execute async — respond immediately
    agent.executeTask(task).then(result => {
      console.log(`\n📋 Task result:`, JSON.stringify(result, null, 2));
    });

    res.json({ accepted: true, task });
  });

  // Get current status
  app.get('/status', (req, res) => {
    res.json(agent.getState());
  });

  // Approve or reject a pending confirmation
  app.post('/confirm', (req, res) => {
    const { approved } = req.body;
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'Missing "approved" boolean in body' });
    }

    const safety = agent.getSafety();
    if (!safety.hasPendingConfirmation()) {
      return res.status(404).json({ error: 'No pending confirmation' });
    }

    const pending = safety.getPendingAction();
    safety.respondToConfirmation(approved);

    res.json({
      confirmed: approved,
      action: pending?.description,
    });
  });

  // Abort current task
  app.post('/abort', (req, res) => {
    agent.abort();
    res.json({ aborted: true });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  return app;
}

