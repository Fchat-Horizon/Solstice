import { WebSocketConnection } from '../fchat/interfaces';
import Socket from '../chat/WebSocket';
import core from '../chat/core';

// iOS-only WebSocketConnection backed by the native URLSessionWebSocketTask bridge
// (window.NativeSocket, see mobile/ios/Solstice/Bridge/NativeSocket.swift).
//
// The browser WebSocket lives in WKWebView's WebContent process, which iOS suspends in the
// background even when the host app is kept awake by the audio background mode, so F-List's PIN
// keepalive goes unanswered and the connection drops. Running the socket natively keeps it alive;
// native answers PIN, so this transport reports `nativeKeepalive` and the shared Connection skips
// its own PIN handling. Inbound frames arrive via window.__nativeSocketEvent, dispatched by native.
//
// Host is read from the browser Socket class so the single `Socket.host = settings.host` in
// Index.vue configures this transport too.

declare const NativeSocket: {
  connect(url: string): Promise<void>;
  send(message: string): Promise<void>;
  close(): Promise<void>;
};

type NativeClose = { code: number; reason: string; wasClean: boolean };

export default class NativeSocketConnection implements WebSocketConnection {
  readonly nativeKeepalive = true;

  // Only one connection is live at a time (Connection owns it); native dispatches to whichever
  // instance most recently connected.
  private static current?: NativeSocketConnection;

  private state: WebSocketConnection.ReadyState =
    WebSocketConnection.ReadyState.CONNECTING;
  private lastHandler: Promise<void> = Promise.resolve();
  private messageHandler?: (
    message: string,
    receivedAt?: number
  ) => Promise<void>;
  private openHandler?: () => void;
  private closeHandler?: (e: CloseEvent) => void;
  private errorHandler?: (error: Error) => void;

  constructor() {
    NativeSocketConnection.current = this;
    void NativeSocket.connect(Socket.host);
  }

  static deliver(type: string, payload: unknown): void {
    NativeSocketConnection.current?.handle(type, payload);
  }

  private handle(type: string, payload: unknown): void {
    switch (type) {
      case 'open':
        this.state = WebSocketConnection.ReadyState.OPEN;
        if (this.openHandler !== undefined) this.openHandler();
        break;
      case 'message':
        this.enqueue(String(payload));
        break;
      case 'batch':
        // Frames native buffered while backgrounded, in arrival order, each with its arrival time.
        for (const [text, at] of payload as [string, number][])
          this.enqueue(text, at);
        break;
      case 'resync': {
        // Native's background buffer overflowed and dropped presence frames, so the online list is
        // stale. Once the replayed backlog is handled, close the socket: the Connection reconnects,
        // and the fresh login resends the full online list.
        const resync = async (): Promise<void> => this.close();
        this.lastHandler = this.lastHandler.then(resync, resync);
        break;
      }
      case 'close': {
        this.state = WebSocketConnection.ReadyState.CLOSED;
        const c = (payload as NativeClose) || {
          code: 1006,
          reason: '',
          wasClean: false
        };
        if (this.closeHandler !== undefined)
          this.closeHandler({
            code: c.code,
            reason: c.reason,
            wasClean: c.wasClean
          } as CloseEvent);
        break;
      }
      case 'error':
        if (this.errorHandler !== undefined)
          this.errorHandler(
            new Error(
              `WebSocket error for ${Socket.host}` +
                (payload ? ` (${String(payload)})` : '')
            )
          );
        break;
    }
  }

  // Queue a frame behind the ones before it. `receivedAt` (ms) is present only for frames replayed
  // from native's background buffer, so they keep their real arrival time.
  private enqueue(text: string, receivedAt?: number): void {
    if (this.messageHandler === undefined) return;
    const handler = this.messageHandler;
    // Replayed frames were already alerted natively while backgrounded; suppress the JS
    // notification path for them so reopening doesn't re-fire a burst of sounds/haptics.
    // lastHandler serializes handling, so exactly one frame runs at a time and the flag
    // brackets only this frame (live frames have no receivedAt and are untouched).
    const run = async (): Promise<void> => {
      const notifications = core.notifications as { replaying?: boolean };
      const replay = receivedAt !== undefined;
      if (replay) notifications.replaying = true;
      try {
        await handler(text, receivedAt);
      } finally {
        if (replay) {
          // Hold suppression through one microtask so a notification/sound the handler
          // scheduled (rather than awaited) is still covered. Safe because lastHandler
          // serializes handling: the next frame can't run until this run settles, so a live
          // frame never overlaps the suppressed window.
          await Promise.resolve();
          notifications.replaying = false;
        }
      }
    };
    this.lastHandler = this.lastHandler.then(run, run);
  }

  get readyState(): WebSocketConnection.ReadyState {
    return this.state;
  }

  close(): void {
    this.state = WebSocketConnection.ReadyState.CLOSING;
    void NativeSocket.close();
  }

  onMessage(
    handler: (message: string, receivedAt?: number) => Promise<void>
  ): void {
    this.messageHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onClose(handler: (e: CloseEvent) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  send(message: string): void {
    void NativeSocket.send(message);
  }
}

// Native (NativeSocket.swift) pushes socket events here.
(window as any).__nativeSocketEvent = ( //tslint:disable-line:no-any
  type: string,
  payload: unknown
): void => NativeSocketConnection.deliver(type, payload);
