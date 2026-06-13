import core from '../chat/core';
import {Conversation} from '../chat/interfaces';
import BaseNotifications from '../chat/notifications'; //tslint:disable-line:match-default-export-name

declare global {
    const NativeNotification: {
        notify(notify: boolean, title: string, text: string, icon: string, sound: string | null, data: string): void
        playSound(sound: string): void
        requestPermission(): void
        setSoundTheme(theme: string): void
    };
}

document.addEventListener('notification-clicked', (e: Event) => {
    const conv = core.conversations.byKey((<Event & {detail: {data: string}}>e).detail.data);
    if(conv !== undefined) conv.show();
});

export default class Notifications extends BaseNotifications {
    // Keep the native side's current sound theme in sync (cheap no-op when unchanged). Native
    // resolves themed sounds from the bundled www/sound-themes/<theme>/ and uses the theme's sound
    // for background notifications too. Mirrors chat/notifications.ts getSoundTheme.
    private syncSoundTheme(): void {
        const theme = (core.state as any).generalSettings?.soundTheme //tslint:disable-line:no-any
            || core.state.settings.soundTheme || 'default';
        NativeNotification.setSoundTheme(theme);
    }

    async notify(conversation: Conversation, title: string, body: string, icon: string, sound: string): Promise<void> {
        if(!this.shouldNotify(conversation)) return;
        this.syncSoundTheme();
        NativeNotification.notify(core.state.settings.notifications && this.isInBackground, title, body, icon,
            core.state.settings.playSound ? sound : null, conversation.key); //tslint:disable-line:no-null-keyword
    }

    playSound(sound: string): void {
        if(!core.state.settings.playSound) return;
        this.syncSoundTheme();
        NativeNotification.playSound(sound);
    }

    async requestPermission(): Promise<void> {
        return NativeNotification.requestPermission();
    }
}