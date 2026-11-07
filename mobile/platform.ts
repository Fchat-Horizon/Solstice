import Vue from 'vue';
import core from '../chat/core';
import { GeneralSettings } from '../chat/general-settings';
import { DirectoryPickerOptions, FilePickerOptions, PlatformServices, SpellcheckLanguage } from '../chat/platform';
import { setGeneralSettings } from './filesystem';

// Mobile counterpart of electron/platform.ts. Since Horizon 2.5 the settings menu (chat/SettingsView.vue)
// edits a copy of the app settings and saves it through core.platform instead of talking to Electron.
// The WebView has no main process, other windows, file pickers or Electron spell checker, so most of
// this is a no-op; the settings menu hides the options that would need them (see isMobile there).
export default class MobilePlatformService implements PlatformServices {
    async saveGeneralSettings(settings: GeneralSettings): Promise<void> {
        // Write into the live object rather than replacing it: core.state.generalSettings is the same
        // reactive object mobile/Index.vue renders from and that window.__generalSettings points at
        // (character pins, the update banner), so swapping it out would leave those holding a stale copy.
        const target = <Record<string, unknown>>(<unknown>core.state.generalSettings);
        for(const [key, value] of Object.entries(settings)) Vue.set(target, key, value);
        await setGeneralSettings(<never>target);
        // iOS resolves background notification sounds natively, so tell it about a theme change now
        // rather than at the next foreground sound (Android has no such method).
        const native = (<{NativeNotification?: {setSoundTheme?(theme: string): void}}><unknown>window).NativeNotification;
        if(native !== undefined && typeof native.setSoundTheme === 'function') native.setSoundTheme(settings.soundTheme || 'default');
    }

    // The log location is fixed by the native host on both platforms.
    async updateLogDirectory(_: string): Promise<void> {}

    // Desktop asks the main process to reload every other window. There is only one WebView.
    async reloadSettings(): Promise<void> {}

    async selectDirectory(_?: DirectoryPickerOptions): Promise<string | undefined> {
        return undefined;
    }

    async selectFile(_?: FilePickerOptions): Promise<string | undefined> {
        return undefined;
    }

    async openDirectory(_: string): Promise<void> {}

    // Phone keyboards bring their own spell checking; an empty list hides the picker.
    async getSpellcheckLanguages(): Promise<ReadonlyArray<SpellcheckLanguage>> {
        return [];
    }
}
