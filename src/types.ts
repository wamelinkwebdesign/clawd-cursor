// ============================================
// Clawd Cursor — Core Types
// ============================================

export enum SafetyTier {
  Auto = 'auto',
  Preview = 'preview',
  Confirm = 'confirm',
}

export interface ScreenFrame {
  width: number;
  height: number;
  buffer: Buffer;       // raw pixel data from VNC
  timestamp: number;
  format: 'png' | 'jpeg' | 'raw';
}

export interface MouseAction {
  kind: 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll';
  x: number;
  y: number;
  endX?: number;  // for drag
  endY?: number;
  scrollDelta?: number;
}

export interface KeyboardAction {
  kind: 'type' | 'key_press';
  text?: string;       // for type
  key?: string;        // for key_press (e.g. "Return", "ctrl+c")
}

export type InputAction = MouseAction | KeyboardAction;

export interface TaskRequest {
  task: string;
  safetyOverride?: SafetyTier;
}

export interface TaskResult {
  success: boolean;
  steps: StepResult[];
  error?: string;
  duration: number;
}

export interface StepResult {
  action: string;
  description: string;
  success: boolean;
  screenshot?: string;  // base64
  error?: string;
  timestamp: number;
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'acting' | 'waiting_confirm' | 'paused';
  currentTask?: string;
  currentStep?: string;
  stepsCompleted: number;
  stepsTotal: number;
}

export interface ClawdConfig {
  vnc: {
    host: string;
    port: number;
    password: string;
  };
  server: {
    port: number;
    host: string;
  };
  ai: {
    provider: 'openclaw' | 'anthropic' | 'openai';
    apiKey?: string;
    model: string;
    visionModel: string;
  };
  safety: {
    defaultTier: SafetyTier;
    confirmPatterns: string[];  // regex patterns that force confirm
    blockedPatterns: string[];  // regex patterns that are blocked entirely
  };
  capture: {
    format: 'png' | 'jpeg';
    quality: number;           // jpeg quality 1-100
    maxWidth: number;          // resize for LLM (save tokens)
  };
}

export const DEFAULT_CONFIG: ClawdConfig = {
  vnc: {
    host: 'localhost',
    port: 5900,
    password: '',
  },
  server: {
    port: 3847,
    host: '127.0.0.1',
  },
  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    visionModel: 'claude-sonnet-4-20250514',
  },
  safety: {
    defaultTier: SafetyTier.Preview,
    confirmPatterns: ['send', 'delete', 'remove', 'purchase', 'buy', 'pay', 'submit'],
    blockedPatterns: ['format.*disk', 'rm -rf', 'shutdown', 'restart'],
  },
  capture: {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
  },
};

