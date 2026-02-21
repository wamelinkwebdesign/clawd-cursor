/**
 * Computer Use API Adapter
 *
 * Uses Anthropic's native computer_20250124 tool spec instead of
 * custom prompt engineering. Claude natively understands how to
 * control a desktop — no JSON schema in prompts, no parse errors.
 *
 * The adapter handles:
 *  - Tool declaration with screen dimensions
 *  - Screenshot capture and submission as tool_results
 *  - Action execution via VNC client
 *  - Coordinate scaling (LLM space ↔ real screen)
 *  - The full agent loop (screenshot → action → screenshot → ...)
 */

import * as fs from 'fs';
import * as path from 'path';
import { VNCClient } from './vnc-client';
import { AccessibilityBridge } from './accessibility';
import { SafetyLayer } from './safety';
import { SafetyTier } from './types';
import type { ClawdConfig, StepResult } from './types';

const BETA_HEADER = 'computer-use-2025-01-24';
const MAX_ITERATIONS = 30;

const SYSTEM_PROMPT = `You are Clawd Cursor, an AI desktop agent controlling a Windows 11 computer via VNC.

WINDOWS 11 LAYOUT:
- Taskbar at BOTTOM, icons CENTERED
- Start button in CENTER of taskbar
- System tray (clock, icons) bottom-RIGHT

ACCESSIBILITY CONTEXT:
Each tool_result includes an ACCESSIBILITY section listing open windows, UI elements, and their coordinates. USE THIS to:
- Know which apps are open without guessing
- Find exact element positions instead of clicking blindly
- Identify the focused window and its UI tree

EFFICIENT PATTERNS (use these, don't click around guessing):
- Open an app: key "super", wait, type app name, key "Return"
- Navigate to URL: key "ctrl+l" (focuses address bar), type URL, key "Return"
- New browser tab: key "ctrl+t"
- Switch windows: click the window listed in ACCESSIBILITY section

EFFICIENCY RULES:
- Read the ACCESSIBILITY context FIRST before deciding actions
- Use keyboard shortcuts over mouse clicks when possible
- For drawing: chain multiple drags WITHOUT screenshots between them
- Only screenshot after major state changes — not after every action
- Be decisive. Don't click randomly to "explore" — the accessibility tree tells you what's there.`;

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: {
    action: string;
    coordinate?: [number, number];
    start_coordinate?: [number, number];
    text?: string;
    duration?: number;
    scroll_direction?: 'up' | 'down' | 'left' | 'right';
    scroll_amount?: number;
    key?: string;
  };
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock;

export interface ComputerUseResult {
  success: boolean;
  steps: StepResult[];
  llmCalls: number;
}

export class ComputerUseBrain {
  private config: ClawdConfig;
  private vnc: VNCClient;
  private a11y: AccessibilityBridge;
  private safety: SafetyLayer;
  private screenWidth: number;
  private screenHeight: number;
  private llmWidth: number;
  private llmHeight: number;
  private scaleFactor: number;

  constructor(config: ClawdConfig, vnc: VNCClient, a11y: AccessibilityBridge, safety: SafetyLayer) {
    this.config = config;
    this.vnc = vnc;
    this.a11y = a11y;
    this.safety = safety;

    const screen = vnc.getScreenSize();
    this.screenWidth = screen.width;
    this.screenHeight = screen.height;

    // Scale to ~1280px wide for token efficiency (same approach as existing)
    this.scaleFactor = Math.max(1, Math.ceil(screen.width / 1280));
    this.llmWidth = Math.round(screen.width / this.scaleFactor);
    this.llmHeight = Math.round(screen.height / this.scaleFactor);

    console.log(`   🖥️  Computer Use: declaring ${this.llmWidth}x${this.llmHeight} display (scale ${this.scaleFactor}x from ${this.screenWidth}x${this.screenHeight})`);
  }

