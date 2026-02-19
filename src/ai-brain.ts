/**
 * AI Brain — sends screenshots to a vision LLM and gets back
 * structured actions (click here, type this, press that key).
 * 
 * The LLM acts as the "eyes and brain" — it sees the screen
 * and decides what to do next to accomplish the task.
 */

import type { ClawdConfig, InputAction, ScreenFrame, MouseAction, KeyboardAction } from './types';

const SYSTEM_PROMPT = `You are Clawd Cursor, an AI desktop agent controlling a computer via VNC.
You can see the screen and execute mouse/keyboard actions.

When given a task, analyze the screenshot and respond with the NEXT SINGLE ACTION to take.
Respond in JSON format:

For mouse actions:
{"kind": "click", "x": 500, "y": 300, "description": "Click the Chrome icon on taskbar"}
{"kind": "double_click", "x": 100, "y": 200, "description": "Open the file"}
{"kind": "right_click", "x": 500, "y": 300, "description": "Open context menu"}
{"kind": "scroll", "x": 500, "y": 300, "scrollDelta": -3, "description": "Scroll down"}

For keyboard actions:
{"kind": "type", "text": "hello world", "description": "Type search query"}
{"kind": "key_press", "key": "Return", "description": "Press Enter to submit"}
{"kind": "key_press", "key": "ctrl+a", "description": "Select all text"}

Special responses:
{"kind": "done", "description": "Task completed successfully"}
{"kind": "error", "description": "Cannot proceed because..."}
{"kind": "wait", "description": "Waiting for page to load", "waitMs": 2000}

Rules:
- ONE action per response
- Always include "description" explaining what you're doing and why
- Use exact pixel coordinates based on what you see in the screenshot
- If you can't see what you need, try scrolling or navigating first
- If stuck, explain why in an error response
- Be precise with click targets — aim for center of buttons/links`;

export class AIBrain {
  private config: ClawdConfig;
  private conversationHistory: Array<{ role: string; content: any }> = [];

  constructor(config: ClawdConfig) {
    this.config = config;
  }

  /**
   * Given a screenshot and task context, decide the next action.
   */
  async decideNextAction(
    screenshot: ScreenFrame,
    task: string,
    previousSteps: string[] = [],
  ): Promise<{
    action: InputAction | null;
    description: string;
    done: boolean;
    error?: string;
    waitMs?: number;
  }> {
    const base64Image = screenshot.buffer.toString('base64');
    const mediaType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    // Build the user message with context
    let userMessage = `Task: ${task}\n`;
    if (previousSteps.length > 0) {
      userMessage += `\nSteps completed so far:\n${previousSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
    }
    userMessage += `\nAnalyze the screenshot and provide the next action.`;

    const response = await this.callVisionLLM(userMessage, base64Image, mediaType);

    try {
      // Parse the JSON response
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        return { action: null, description: 'Failed to parse AI response', done: false, error: response };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.kind === 'done') {
        return { action: null, description: parsed.description, done: true };
      }

      if (parsed.kind === 'error') {
        return { action: null, description: parsed.description, done: false, error: parsed.description };
      }

      if (parsed.kind === 'wait') {
        return { action: null, description: parsed.description, done: false, waitMs: parsed.waitMs || 2000 };
      }

      // Mouse or keyboard action
      const action = parsed as InputAction;
      return { action, description: parsed.description, done: false };
    } catch (err) {
      return { action: null, description: 'Failed to parse action', done: false, error: String(err) };
    }
  }

  private async callVisionLLM(
    userMessage: string,
    base64Image: string,
    mediaType: string,
  ): Promise<string> {
    const { provider, apiKey, visionModel } = this.config.ai;

    if (provider === 'anthropic') {
      return this.callAnthropic(userMessage, base64Image, mediaType, apiKey!, visionModel);
    } else if (provider === 'openai') {
      return this.callOpenAI(userMessage, base64Image, mediaType, apiKey!, visionModel);
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  private async callAnthropic(
    userMessage: string,
    base64Image: string,
    mediaType: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: userMessage,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json() as any;
    return data.content?.[0]?.text || '';
  }

  private async callOpenAI(
    userMessage: string,
    base64Image: string,
    mediaType: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${base64Image}`,
                },
              },
              {
                type: 'text',
                text: userMessage,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }
}

