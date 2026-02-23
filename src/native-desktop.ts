/**
 * Native Desktop Control — replaces VNC with direct OS-level input
 * using @nut-tree/nut-js for mouse/keyboard and screen capture.
 *
 * Drop-in replacement for VNCClient with the same public interface.
 * No network connection needed — controls the local desktop directly.
 *
 * - captureScreen() returns full-resolution frames
 * - captureForLLM() returns resized frames (1280px wide) with scaling metadata
 * - Coordinate scaling handled transparently
 */

import { EventEmitter } from 'events';
import sharp from 'sharp';
import { mouse, keyboard, screen, Button, Key, Point } from '@nut-tree-fork/nut-js';
import type { ClawdConfig, ScreenFrame, MouseAction, KeyboardAction } from './types';

// nut-js Key enum mapping from string key names
const KEY_MAP: Record<string, Key> = {
  'Return': Key.Enter,
  'Enter': Key.Enter,
  'Tab': Key.Tab,
  'Escape': Key.Escape,
  'Backspace': Key.Backspace,
  'Delete': Key.Delete,
  'Home': Key.Home,
  'End': Key.End,
  'PageUp': Key.PageUp,
  'PageDown': Key.PageDown,
  'Left': Key.Left,
  'Up': Key.Up,
  'Right': Key.Right,
  'Down': Key.Down,
  'F1': Key.F1, 'F2': Key.F2, 'F3': Key.F3, 'F4': Key.F4,
  'F5': Key.F5, 'F6': Key.F6, 'F7': Key.F7, 'F8': Key.F8,
  'F9': Key.F9, 'F10': Key.F10, 'F11': Key.F11, 'F12': Key.F12,
  'Shift': Key.LeftShift,
  'Control': Key.LeftControl,
  'ctrl': Key.LeftControl,
  'Alt': Key.LeftAlt,
  'alt': Key.LeftAlt,
  'Meta': Key.LeftSuper,
  'Super': Key.LeftSuper,
  'Win': Key.LeftSuper,
  'Windows': Key.LeftSuper,
  'Space': Key.Space,
  'space': Key.Space,
};

/** LLM screenshot target width — halves tokens for 2560px screens */
const LLM_TARGET_WIDTH = 1280;

export class NativeDesktop extends EventEmitter {
  private config: ClawdConfig;
  private screenWidth = 0;
  private screenHeight = 0;
  private connected = false;

  /** Scale factor: LLM coordinates × scaleFactor = real screen coordinates */
  private scaleFactor = 1;

  constructor(config: ClawdConfig) {
    super();
    this.config = config;
  }

  /**
   * "Connect" to the native desktop — detects screen size and configures nut-js.
   * No actual network connection; just initializes the local screen interface.
   */
  async connect(): Promise<void> {
    try {
      // Configure nut-js for speed
      mouse.config.mouseSpeed = 2000;    // Fast mouse movement
      mouse.config.autoDelayMs = 0;      // No auto-delay between actions
      keyboard.config.autoDelayMs = 0;   // No auto-delay between keystrokes

      // Grab a screenshot to determine screen dimensions
      const img = await screen.grab();
      this.screenWidth = img.width;
      this.screenHeight = img.height;

      // Calculate scale factor
      if (this.screenWidth > LLM_TARGET_WIDTH) {
        this.scaleFactor = this.screenWidth / LLM_TARGET_WIDTH;
      } else {
        this.scaleFactor = 1;
      }

      this.connected = true;

      console.log(`🐾 Native desktop connected`);
      console.log(`   Screen: ${this.screenWidth}x${this.screenHeight}`);
      console.log(`   LLM scale factor: ${this.scaleFactor.toFixed(2)}x`);
    } catch (err: any) {
      console.error('Native desktop init error:', err?.message);
      this.connected = false;
      throw err;
    }
  }

  /**
   * Capture a full-resolution screenshot.
   */
  async captureScreen(): Promise<ScreenFrame> {
    if (!this.connected) {
      throw new Error('Not connected to native desktop');
    }

    const img = await screen.grab();

    // Update screen dimensions in case of resolution change
    this.screenWidth = img.width;
    this.screenHeight = img.height;

    const processed = await this.processFrame(
      img.data,
      img.width,
      img.height,
      this.screenWidth,
      this.screenHeight,
    );

    return {
      width: this.screenWidth,
      height: this.screenHeight,
      buffer: processed,
      timestamp: Date.now(),
      format: this.config.capture.format,
    };
  }