  /**
   * Check if the current provider supports native Computer Use.
   */
  static isSupported(config: ClawdConfig): boolean {
    return config.ai.provider === 'anthropic' && !!config.ai.apiKey;
  }

  /**
   * Execute a subtask using the Computer Use tool loop.
   * Claude autonomously takes screenshots, decides actions, and executes them.
   */
  async executeSubtask(
    subtask: string,
    debugDir: string,
    subtaskIndex: number,
    priorSteps?: string[],
  ): Promise<ComputerUseResult> {
    const steps: StepResult[] = [];
    let llmCalls = 0;
    const messages: any[] = [];

    console.log(`   🖥️  Computer Use: "${subtask}"`);

    // Build context from prior completed steps so Claude doesn't redo work
    let taskMessage = subtask;
    if (priorSteps && priorSteps.length > 0) {
      taskMessage = `ALREADY COMPLETED (do NOT redo these):\n${priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nNOW DO THIS: ${subtask}`;
    }

    // Initial user message with the subtask
    messages.push({
      role: 'user',
      content: taskMessage,
    });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      llmCalls++;
      console.log(`   📡 Computer Use call ${i + 1}...`);

      const response = await this.callAPI(messages);

      if (response.error) {
        console.log(`   ❌ API error: ${response.error}`);
        steps.push({
          action: 'error',
          description: `Computer Use API error: ${response.error}`,
          success: false,
          timestamp: Date.now(),
        });
        return { success: false, steps, llmCalls };
      }

      // Add assistant response to conversation
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Log any text blocks
      for (const block of response.content) {
        if ((block as TextBlock).type === 'text') {
          const text = (block as TextBlock).text;
          if (text.trim()) {
            console.log(`   💬 Claude: ${text.substring(0, 120)}${text.length > 120 ? '...' : ''}`);
          }
        }
      }

      // If end_turn → task complete
      if (response.stop_reason === 'end_turn') {
        console.log(`   ✅ Computer Use: subtask complete`);
        steps.push({
          action: 'done',
          description: `Computer Use completed: "${subtask}"`,
          success: true,
          timestamp: Date.now(),
        });
        return { success: true, steps, llmCalls };
      }

      // If max_tokens → ran out of space
      if (response.stop_reason === 'max_tokens') {
        console.log(`   ⚠️ Max tokens reached`);
        steps.push({
          action: 'error',
          description: 'Max tokens reached during Computer Use',
          success: false,
          timestamp: Date.now(),
        });
        return { success: false, steps, llmCalls };
      }

      // Process tool_use blocks
      const toolResults: any[] = [];

      for (const block of response.content) {
        if ((block as ToolUseBlock).type !== 'tool_use') continue;

        const toolUse = block as ToolUseBlock;
        const { action } = toolUse.input;

        if (action === 'screenshot') {
          // Just take a screenshot + a11y context, no action to execute
          console.log(`   📸 Screenshot requested`);
          const screenshot = await this.vnc.captureForLLM();
          this.saveDebugScreenshot(screenshot.buffer, debugDir, subtaskIndex, i, 'screenshot');
          const a11yContext = await this.getA11yContext();

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: [
              this.screenshotToContent(screenshot),
              { type: 'text', text: a11yContext },
            ],
          });

          steps.push({
            action: 'screenshot',
            description: 'Captured screenshot + accessibility context',
            success: true,
            timestamp: Date.now(),
          });
        } else {
          // Execute the action
          const result = await this.executeAction(toolUse);
          console.log(`   ${result.error ? '❌' : '✅'} ${result.description}`);

          steps.push({
            action: action,
            description: result.description,
            success: !result.error,
            error: result.error,
            timestamp: Date.now(),
          });

          // Take a screenshot + a11y context after the action
          await this.delay(200); // let UI settle
          const screenshot = await this.vnc.captureForLLM();
          this.saveDebugScreenshot(screenshot.buffer, debugDir, subtaskIndex, i, action);
          const a11yContext = await this.getA11yContext();

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.error
              ? [{ type: 'text', text: `Error: ${result.error}` }]
              : [
                  this.screenshotToContent(screenshot),
                  { type: 'text', text: a11yContext },
                ],
          });
        }
      }

      // Send tool results back
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    console.log(`   ⚠️ Max iterations (${MAX_ITERATIONS}) reached`);
    return { success: false, steps, llmCalls };
  }

  // ─── API Call ───────────────────────────────────────────────────

  private async callAPI(messages: any[]): Promise<any> {
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.ai.apiKey!,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA_HEADER,
          },
          body: JSON.stringify({
            model: this.config.ai.visionModel,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: [{
              type: 'computer_20250124',
              name: 'computer',
              display_width_px: this.llmWidth,
              display_height_px: this.llmHeight,
              display_number: 1,
            }],
            messages,
          }),
        });

        const data = await response.json() as any;

        if (data.error) {
          const msg = data.error.message || JSON.stringify(data.error);
          console.warn(`   ⚠️ API error (attempt ${attempt + 1}): ${msg}`);
          if (attempt < MAX_RETRIES && response.status >= 500) {
            await this.delay(1000 * (attempt + 1));
            continue;
          }
          return { content: [], stop_reason: 'end_turn', error: msg };
        }

        return data;
      } catch (err) {
        console.warn(`   ⚠️ API call failed (attempt ${attempt + 1}): ${err}`);
        if (attempt < MAX_RETRIES) {
          await this.delay(1000 * (attempt + 1));
          continue;
        }
        return { content: [], stop_reason: 'end_turn', error: String(err) };
      }
    }

    return { content: [], stop_reason: 'end_turn', error: 'Max retries exceeded' };
  }

  // ─── Action Execution ──────────────────────────────────────────

  private async executeAction(toolUse: ToolUseBlock): Promise<{ description: string; error?: string }> {
    const { action, coordinate, start_coordinate, text, key } = toolUse.input;

    try {
      switch (action) {
        case 'left_click': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseClick(x, y);
          return { description: `Click at (${x}, ${y})` };
        }

        case 'right_click': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseRightClick(x, y);
          return { description: `Right click at (${x}, ${y})` };
        }

        case 'double_click': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseDoubleClick(x, y);
          return { description: `Double click at (${x}, ${y})` };
        }

        case 'triple_click': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseClick(x, y);
          await this.delay(50);
          await this.vnc.mouseClick(x, y);
          await this.delay(50);
          await this.vnc.mouseClick(x, y);
          return { description: `Triple click at (${x}, ${y})` };
        }

        case 'middle_click': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseDown(x, y, 2); // button 2 = middle
          await this.delay(50);
          await this.vnc.mouseUp(x, y);
          return { description: `Middle click at (${x}, ${y})` };
        }

        case 'mouse_move': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseMove(x, y);
          return { description: `Mouse move to (${x}, ${y})` };
        }

        case 'left_click_drag': {
          const [sx, sy] = this.scale(start_coordinate || coordinate!);
          const [ex, ey] = this.scale(coordinate!);
          await this.vnc.mouseDrag(sx, sy, ex, ey);
          return { description: `Drag (${sx},${sy}) → (${ex},${ey})` };
        }

        case 'left_mouse_down': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseDown(x, y);
          return { description: `Mouse down at (${x}, ${y})` };
        }

        case 'left_mouse_up': {
          const [x, y] = this.scale(coordinate!);
          await this.vnc.mouseUp(x, y);
          return { description: `Mouse up at (${x}, ${y})` };
        }

        case 'type': {
          if (!text) return { description: 'Type: empty text', error: 'No text provided' };
          await this.vnc.typeText(text);
          return { description: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"` };
        }

        case 'key': {
          if (!text) return { description: 'Key press: empty', error: 'No key provided' };
          // Map Anthropic key names to VNC key names
          const vncKey = this.mapKeyName(text);
          await this.vnc.keyPress(vncKey);
          return { description: `Key press: ${text}` };
        }

        case 'hold_key': {
          // Hold a modifier key — Claude will send the follow-up action next
          const holdKey = key || text || '';
          const vncKey = this.mapKeyName(holdKey);
          await this.vnc.keyPress(vncKey);
          return { description: `Hold key: ${holdKey}` };
        }

        case 'scroll': {
          const [x, y] = coordinate
            ? this.scale(coordinate)
            : [Math.round(this.screenWidth / 2), Math.round(this.screenHeight / 2)];
          const dir = toolUse.input.scroll_direction || 'down';
          const amount = toolUse.input.scroll_amount || 3;
          const delta = (dir === 'up' || dir === 'left') ? -amount : amount;
          await this.vnc.mouseScroll(x, y, delta);
          return { description: `Scroll ${dir} by ${amount} at (${x}, ${y})` };
        }

        case 'wait': {
          const duration = toolUse.input.duration || 2;
          console.log(`   ⏳ Waiting ${duration}s...`);
          await this.delay(duration * 1000);
          return { description: `Waited ${duration}s` };
        }

        default:
          return { description: `Unknown action: ${action}`, error: `Unsupported action: ${action}` };
      }
    } catch (err) {
      return { description: `${action} failed: ${err}`, error: String(err) };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  /** Get accessibility context — windows, elements, focused app */
  private async getA11yContext(): Promise<string> {
    try {
      // Get active window to include its UI tree
      const activeWindow = await this.a11y.getActiveWindow();
      const processId = activeWindow?.processId;
      const context = await this.a11y.getScreenContext(processId);
      return `\nACCESSIBILITY:\n${context}`;
    } catch {
      return '\nACCESSIBILITY: (unavailable)';
    }
  }

  /** Scale LLM coordinates to real screen coordinates */
  private scale(coords: [number, number]): [number, number] {
    return [
      Math.round(Math.min(Math.max(coords[0], 0), this.llmWidth) * this.scaleFactor),
      Math.round(Math.min(Math.max(coords[1], 0), this.llmHeight) * this.scaleFactor),
    ];
  }

  /** Map Anthropic key names to VNC key names */
  private mapKeyName(key: string): string {
    const keyMap: Record<string, string> = {
      'return': 'Return',
      'enter': 'Return',
      'space': ' ',
      'tab': 'Tab',
      'escape': 'Escape',
      'backspace': 'Backspace',
      'delete': 'Delete',
      'up': 'Up',
      'down': 'Down',
      'left': 'Left',
      'right': 'Right',
      'home': 'Home',
      'end': 'End',
      'pageup': 'PageUp',
      'page_up': 'PageUp',
      'pagedown': 'PageDown',
      'page_down': 'PageDown',
      'super': 'Super',
      'super_l': 'Super',
      'win': 'Super',
      'windows': 'Super',
      'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
      'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
      'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
    };

    // Handle modifier combos like "ctrl+c", "alt+f4"
    if (key.includes('+')) {
      return key.split('+').map(k => keyMap[k.trim().toLowerCase()] || k.trim()).join('+');
    }

    return keyMap[key.toLowerCase()] || key;
  }

  /** Convert a screenshot to Anthropic image content block */
  private screenshotToContent(screenshot: { buffer: Buffer; format: string }): any {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        data: screenshot.buffer.toString('base64'),
      },
    };
  }

  /** Save debug screenshot to disk */
  private saveDebugScreenshot(
    buffer: Buffer,
    debugDir: string,
    subtaskIndex: number,
    stepIndex: number,
    action: string,
  ): void {
    try {
      const filename = `cu-${subtaskIndex}-${stepIndex}-${action}.png`;
      fs.writeFileSync(path.join(debugDir, filename), buffer);
    } catch {
      // non-fatal
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
