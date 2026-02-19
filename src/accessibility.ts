/**
 * Accessibility Bridge — calls PowerShell scripts to query
 * the Windows UI Automation tree. No vision needed for most actions.
 * 
 * Flow: Node.js → spawn powershell → .NET UI Automation → JSON back
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

export class AccessibilityBridge {
  /**
   * List all visible top-level windows
   */
  async getWindows(): Promise<WindowInfo[]> {
    return this.runScript('get-windows.ps1');
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
      // Prefer automationId search (fast), fall back to name search with controlType
      const searchOpts: any = {};
      if (opts.automationId) {
        searchOpts.automationId = opts.automationId;
      } else if (opts.controlType) {
        searchOpts.controlType = opts.controlType;
      }
      // Only add name if we have nothing else (name search can be slow)
      if (Object.keys(searchOpts).length === 0 && opts.name) {
        searchOpts.automationId = opts.name; // Try as automationId first
      }
      const elements = await this.findElement(searchOpts);
      if (!elements || elements.length === 0) {
        return { success: false, error: `Element not found: ${opts.name || opts.automationId}` };
      }
      // findElement returns objects with processId field
      processId = (elements[0] as any).processId;
      if (!processId) {
        // Fallback: try to find via taskbar buttons which always have processId
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
        // Filter to taskbar buttons only (from explorer process)
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
