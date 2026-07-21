import core from '../chat/core';
import {Conversation} from '../chat/interfaces';
import BaseNotifications from '../chat/notifications'; //tslint:disable-line:match-default-export-name

declare global {
    const NativeNotification: {
        notify(notify: boolean, title: string, text: string, icon: string, sound: string | null, data: string): void
        playSound(sound: string): void
        requestPermission(): void
        setSoundTheme(theme: string): void
        cancelConversation?(key: string): void
    };
}

document.addEventListener('notification-clicked', (e: Event) => {
    const conv = core.conversations.byKey((<Event & {detail: {data: string}}>e).detail.data);
    if(conv !== undefined) conv.show();
});

export default class Notifications extends BaseNotifications {
    // Set true (by NativeSocketConnection) while the iOS native socket's backgrounded-frame backlog is
    // being replayed on resume. Those messages were already alerted natively while backgrounded, so the
    // JS path must not re-fire here: NativeNotification.notify both plays the sound and buzzes a haptic,
    // which would otherwise produce a burst of duplicates every time the app is reopened.
    replaying = false;

    // Keep the native side's current sound theme in sync (cheap no-op when unchanged). Native
    // resolves themed sounds from the bundled www/sound-themes/<theme>/ and uses the theme's sound
    // for background notifications too. Mirrors chat/notifications.ts getSoundTheme.
    //
    // setSoundTheme only exists on the iOS bridge (NativeNotification.swift). The Android Kotlin
    // bridge (Notifications.kt) has no such method, so calling it there throws and aborts the whole
    // notify()/playSound() before the notification is ever posted. Guard the call so Android is
    // unaffected (it plays the default www/sounds/<name>.mp3 regardless of theme).
    private syncSoundTheme(): void {
        if(typeof (NativeNotification as any).setSoundTheme !== 'function') return; //tslint:disable-line:no-any
        const theme = (core.state as any).generalSettings?.soundTheme //tslint:disable-line:no-any
            || core.state.settings.soundTheme || 'default';
        NativeNotification.setSoundTheme(theme);
    }

    async notify(conversation: Conversation, title: string, body: string, icon: string, sound: string): Promise<void> {
        if(this.replaying) return; // already alerted natively while backgrounded
        if(!this.shouldNotify(conversation)) return;
        this.syncSoundTheme();
        NativeNotification.notify(core.state.settings.notifications && this.isInBackground, title, body, icon,
            core.state.settings.playSound ? sound : null, conversation.key); //tslint:disable-line:no-null-keyword
    }

    playSound(sound: string): void {
        if(this.replaying) return; // already alerted natively while backgrounded
        if(!core.state.settings.playSound) return;
        this.syncSoundTheme();
        NativeNotification.playSound(sound);
    }

    async requestPermission(): Promise<void> {
        return NativeNotification.requestPermission();
    }
}