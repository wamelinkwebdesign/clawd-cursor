// Type declarations for rfb2 (VNC client library)
declare module 'rfb2' {
  import { EventEmitter } from 'events';

  interface RFBOptions {
    host: string;
    port: number;
    password?: string;
    securityType?: string;
  }

  interface RFBClient extends EventEmitter {
    width: number;
    height: number;
    requestUpdate(incremental: boolean, x: number, y: number, w: number, h: number): void;
    pointerEvent(x: number, y: number, buttonMask: number): void;
    keyEvent(key: number, down: boolean): void;
    end(): void;
  }

  function createConnection(options: RFBOptions): RFBClient;

  export default { createConnection };
}

