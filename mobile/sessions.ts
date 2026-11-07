import Vue from 'vue';

// Prototype: several characters at once. The native host (MainActivity on Android, WebViewController
// and ChatPage on iOS) runs one WebView per character, like desktop runs one page per tab, and exposes
// NativeSessions to each of them; iOS serves the synchronous getters from a copy kept in bridge.js. This
// module is the page's side of that: it reports this character's state, keeps a reactive copy of every
// session's, and wraps the calls that switch, add and close sessions. Which switcher UI is drawn is
// chosen at build time (SWITCHER_DESIGN), so the three prototype builds differ only in this flag.

export type SwitcherDesign = 'tabs' | 'drawer' | 'sheet' | '';
export const switcherDesign = <SwitcherDesign>(process.env.SWITCHER_DESIGN || '');

export interface SessionInfo {
    id: number;
    character?: string;
    connected?: boolean;
    status?: string;
    unread?: number;
    pmFrom?: string[];
    mentions?: string[];
}

interface Snapshot {
    active: number;
    max: number;
    sessions: SessionInfo[];
}

interface NativeSessionsBridge {
    id(): number;
    max(): number;
    state(): string;
    report(json: string): void;
    switchTo(id: number): void;
    add(): boolean;
    close(id: number): void;
    setCredentials(json: string): void;
    getCredentials(): string;
    getTicket(): string;
    setTicket(json: string): void;
}

const native = (<{NativeSessions?: NativeSessionsBridge}><unknown>window).NativeSessions;

export const sessionsEnabled = switcherDesign !== '' && native !== undefined;

export const sessions = Vue.observable({self: 0, active: 0, max: 3, list: <SessionInfo[]>[]});

function apply(snapshot: Snapshot): void {
    sessions.active = snapshot.active;
    sessions.max = snapshot.max;
    sessions.list = snapshot.sessions;
}

if(sessionsEnabled) {
    sessions.self = native!.id();
    try {
        apply(<Snapshot>JSON.parse(native!.state()));
    } catch {
        // the host sends a fresh snapshot on the next change anyway
    }
    (<{__solsticeSessions?: (s: Snapshot) => void}><unknown>window).__solsticeSessions = apply;
}

export function otherSessions(): SessionInfo[] {
    return sessions.list.filter((s) => s.id !== sessions.self);
}

export function otherUnread(): number {
    return otherSessions().reduce((sum, s) => sum + (s.unread || 0), 0);
}

export function canAddSession(): boolean {
    return sessions.list.length < sessions.max;
}

/** Characters signed in by the other sessions, so the character list can leave them out. */
export function charactersInUse(): string[] {
    return otherSessions().map((s) => s.character).filter((c): c is string => c !== undefined && c !== '');
}

/** A page the host opened with "add a character" logs in straight away with the shared account. */
export function isSpawnedSession(): boolean {
    return sessionsEnabled && sessions.self !== 1;
}

let lastReport = '';
export function report(info: Omit<SessionInfo, 'id'>): void {
    if(!sessionsEnabled) return;
    const json = JSON.stringify(info);
    if(json === lastReport) return;
    lastReport = json;
    native!.report(json);
}

export function switchTo(id: number): void {
    if(sessionsEnabled && id !== sessions.self) native!.switchTo(id);
}

export function addSession(): boolean {
    return sessionsEnabled && native!.add();
}

export function closeSession(id: number): void {
    if(sessionsEnabled) native!.close(id);
}

export function sharedCredentials(): {account: string, password: string} | undefined {
    if(!sessionsEnabled) return undefined;
    try {
        const raw = native!.getCredentials();
        return raw !== '' ? <{account: string, password: string}>JSON.parse(raw) : undefined;
    } catch {
        return undefined;
    }
}

export function shareCredentials(account: string, password: string): void {
    if(sessionsEnabled) native!.setCredentials(JSON.stringify({account, password}));
}

// F-List cancels an account's older tickets as soon as it issues a new one, so every session has to
// use the same ticket (desktop shares it through its main process). mobile/api-ticket.ts reads and
// writes it here when sessions are on.
export interface SharedTicket {
    account: string;
    ticket: string;
    issuedAt: number;
}

export function sharedTicket(): SharedTicket | undefined {
    if(!sessionsEnabled) return undefined;
    try {
        const raw = native!.getTicket();
        return raw !== '' ? <SharedTicket>JSON.parse(raw) : undefined;
    } catch {
        return undefined;
    }
}

export function shareTicket(ticket: SharedTicket): void {
    if(sessionsEnabled) native!.setTicket(JSON.stringify(ticket));
}
