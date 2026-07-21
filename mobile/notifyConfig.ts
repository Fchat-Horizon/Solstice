import core from '../chat/core';
import { Conversation as Interfaces } from '../chat/interfaces';

// iOS-only. Background notifications are decided natively (NativeSocket.swift) because JS is suspended
// while the app is backgrounded, so the shared foreground decision logic in chat/conversations.ts can't
// run. We precompute a flat, lowercased snapshot of that policy here and push it over the bridge
// (NativeSocket.setNotifyConfig) on connect and whenever it changes. Native then only does cheap
// membership / word-boundary checks. Mirrors the MSG/PRI handling in chat/conversations.ts.

interface ChannelNotifyConfig {
    title: string; // conversation.name, the human-readable room title
    highlights: string[]; // merged per-channel + (global if defaultHighlights) + (character if highlight on)
    watched: string[]; // merged per-channel + global watched/bookmarked users
    notifyAll: boolean; // channel set to notify on every message
}

interface NotifyConfig {
    character: string;
    ignored: string[];
    mutedPrivates: string[];
    globalHighlights: string[]; // fallback for channels not in the map
    globalWatched: string[];
    channels: { [channelId: string]: ChannelNotifyConfig };
}

const lower = (s: string): string => s.toLowerCase();

function buildNotifyConfig(): NotifyConfig {
    const settings = core.state.settings;
    const character = core.connection.character;
    const globalHighlightWords = settings.highlightWords.map(lower);
    const globalWatched = settings.horizonHighlightUsers.map(lower);
    // Foreground adds the own character as a highlight term when global highlight is on; mirror that for
    // the fallback list used when a channel isn't (yet) in the per-channel map.
    const globalHighlights =
        settings.highlight && character !== ''
            ? [...globalHighlightWords, lower(character)]
            : globalHighlightWords;

    const channels: { [channelId: string]: ChannelNotifyConfig } = {};
    for (const conv of core.conversations.channelConversations) {
        const s = conv.settings;
        const highlights = s.highlightWords.map(lower);
        if (s.defaultHighlights) highlights.push(...globalHighlightWords);
        const highlightOn =
            (s.highlight === Interfaces.Setting.Default && settings.highlight) ||
            s.highlight === Interfaces.Setting.True;
        if (highlightOn && character !== '') highlights.push(lower(character));
        channels[lower(conv.channel.id)] = {
            title: conv.name,
            highlights,
            watched: [...s.horizonHighlightUsers.map(lower), ...globalWatched],
            notifyAll: s.notify === Interfaces.Setting.True
        };
    }

    const mutedPrivates = core.conversations.privateConversations
        .filter(c => c.settings.notify === Interfaces.Setting.False)
        .map(c => lower(c.character.name));

    return {
        character,
        ignored: core.characters.ignoreList.map(lower),
        mutedPrivates,
        globalHighlights,
        globalWatched,
        channels
    };
}

// Serialized current snapshot. Used by the change-watcher (mobile/Index.vue) so it can both detect a
// change and push the very payload it compared, avoiding a second build.
export function notifyConfigJSON(): string {
    return JSON.stringify(buildNotifyConfig());
}

// Push a serialized snapshot to the native socket. No-op off iOS (the bridge global is absent).
export function pushNotifyConfig(json: string): void {
    const native = (window as any).NativeSocket as //tslint:disable-line:no-any
        | { setNotifyConfig(json: string): void }
        | undefined;
    if (native === undefined) return;
    native.setNotifyConfig(json);
}

// Build + push the current snapshot. Called on (re)connect.
export function sendNotifyConfig(): void {
    pushNotifyConfig(notifyConfigJSON());
}

// Clear a conversation's delivered notification and reset its unread count/badge natively when the user
// opens it (Discord-style one-notification-per-conversation). No-op off iOS (bridge global absent) or on
// an older native build without the method.
export function clearConversationNotification(key: string): void {
    // iOS: the native socket owns background notifications.
    const socket = (window as any).NativeSocket as //tslint:disable-line:no-any
        | { clearConversation(key: string): void }
        | undefined;
    if (socket !== undefined && typeof socket.clearConversation === 'function') {
        socket.clearConversation(key);
        return;
    }
    // Android: the Notifications bridge owns them.
    const notif = (window as any).NativeNotification as //tslint:disable-line:no-any
        | { cancelConversation?(key: string): void }
        | undefined;
    if (notif !== undefined && typeof notif.cancelConversation === 'function')
        notif.cancelConversation(key);
}
