import { WebSocketConnection } from '../fchat/interfaces';
import Socket from '../chat/WebSocket';

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
  private messageHandler?: (message: string) => Promise<void>;
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
        if (this.messageHandler !== undefined) {
          const handler = this.messageHandler;
          const text = String(payload);
          this.lastHandler = this.lastHandler.then(
            () => handler(text),
            () => handler(text)
          );
        }
        break;
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

  get readyState(): WebSocketConnection.ReadyState {
    return this.state;
  }

  close(): void {
    this.state = WebSocketConnection.ReadyState.CLOSING;
    void NativeSocket.close();
  }

  onMessage(handler: (message: string) => Promise<void>): void {
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
(window as any).__nativeSocketEvent = (type: string, payload: unknown): void => //tslint:disable-line:no-any
  NativeSocketConnection.deliver(type, payload);