  /**
   * Capture a RESIZED screenshot optimized for LLM vision.
   * - Resized to 1280px wide (or less if screen is smaller)
   * - Much smaller payload = fewer tokens = faster API calls
   * - Returns scaleFactor so coordinates in AI response can be mapped back
   */
  async captureForLLM(): Promise<ScreenFrame & { scaleFactor: number; llmWidth: number; llmHeight: number }> {
    if (!this.connected) {
      throw new Error('Not connected to native desktop');
    }

    const img = await screen.grab();

    // Update screen dimensions
    this.screenWidth = img.width;
    this.screenHeight = img.height;

    // Recalculate scale factor in case resolution changed
    if (this.screenWidth > LLM_TARGET_WIDTH) {
      this.scaleFactor = this.screenWidth / LLM_TARGET_WIDTH;
    } else {
      this.scaleFactor = 1;
    }

    const llmWidth = Math.min(this.screenWidth, LLM_TARGET_WIDTH);
    const llmHeight = Math.round(this.screenHeight / this.scaleFactor);

    const processed = await this.processFrame(
      img.data,
      img.width,
      img.height,
      llmWidth,
      llmHeight,
    );

    return {
      width: this.screenWidth,       // real screen width
      height: this.screenHeight,     // real screen height
      buffer: processed,
      timestamp: Date.now(),
      format: this.config.capture.format,
      scaleFactor: this.scaleFactor,
      llmWidth,
      llmHeight,
    };
  }

  /**
   * Get the scaling factor (LLM pixels → real screen pixels)
   */
  getScaleFactor(): number {
    return this.scaleFactor;
  }

  /**
   * Process a raw RGBA buffer into the configured output format.
   * nut-js screen.grab() returns RGBA data directly — no BGRA swap needed.
   */
  private async processFrame(
    rawData: Buffer,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number,
  ): Promise<Buffer> {
    const { format, quality } = this.config.capture;

    let pipeline = sharp(rawData, {
      raw: {
        width: srcWidth,
        height: srcHeight,
        channels: 4,
      },
    });

    // Resize if target is smaller than source
    if (targetWidth < srcWidth || targetHeight < srcHeight) {
      pipeline = pipeline.resize(targetWidth, targetHeight, {
        fit: 'fill',
        kernel: 'lanczos3',
      });
    }

    if (format === 'jpeg') {
      return pipeline.jpeg({ quality }).toBuffer();
    }
    return pipeline.png().toBuffer();
  }

  // --- Input Methods ---

