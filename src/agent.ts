/**
 * Agent — the main orchestration loop.
 *
 * v2 Flow (optimized):
 * 1. Decompose task into subtasks (1 text-only LLM call)
 * 2. For each subtask:
 *    a. Try Action Router (accessibility + VNC, NO LLM) ← handles 80%+ of tasks
 *    b. If router can't handle it → LLM vision fallback (with resized screenshot)
 * 3. Track what approach worked for each subtask
 *
 * Target: "Open Paint and type hello world" in <15s with 0-1 LLM calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VNCClient } from './vnc-client';
import { AIBrain } from './ai-brain';
import { SafetyLayer } from './safety';
import { AccessibilityBridge } from './accessibility';
import { ActionRouter } from './action-router';
import { SafetyTier } from './types';
import type { ClawdConfig, AgentState, TaskResult, StepResult, InputAction, ActionSequence, A11yAction } from './types';

const MAX_STEPS = 15;
const MAX_SIMILAR_ACTION = 3;
const MAX_LLM_FALLBACK_STEPS = 10;

export class Agent {
  private vnc: VNCClient;
  private brain: AIBrain;
  private safety: SafetyLayer;
  private a11y: AccessibilityBridge;
  private router: ActionRouter;
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
    this.a11y = new AccessibilityBridge();
    this.router = new ActionRouter(this.a11y, this.vnc);
  }

  async connect(): Promise<void> {
    await this.vnc.connect();
    const size = this.vnc.getScreenSize();
    this.brain.setScreenSize(size.width, size.height);
  }

  async executeTask(task: string): Promise<TaskResult> {
    this.aborted = false;
    const steps: StepResult[] = [];
    const startTime = Date.now();

    console.log(`\n🐾 Starting task: ${task}`);
    console.log(`   Using optimized v2 pipeline: decompose → route → (fallback to LLM)`);

    // Setup debug directory
    const debugDir = path.join(process.cwd(), 'debug');
    if (fs.existsSync(debugDir)) {
      for (const f of fs.readdirSync(debugDir)) fs.unlinkSync(path.join(debugDir, f));
    } else {
      fs.mkdirSync(debugDir);
    }

    this.state = {
      status: 'thinking',
      currentTask: task,
      stepsCompleted: 0,
      stepsTotal: MAX_STEPS,
    };

    // ═══════════════════════════════════════════════════════════════
    // PHASE 1: Decompose task into subtasks (1 LLM text call — fast)
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n📋 Phase 1: Decomposing task...`);
    const decompositionStart = Date.now();
    const subtasks = await this.brain.decomposeTask(task);
    console.log(`   Decomposed in ${Date.now() - decompositionStart}ms into ${subtasks.length} subtask(s):`);
    subtasks.forEach((st, i) => console.log(`   ${i + 1}. "${st}"`));

    this.state.stepsTotal = subtasks.length;
    let llmCallCount = 1; // Count the decomposition call

    // ═══════════════════════════════════════════════════════════════
    // PHASE 2: Execute each subtask via Router → LLM Fallback
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n⚡ Phase 2: Executing subtasks...`);

    for (let i = 0; i < subtasks.length; i++) {
      if (this.aborted) {
        console.log('⛔ Task aborted by user');
        steps.push({ action: 'aborted', description: 'User aborted', success: false, timestamp: Date.now() });
        break;
      }

      const subtask = subtasks[i];
      console.log(`\n── Subtask ${i + 1}/${subtasks.length}: "${subtask}" ──`);
      this.state.currentStep = subtask;
      this.state.stepsCompleted = i;

      // ─── Try Action Router first (NO LLM) ─────────────────────
      this.state.status = 'acting';
      const routeStart = Date.now();
      const routeResult = await this.router.route(subtask);

      if (routeResult.handled) {
        const routeMs = Date.now() - routeStart;
        console.log(`   ✅ Router handled in ${routeMs}ms: ${routeResult.description}`);
        steps.push({
          action: 'routed',
          description: routeResult.description,
          success: true,
          timestamp: Date.now(),
        });

        // Brief pause to let the OS catch up
        await this.delay(300);
        continue;
      }

      console.log(`   ⚠️ Router couldn't handle: ${routeResult.description}`);

      // ─── LLM Vision Fallback ───────────────────────────────────
      console.log(`   🧠 Falling back to LLM vision...`);
      const fallbackResult = await this.executeLLMFallback(subtask, steps, debugDir, i);
      llmCallCount += fallbackResult.llmCalls;

      if (!fallbackResult.success) {
        console.log(`   ❌ LLM fallback failed for subtask: "${subtask}"`);
        // Don't abort entire task — try next subtask
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Done
    // ═══════════════════════════════════════════════════════════════
    this.state.status = 'idle';
    this.state.currentTask = undefined;
    this.brain.resetConversation();

    const result: TaskResult = {
      success: steps.length > 0 && steps.some(s => s.success),
      steps,
      duration: Date.now() - startTime,
    };

    console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${steps.length} steps (${llmCallCount} LLM call(s))`);
    return result;
  }

  /**
   * LLM vision fallback — used when the action router can't handle a subtask.
   * Takes screenshots, sends to LLM, executes returned actions.
   */
  private async executeLLMFallback(
    subtask: string,
    steps: StepResult[],
    debugDir: string,
    subtaskIndex: number,
  ): Promise<{ success: boolean; llmCalls: number }> {
    const stepDescriptions: string[] = [];
    const recentActions: string[] = [];
    let llmCalls = 0;

    for (let j = 0; j < MAX_LLM_FALLBACK_STEPS; j++) {
      if (this.aborted) break;

      // Capture RESIZED screenshot for LLM
      console.log(`   📸 LLM step ${j + 1}: Capturing screen...`);
      if (j > 0) await this.delay(1000);

      const screenshot = await this.vnc.captureForLLM();
      const ext = screenshot.format === 'jpeg' ? 'jpg' : 'png';
      fs.writeFileSync(
        path.join(debugDir, `subtask-${subtaskIndex}-step-${j}.${ext}`),
        screenshot.buffer,
      );
      console.log(`   💾 Saved debug screenshot (${(screenshot.buffer.length / 1024).toFixed(0)}KB, ${screenshot.llmWidth}x${screenshot.llmHeight})`);

      // Get accessibility context (best effort)
      let a11yContext: string | undefined;
      try {
        a11yContext = await this.a11y.getScreenContext();
      } catch {
        // Accessibility not available
      }

      // Ask AI what to do
      this.state.status = 'thinking';
      llmCalls++;
      const decision = await this.brain.decideNextAction(screenshot, subtask, stepDescriptions, a11yContext);

      // Done with this subtask?
      if (decision.done) {
        console.log(`   ✅ Subtask complete: ${decision.description}`);
        steps.push({ action: 'done', description: decision.description, success: true, timestamp: Date.now() });
        return { success: true, llmCalls };
      }

      // Error?
      if (decision.error) {
        console.log(`   ❌ LLM error: ${decision.error}`);
        steps.push({ action: 'error', description: decision.error, success: false, timestamp: Date.now() });
        return { success: false, llmCalls };
      }

      // Wait?
      if (decision.waitMs) {
        console.log(`   ⏳ Waiting ${decision.waitMs}ms: ${decision.description}`);
        await this.delay(decision.waitMs);
        stepDescriptions.push(decision.description);
        continue;
      }

      // Handle SEQUENCE
      if (decision.sequence) {
        console.log(`   📋 Sequence: ${decision.sequence.description} (${decision.sequence.steps.length} steps)`);

        for (const seqStep of decision.sequence.steps) {
          if (this.aborted) break;

          const tier = this.safety.classify(seqStep, seqStep.description);
          console.log(`   ${tierEmoji(tier)} ${seqStep.description}`);

          if (tier === SafetyTier.Confirm) {
            this.state.status = 'waiting_confirm';
            const approved = await this.safety.requestConfirmation(seqStep, seqStep.description);
            if (!approved) {
              steps.push({ action: 'rejected', description: `USER REJECTED: ${seqStep.description}`, success: false, timestamp: Date.now() });
              break;
            }
          }

          try {
            await this.executeAction(seqStep);
            steps.push({ action: seqStep.kind, description: seqStep.description, success: true, timestamp: Date.now() });
            stepDescriptions.push(seqStep.description);
            await this.delay(200);
          } catch (err) {
            console.error(`   Failed:`, err);
            steps.push({ action: seqStep.kind, description: `FAILED: ${seqStep.description}`, success: false, error: String(err), timestamp: Date.now() });
          }
        }
        continue; // Take new screenshot after sequence
      }

      // Handle SINGLE ACTION
      if (decision.action) {
        // Duplicate detection
        const actionKey = decision.action.kind + ('x' in decision.action ? `@${(decision.action as any).x},${(decision.action as any).y}` : ('key' in decision.action ? `@${(decision.action as any).key}` : ''));
        recentActions.push(actionKey);
        const lastN = recentActions.slice(-MAX_SIMILAR_ACTION);
        if (lastN.length >= MAX_SIMILAR_ACTION && lastN.every(a => a === lastN[0])) {
          console.log(`   🔄 Same action repeated ${MAX_SIMILAR_ACTION} times — giving up on this subtask`);
          steps.push({ action: 'stuck', description: `Stuck: repeated "${actionKey}"`, success: false, timestamp: Date.now() });
          return { success: false, llmCalls };
        }

        // Safety check
        const tier = this.safety.classify(decision.action, decision.description);
        console.log(`   ${tierEmoji(tier)} Action: ${decision.description}`);

        if (this.safety.isBlocked(decision.description)) {
          console.log(`   🚫 BLOCKED: ${decision.description}`);
          steps.push({ action: 'blocked', description: `BLOCKED: ${decision.description}`, success: false, timestamp: Date.now() });
          return { success: false, llmCalls };
        }

        if (tier === SafetyTier.Confirm) {
          this.state.status = 'waiting_confirm';
          this.state.currentStep = `Confirm: ${decision.description}`;
          const approved = await this.safety.requestConfirmation(decision.action, decision.description);
          if (!approved) {
            steps.push({ action: 'rejected', description: `USER REJECTED: ${decision.description}`, success: false, timestamp: Date.now() });
            continue;
          }
        }

        // Execute
        this.state.status = 'acting';
        try {
          await this.executeAction(decision.action);
          steps.push({ action: decision.action.kind, description: decision.description, success: true, timestamp: Date.now() });
          stepDescriptions.push(decision.description);
        } catch (err) {
          console.error(`   Failed:`, err);
          steps.push({ action: decision.action.kind, description: `FAILED: ${decision.description}`, success: false, error: String(err), timestamp: Date.now() });
        }
      }
    }

    return { success: false, llmCalls };
  }

  /**
   * Execute a single action (mouse, keyboard, or a11y).
   */
  private async executeAction(action: InputAction & { description?: string }): Promise<void> {
    if (action.kind.startsWith('a11y_')) {
      await this.executeA11yAction(action as A11yAction);
    } else if ('x' in action) {
      await this.vnc.executeMouseAction(action as any);
    } else {
      await this.vnc.executeKeyboardAction(action as any);
    }
  }

  // ─── Legacy executeTask (kept for backward compat) ──────────────
  // The old flow is removed; all task execution goes through the optimized path.

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

  private async executeA11yAction(action: A11yAction): Promise<void> {
    const actionMap: Record<string, 'click' | 'set-value' | 'get-value' | 'focus'> = {
      'a11y_click': 'click',
      'a11y_set_value': 'set-value',
      'a11y_get_value': 'get-value',
      'a11y_focus': 'focus',
    };
    const a11yAction = actionMap[action.kind];
    if (!a11yAction) throw new Error(`Unknown a11y action: ${action.kind}`);

    console.log(`   ♿ A11y ${a11yAction}: ${action.name || action.automationId} [${action.controlType || 'any'}]`);

    const result = await this.a11y.invokeElement({
      name: action.name,
      automationId: action.automationId,
      controlType: action.controlType,
      action: a11yAction,
      value: action.value,
    });

    if (!result.success) {
      throw new Error(result.error || 'A11y action failed');
    }
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
