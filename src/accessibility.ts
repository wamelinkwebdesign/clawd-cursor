/**
 * Accessibility Bridge — calls PowerShell scripts to query
 * the Windows UI Automation tree. No vision needed for most actions.
 * 
 * Flow: Node.js → spawn powershell → .NET UI Automation → JSON back
 * 
 * v2: Added window management helpers (focusWindow, launchApp, getActiveWindow)
 */

import { execFile } from 'child_process';
import * as path from 'path';

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const PS_TIMEOUT = 10000; // 10s timeout for PowerShell calls

export interface UIElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  bounds: { x: number; y: number; width: number; height: number };
  children?: UIElement[];
}

export interface WindowInfo {
  handle: number;
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
}

/** Cached window list with TTL */
interface WindowCache {
  windows: WindowInfo[];
  timestamp: number;
}

export class AccessibilityBridge {
  private windowCache: WindowCache | null = null;
  private readonly WINDOW_CACHE_TTL = 2000; // 2s cache for window list

  /**
   * List all visible top-level windows (cached for 2s)
   */
  async getWindows(forceRefresh = false): Promise<WindowInfo[]> {
    if (
      !forceRefresh &&
      this.windowCache &&
      Date.now() - this.windowCache.timestamp < this.WINDOW_CACHE_TTL
    ) {
      return this.windowCache.windows;
    }

    const windows = await this.runScript('get-windows.ps1');
    this.windowCache = { windows, timestamp: Date.now() };
    return windows;
  }

  /**
   * Invalidate the window cache (call after actions that change window state)
   */
  invalidateCache(): void {
    this.windowCache = null;
  }

  /**
   * Get UI tree for a window (or all top-level if no processId)
   */
  async getUITree(processId?: number, maxDepth = 3): Promise<UIElement[]> {
    const args: string[] = [];
    if (processId) args.push('-ProcessId', String(processId));
    args.push('-MaxDepth', String(maxDepth));
    return this.runScript('get-ui-tree.ps1', args);
  }