  async mouseClick(x: number, y: number, button: number = 1): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Click at (${x}, ${y})`);
    await mouse.setPosition(new Point(x, y));
    await this.delay(50);
    const btn = this.mapButton(button);
    await mouse.click(btn);
  }

  async mouseDoubleClick(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Double-click at (${x}, ${y})`);
    await mouse.setPosition(new Point(x, y));
    await this.delay(50);
    await mouse.doubleClick(Button.LEFT);
  }

  async mouseRightClick(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Right-click at (${x}, ${y})`);
    await mouse.setPosition(new Point(x, y));
    await this.delay(50);
    await mouse.rightClick();
  }

  async mouseMove(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await mouse.setPosition(new Point(x, y));
  }

  async mouseScroll(x: number, y: number, delta: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Scroll at (${x}, ${y}) delta=${delta}`);
    await mouse.setPosition(new Point(x, y));
    await this.delay(30);
    const steps = Math.abs(Math.round(delta));
    for (let i = 0; i < steps; i++) {
      if (delta > 0) {
        await mouse.scrollDown(3);
      } else {
        await mouse.scrollUp(3);
      }
      await this.delay(30);
    }
  }

  async typeText(text: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   ⌨️  Typing: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
    await keyboard.type(text);
  }

  async keyPress(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   ⌨️  Key press: ${keyCombo}`);

    const parts = keyCombo.split('+').map(k => k.trim());
    const keys = parts.map(k => this.mapKey(k));

    if (keys.length === 1) {
      await keyboard.pressKey(keys[0]);
      await this.delay(30);
      await keyboard.releaseKey(keys[0]);
    } else {
      // Press all modifier keys down, then the final key, then release in reverse
      for (const key of keys) {
        await keyboard.pressKey(key);
        await this.delay(30);
      }
      for (const key of [...keys].reverse()) {
        await keyboard.releaseKey(key);
        await this.delay(30);
      }
    }
  }

  async executeMouseAction(action: MouseAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.mouseClick(action.x, action.y);
        break;
      case 'double_click':
        await this.mouseDoubleClick(action.x, action.y);
        break;
      case 'right_click':
        await this.mouseRightClick(action.x, action.y);
        break;
      case 'move':
        await this.mouseMove(action.x, action.y);
        break;
      case 'scroll':
        await this.mouseScroll(action.x, action.y, action.scrollDelta || 3);
        break;
      case 'drag':
        await this.mouseDrag(action.x, action.y, action.endX || action.x, action.endY || action.y);
        break;
    }
  }

  async executeKeyboardAction(action: KeyboardAction): Promise<void> {
    switch (action.kind) {
      case 'type':
        if (action.text) await this.typeText(action.text);
        break;
      case 'key_press':
        if (action.key) await this.keyPress(action.key);
        break;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Low-level key control (for Computer Use API hold_key) ────────

  async keyDown(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   ⌨️  Key down: ${keyCombo}`);
    const parts = keyCombo.split('+').map(k => k.trim());
    for (const k of parts) {
      const key = this.mapKey(k);
      await keyboard.pressKey(key);
      await this.delay(20);
    }
  }

  async keyUp(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   ⌨️  Key up: ${keyCombo}`);
    const parts = keyCombo.split('+').map(k => k.trim());
    for (const k of [...parts].reverse()) {
      const key = this.mapKey(k);
      await keyboard.releaseKey(key);
      await this.delay(20);
    }
  }

  // ─── Low-level pointer control (for Computer Use API) ────────────

  async mouseDown(x: number, y: number, button: number = 1): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Mouse down at (${x}, ${y})`);
    await mouse.setPosition(new Point(x, y));
    const btn = this.mapButton(button);
    await mouse.pressButton(btn);
  }

  async mouseUp(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Mouse up at (${x}, ${y})`);
    await mouse.setPosition(new Point(x, y));
    await mouse.releaseButton(Button.LEFT);
  }

  async mouseDrag(sx: number, sy: number, ex: number, ey: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Drag (${sx},${sy}) → (${ex},${ey})`);

    await mouse.setPosition(new Point(sx, sy));
    await this.delay(50);
    await mouse.pressButton(Button.LEFT);
    await this.delay(100);

    // Interpolate intermediate points for smoother drag
    const steps = Math.max(5, Math.floor(Math.hypot(ex - sx, ey - sy) / 20));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = Math.round(sx + (ex - sx) * t);
      const iy = Math.round(sy + (ey - sy) * t);
      await mouse.setPosition(new Point(ix, iy));
      await this.delay(15);
    }

    await mouse.releaseButton(Button.LEFT);
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  disconnect(): void {
    this.connected = false;
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.emit('disconnected');
    console.log('🐾 Native desktop disconnected');
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /**
   * Map a button number to nut-js Button enum.
   * 1=left, 2=middle, 4=right
   */
  private mapButton(buttonId: number): Button {
    switch (buttonId) {
      case 1: return Button.LEFT;
      case 2: return Button.MIDDLE;
      case 4: return Button.RIGHT;
      default: return Button.LEFT;
    }
  }

  /**
   * Map a string key name to nut-js Key enum value.
   * Falls back to character-based lookup for single characters.
   */
  private mapKey(keyName: string): Key {
    // Direct lookup in our map
    const mapped = KEY_MAP[keyName];
    if (mapped !== undefined) return mapped;

    // Case-insensitive lookup
    const lowerKey = keyName.toLowerCase();
    for (const [name, val] of Object.entries(KEY_MAP)) {
      if (name.toLowerCase() === lowerKey) return val;
    }

    // Single character — try to find matching Key enum entry
    if (keyName.length === 1) {
      const upper = keyName.toUpperCase();
      // Letters A-Z
      if (upper >= 'A' && upper <= 'Z') {
        const keyEntry = Key[upper as keyof typeof Key];
        if (keyEntry !== undefined) return keyEntry;
      }
      // Digits 0-9
      if (upper >= '0' && upper <= '9') {
        const numKey = `Num${upper}` as keyof typeof Key;
        const keyEntry = Key[numKey];
        if (keyEntry !== undefined) return keyEntry;
      }
    }

    // Last resort: try exact enum name match
    const enumKey = keyName as keyof typeof Key;
    if (Key[enumKey] !== undefined) return Key[enumKey];

    console.warn(`   ⚠️  Unknown key: "${keyName}", falling back to Key.Space`);
    return Key.Space;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
