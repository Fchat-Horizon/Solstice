import { WebSocketConnection } from '../fchat';
import log from 'electron-log'; //tslint:disable-line:match-default-export-name

export default class Socket implements WebSocketConnection {
  static host = 'wss://chat.f-list.net/chat2';
  private socket: WebSocket;
  private lastHandler: Promise<void> = Promise.resolve();
  private lastCloseInfo = '';

  constructor() {
    this.socket = new WebSocket(Socket.host);
  }

  get readyState(): WebSocketConnection.ReadyState {
    return this.socket.readyState;
  }

  close(): void {
    log.debug('socket.close');
    this.socket.close();
  }

  onMessage(handler: (message: string) => void): void {
    this.socket.addEventListener('message', e => {
      this.lastHandler = this.lastHandler.then(
        () => handler(<string>e.data),
        err => {
          window.requestAnimationFrame(() => {
            throw err;
          });
          handler(<string>e.data);
        }
      );
    });
  }

  onOpen(handler: () => void): void {
    this.socket.addEventListener('open', handler);
  }

  onClose(handler: (e: CloseEvent) => void): void {
    this.socket.addEventListener('close', e => {
      // Remember the close code/reason so onError can report the real cause (the WebSocket
      // 'error' event itself carries no detail). Helps diagnose disconnects without a JS console.
      this.lastCloseInfo = `code ${e.code}${e.reason ? ` (${e.reason})` : ''}${
        e.wasClean ? '' : ', abnormal'
      }`;
      handler(e);
    });
  }

  onError(handler: (error: Error) => void): void {
    // The 'error' event exposes no detail, so surface the most recent close code/reason.
    this.socket.addEventListener('error', () =>
      handler(
        new Error(
          `WebSocket error for ${Socket.host}` +
            (this.lastCloseInfo ? ` — last close: ${this.lastCloseInfo}` : '')
        )
      )
    );
  }

  send(message: string): void {
    this.socket.send(message);
  }
}
