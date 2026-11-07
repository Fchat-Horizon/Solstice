import Axios from 'axios';
import * as qs from 'qs';
import { sharedTicket, shareTicket } from './sessions';

// Mobile counterpart of electron/api-ticket.ts. Horizon 2.4.1 dropped the password form of
// Connection.setCredentials, so the connection now needs a ticket provider. The desktop one asks the
// Electron main process over IPC and hashes credentials with Node's crypto, neither of which exists in
// the WebView, so mobile keeps its own: same policy, in-page cache.
//
// F-List invalidates every earlier ticket for an account as soon as it issues a new one, and a ticket
// lives 30 minutes server-side. So the ticket fetched at login is reused for connecting, and a new one
// is only requested when it is close to expiring or the server has rejected it.

export interface ApiTicketResponse {
    ticket?: string;
    error: string;
    characters: { [key: string]: number };
    default_character: number;
}

const ticketLifetime = 25 * 60 * 1000;

let cached: { account: string; password: string; ticket: string; issuedAt: number } | undefined;
let inFlight: { account: string; password: string; request: Promise<ApiTicketResponse> } | undefined;

/** Requests a new ticket plus the character list. Network failures reject the way Axios does. */
export async function fetchApiTicket(account: string, password: string): Promise<ApiTicketResponse> {
    if (inFlight !== undefined && inFlight.account === account && inFlight.password === password)
        return inFlight.request;
    const request = (async () => {
        const data = (await Axios.post('https://www.f-list.net/json/getApiTicket.php', qs.stringify({
            account, password, no_friends: true, no_bookmarks: true, new_character_list: true
        }))).data as ApiTicketResponse;
        if (data.ticket !== undefined && data.error === '') {
            cached = { account, password, ticket: data.ticket, issuedAt: Date.now() };
            // With several characters signed in, each page has its own cache; publish the ticket so
            // the others pick it up instead of fetching one that would cancel this one.
            shareTicket({ account, ticket: data.ticket, issuedAt: cached.issuedAt });
        }
        return data;
    })();
    inFlight = { account, password, request };
    try {
        return await request;
    } finally {
        if (inFlight !== undefined && inFlight.request === request) inFlight = undefined;
    }
}

/** A Connection ticket provider that reuses the cached ticket until it is stale or rejected. */
export function ticketProvider(account: string, password: string): (invalidTicket?: string) => Promise<string> {
    return async (invalidTicket?: string) => {
        const shared = sharedTicket();
        if (shared !== undefined && shared.account === account && shared.ticket !== invalidTicket &&
            Date.now() - shared.issuedAt < ticketLifetime &&
            (cached === undefined || shared.issuedAt > cached.issuedAt))
            return shared.ticket;
        if (cached !== undefined && cached.account === account && cached.password === password &&
            cached.ticket !== invalidTicket && Date.now() - cached.issuedAt < ticketLifetime)
            return cached.ticket;
        const data = await fetchApiTicket(account, password);
        if (data.ticket === undefined || data.error !== '') throw new Error(data.error);
        return data.ticket;
    };
}