  /**
   * Find elements matching criteria
   */
  async findElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    processId?: number;
  }): Promise<UIElement[]> {
    const args: string[] = [];
    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.processId) args.push('-ProcessId', String(opts.processId));
    return this.runScript('find-element.ps1', args);
  }

  /**
   * Invoke an action on an element (click, set value, etc.)
   * Auto-discovers processId by finding the element first.
   */
  async invokeElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    action: 'click' | 'set-value' | 'get-value' | 'focus' | 'expand' | 'collapse';
    value?: string;
    processId?: number;
  }): Promise<{ success: boolean; value?: string; error?: string }> {
    let processId = opts.processId;

    // Auto-discover processId if not provided
    if (!processId) {
      const searchOpts: any = {};
      if (opts.automationId) {
        searchOpts.automationId = opts.automationId;
      } else if (opts.controlType) {
        searchOpts.controlType = opts.controlType;
      }
      if (Object.keys(searchOpts).length === 0 && opts.name) {
        searchOpts.automationId = opts.name;
      }
      const elements = await this.findElement(searchOpts);
      if (!elements || elements.length === 0) {
        return { success: false, error: `Element not found: ${opts.name || opts.automationId}` };
      }
      processId = (elements[0] as any).processId;
      if (!processId) {
        console.log(`   ♿ No processId for "${opts.name}", falling back to coordinate click`);
        return { success: false, error: `No processId for element: ${opts.name || opts.automationId}` };
      }
    }

    const args: string[] = ['-Action', opts.action, '-ProcessId', String(processId)];
    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.value) args.push('-Value', opts.value);
    return this.runScript('invoke-element.ps1', args);
  }

  // ─── Window Management Helpers (deterministic, no LLM) ────────────

  /**
   * Focus (bring to front) a window by title substring or processId.
   * Reliable — uses UIA WindowPattern + Win32 SetForegroundWindow fallback.
   */
  async focusWindow(title?: string, processId?: number): Promise<{ success: boolean; title?: string; processId?: number; error?: string }> {
    const args: string[] = [];
    if (title) args.push('-Title', title);
    if (processId) args.push('-ProcessId', String(processId));
    args.push('-Restore');  // Always restore from minimized

    try {
      const result = await this.runScript('focus-window.ps1', args);
      this.invalidateCache(); // Window state changed
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Get the currently active/focused window.
   * Checks window list for the one at (0,0) or with focus.
   */
  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      const windows = await this.getWindows(true); // force refresh
      // The focused window is typically not minimized and has the topmost position
      // We look at the window list — the first non-minimized window is usually focused
      // but for reliability we use a dedicated approach
      const nonMinimized = windows.filter(w => !w.isMinimized);
      if (nonMinimized.length === 0) return null;

      // Sort by z-order approximation: windows with bounds starting at screen origin
      // are more likely to be maximized/focused. But this is heuristic.
      // Better: check which window title matches the taskbar's active state
      return nonMinimized[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Find a window by app name/title (fuzzy match).
   */
  async findWindow(appNameOrTitle: string): Promise<WindowInfo | null> {
    const lower = appNameOrTitle.toLowerCase();
    const windows = await this.getWindows();

    // Exact process name match
    let match = windows.find(w => w.processName.toLowerCase() === lower);
    if (match) return match;

    // Title contains
    match = windows.find(w => w.title.toLowerCase().includes(lower));
    if (match) return match;

    // Process name contains
    match = windows.find(w => w.processName.toLowerCase().includes(lower));
    if (match) return match;

    return null;
  }

  /**
   * Get a text summary of the UI for the AI.
   * Includes windows list and taskbar buttons (always useful).
   * Optionally includes focused window UI tree.
   */
  async getScreenContext(focusedProcessId?: number): Promise<string> {
    try {
      const windows = await this.getWindows();
      let context = `WINDOWS:\n`;
      for (const w of windows) {
        context += `  ${w.isMinimized ? '🔽' : '🟢'} [${w.processName}] "${w.title}" pid:${w.processId}`;
        if (!w.isMinimized) context += ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}`;
        context += `\n`;
      }

      // Always include taskbar buttons (useful for launching/switching apps)
      try {
        const taskbarButtons = await this.findElement({ controlType: 'Button' });
        const tbButtons = taskbarButtons.filter((b: any) =>
          b.processId === 6664 && b.className?.includes('Taskbar')
        );
        if (tbButtons.length > 0) {
          context += `\nTASKBAR APPS:\n`;
          for (const b of tbButtons) {
            context += `  📌 "${b.name}" id:${(b as any).automationId} at (${b.bounds.x},${b.bounds.y})\n`;
          }
        }
      } catch { /* taskbar query failed, skip */ }

      // Include focused window's UI tree if provided
      if (focusedProcessId) {
        try {
          const tree = await this.getUITree(focusedProcessId, 2);
          context += `\nFOCUSED WINDOW UI TREE (pid:${focusedProcessId}):\n`;
          context += this.formatTree(Array.isArray(tree) ? tree : [tree], '  ');
        } catch { /* tree query failed, skip */ }
      }

      return context;
    } catch (err) {
      return `(Accessibility unavailable: ${err})`;
    }
  }

  private formatTree(elements: UIElement[], indent: string): string {
    let result = '';
    for (const el of elements) {
      const name = el.name ? `"${el.name}"` : '';
      const id = el.automationId ? `id:${el.automationId}` : '';
      const bounds = `@${el.bounds.x},${el.bounds.y}`;
      result += `${indent}[${el.controlType}] ${name} ${id} ${bounds}\n`;
      if (el.children) {
        result += this.formatTree(el.children, indent + '  ');
      }
    }
    return result;
  }

  private runScript(scriptName: string, args: string[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(SCRIPTS_DIR, scriptName);

      execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...args,
      ], {
        timeout: PS_TIMEOUT,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
      }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Accessibility script error (${scriptName}):`, error.message);
          reject(error);
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (parseErr) {
          console.error(`Failed to parse ${scriptName} output:`, stdout.substring(0, 200));
          reject(parseErr);
        }
      });
    });
  }
}
