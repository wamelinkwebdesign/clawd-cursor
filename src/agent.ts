/**
 * Agent — the main orchestration loop.
 * 
 * Takes a task, repeatedly:
 * 1. Captures screen
 * 2. Sends to AI brain
 * 3. Checks safety
 * 4. Executes action via VNC
 * 5. Repeats until done or error
 */

import { VNCClient } from './vnc-client';
import { AIBrain } from './ai-brain';
import { SafetyLayer } from './safety';
import { SafetyTier } from './types';
import type { ClawdConfig, AgentState, TaskResult, StepResult, InputAction } from './types';

const MAX_STEPS = 50;  // Safety limit per task

export class Agent {
  private vnc: VNCClient;
  private brain: AIBrain;
  private safety: SafetyLayer;
  private config: ClawdConfig;
  private state: AgentState = {
    status: 'idle',
    stepsCompleted: 0,
    stepsTotal: 0,
  };
  private aborted = false;

  constructor(config: ClawdConfig) {
    this.config = config;
    this.vnc = new VNCClient(config);
    this.brain = new AIBrain(config);
    this.safety = new SafetyLayer(config);
  }

  async connect(): Promise<void> {
    await this.vnc.connect();
  }

  async executeTask(task: string): Promise<TaskResult> {
    this.aborted = false;
    this.state = {
      status: 'thinking',
      currentTask: task,
      stepsCompleted: 0,
      stepsTotal: MAX_STEPS,
    };

    const steps: StepResult[] = [];
    const stepDescriptions: string[] = [];
    const startTime = Date.now();

    console.log(`\n🐾 Starting task: ${task}`);

    for (let i = 0; i < MAX_STEPS; i++) {
      if (this.aborted) {
        console.log('⛔ Task aborted by user');
        break;
      }

      // 1. Capture screen
      this.state.status = 'thinking';
      this.state.currentStep = 'Analyzing screen...';
      console.log(`\n📸 Step ${i + 1}: Capturing screen...`);
      
      const screenshot = await this.vnc.captureScreen();

      // 2. Ask AI what to do
      const decision = await this.brain.decideNextAction(screenshot, task, stepDescriptions);

      // 3. Check if done
      if (decision.done) {
        console.log(`✅ Task complete: ${decision.description}`);
        steps.push({
          action: 'done',
          description: decision.description,
          success: true,
          timestamp: Date.now(),
        });
        break;
      }

      // 4. Handle errors
      if (decision.error) {
        console.log(`❌ Error: ${decision.error}`);
        steps.push({
          action: 'error',
          description: decision.error,
          success: false,
          timestamp: Date.now(),
        });
        break;
      }

      // 5. Handle wait
      if (decision.waitMs) {
        console.log(`⏳ Waiting ${decision.waitMs}ms: ${decision.description}`);
        await this.delay(decision.waitMs);
        stepDescriptions.push(decision.description);
        continue;
      }

      if (!decision.action) continue;

      // 6. Safety check
      const tier = this.safety.classify(decision.action, decision.description);
      console.log(`${tierEmoji(tier)} Action: ${decision.description}`);

      if (this.safety.isBlocked(decision.description)) {
        console.log(`🚫 BLOCKED: ${decision.description}`);
        steps.push({
          action: 'blocked',
          description: `BLOCKED: ${decision.description}`,
          success: false,
          timestamp: Date.now(),
        });
        break;
      }

      if (tier === SafetyTier.Confirm) {
        this.state.status = 'waiting_confirm';
        this.state.currentStep = `Confirm: ${decision.description}`;
        
        const approved = await this.safety.requestConfirmation(decision.action, decision.description);
        if (!approved) {
          console.log(`❌ User rejected action`);
          steps.push({
            action: 'rejected',
            description: `USER REJECTED: ${decision.description}`,
            success: false,
            timestamp: Date.now(),
          });
          continue; // Skip this action, let AI try something else
        }
      }

      // 7. Execute action
      this.state.status = 'acting';
      this.state.currentStep = decision.description;

      try {
        if ('x' in decision.action) {
          await this.vnc.executeMouseAction(decision.action);
        } else {
          await this.vnc.executeKeyboardAction(decision.action);
        }

        steps.push({
          action: decision.action.kind,
          description: decision.description,
          success: true,
          timestamp: Date.now(),
        });

        stepDescriptions.push(decision.description);
        this.state.stepsCompleted = i + 1;

        // Brief pause to let UI update
        await this.delay(500);

      } catch (err) {
        console.error(`Failed to execute action:`, err);
        steps.push({
          action: decision.action.kind,
          description: `FAILED: ${decision.description} — ${err}`,
          success: false,
          error: String(err),
          timestamp: Date.now(),
        });
      }
    }

    this.state.status = 'idle';
    this.state.currentTask = undefined;
    this.brain.resetConversation();

    return {
      success: steps[steps.length - 1]?.success ?? false,
      steps,
      duration: Date.now() - startTime,
    };
  }

  abort(): void {
    this.aborted = true;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getSafety(): SafetyLayer {
    return this.safety;
  }

  disconnect(): void {
    this.vnc.disconnect();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function tierEmoji(tier: SafetyTier): string {
  switch (tier) {
    case SafetyTier.Auto: return '🟢';
    case SafetyTier.Preview: return '🟡';
    case SafetyTier.Confirm: return '🔴';
  }
}

