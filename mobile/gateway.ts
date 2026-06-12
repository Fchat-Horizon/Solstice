import Axios from 'axios';
import core from '../chat/core';

/**
 * Bridges Solstice to a self-hosted fchat-gateway (see the separate fchat-gateway project).
 *
 * The phone owns the F-List connection while the app is open. When it is backgrounded, it hands the
 * character to the gateway, which logs in, watches for PMs and highlights, and pushes them to your
 * ntfy topic; on return the phone reclaims the character and the gateway stands down. F-List allows
 * only one live connection per character, so the two never run at once.
 *
 * All of this is opt-in: nothing happens unless the user enables it and fills in the gateway URL,
 * token and ntfy topic in the login screen's advanced settings.
 */

const HEARTBEAT_MS = 20000; // foreground keepalive; must stay under the gateway's presence timeout
const HANDOFF_DELAY_MS = 4000; // debounce: a quick glance away shouldn't churn a full hand-off
const STALE_RECONNECT_MS = 8000; // gateway off (iOS only): reconnect if backgrounded at least this long

function isIos(): boolean {
  return document.documentElement.dataset.mobileOs === 'ios';
}

// The gateway rejects a gateway/ntfy URL with no scheme, so a user who types "ntfy.sh/topic"
// (without https://) silently fails registration. Tolerate it by prepending https://.
function withHttps(u: string): string {
  const t = u.trim();
  if (t.length === 0 || /^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

class Gateway {
  private account = '';
  private password = '';
  private character = '';
  private connected = false; // this device currently holds the F-List connection
  private handedOff = false; // the gateway currently holds the character
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private handoffTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenAt = 0;
  private listening = false;

  // Read live config each call so changes in settings apply without a reload.
  private cfg(): { url: string; token: string; ntfyUrl: string } {
    const s = (window as any).__generalSettings || {}; //tslint:disable-line:no-any
    return {
      url: withHttps(String(s.gatewayUrl || '')).replace(/\/+$/, ''),
      token: String(s.gatewayToken || '').trim(),
      ntfyUrl: withHttps(String(s.gatewayNtfyUrl || ''))
    };
  }

  private get enabled(): boolean {
    const s = (window as any).__generalSettings || {}; //tslint:disable-line:no-any
    if (!s.gatewayEnabled) return false;
    const c = this.cfg();
    return c.url.length > 0 && c.token.length > 0 && c.ntfyUrl.length > 0;
  }

  /** Set up the foreground/background listener once (called from chat.ts at startup). */
  init(): void {
    if (this.listening) return;
    this.listening = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.onHidden();
      else this.onVisible();
    });
  }

  /** Called from the login flow when the F-List connection comes up as a character. */
  onConnected(account: string, password: string, character: string): void {
    this.account = account;
    this.password = password;
    this.character = character;
    this.connected = true;
    this.handedOff = false;
    if (!this.enabled) return;
    void this.register();
    this.startHeartbeat();
  }

  onDisconnected(): void {
    this.connected = false;
    this.stopHeartbeat();
  }

  private async post(path: string, body: object): Promise<number> {
    const c = this.cfg();
    try {
      const res = await Axios.post(`${c.url}${path}`, body, {
        headers: {
          Authorization: `Bearer ${c.token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000,
        validateStatus: () => true
      });
      return res.status;
    } catch {
      return 0; // network error: treat as not delivered
    }
  }

  private async register(): Promise<void> {
    await this.post('/v1/session', {
      account: this.account,
      password: this.password,
      character: this.character,
      ntfyUrl: this.cfg().ntfyUrl
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // While foregrounded we must keep the session "present" so the gateway's watchdog never steals
    // the character out from under us. A 404 means the gateway forgot us (it restarted): re-register.
    this.heartbeatTimer = setInterval(async () => {
      if (!this.enabled || !this.connected) return;
      const status = await this.post('/v1/heartbeat', { character: this.character });
      if (status === 404) await this.register();
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private onHidden(): void {
    this.hiddenAt = Date.now();
    if (!this.enabled || !this.connected || this.handedOff) return;
    if (this.handoffTimer !== undefined) clearTimeout(this.handoffTimer);
    this.handoffTimer = setTimeout(() => void this.handOff(), HANDOFF_DELAY_MS);
  }

  private onVisible(): void {
    const wasHidden = this.hiddenAt;
    this.hiddenAt = 0;
    if (this.handoffTimer !== undefined) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = undefined;
    }
    if (this.handedOff) {
      void this.reclaim();
      return;
    }
    // Gateway off: on iOS the suspended socket can come back dead-but-OPEN; force a fresh reconnect
    // rather than waiting out the 90s PIN timeout. Android holds the socket via its foreground
    // service, so leave it alone there.
    if (
      !this.enabled &&
      isIos() &&
      wasHidden !== 0 &&
      Date.now() - wasHidden > STALE_RECONNECT_MS
    )
      core.connection.forceReconnect();
  }

  // Phone going to sleep: free the character and let the gateway take over.
  private async handOff(): Promise<void> {
    this.handoffTimer = undefined;
    if (!this.enabled || !this.connected || this.handedOff) return;
    this.handedOff = true;
    this.stopHeartbeat();
    core.connection.close(); // clean close: frees the character, no auto-reconnect
    await this.post('/v1/presence', {
      character: this.character,
      state: 'background'
    });
  }

  // Phone is back: tell the gateway to stand down first (so the character is free), then reconnect.
  private async reclaim(): Promise<void> {
    this.handedOff = false;
    await this.post('/v1/presence', {
      character: this.character,
      state: 'foreground'
    });
    if (this.character.length > 0)
      // connect() is typed void on the interface but resolves a promise; wrap so a failed reconnect
      // (e.g. the gateway hasn't freed the character yet) doesn't surface as an unhandled rejection.
      Promise.resolve(core.connection.connect(this.character)).catch(() => undefined);
    // onConnected (fired by the 'connected' event) re-registers and restarts the heartbeat.
  }
}

export const gateway = new Gateway();
