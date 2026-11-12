<template>
    <div id="page" style="position: relative; padding: var(--page-pad);" :class="themeClass" v-if="settings">
        <div v-html="styling"></div>
        <update-banner></update-banner>
        <div v-if="!characters" style="display:flex; align-items:center; justify-content:center; min-height: 100%;">
            <div class="card bg-light" style="width: 400px;">
                <h3 class="card-header" style="margin-top:0">{{l('title')}}</h3>
                <div class="card-body">
                    <div class="alert alert-danger" v-show="error">
                        {{error}}
                    </div>
                    <div class="mb-3">
                        <label class="control-label" for="account">{{l('login.account')}}</label>
                        <input class="form-control" id="account" v-model="settings.account" @keypress.enter="login()" :disabled="loggingIn"/>
                    </div>
                    <div class="mb-3">
                        <label class="control-label" for="password">{{l('login.password')}}</label>
                        <input class="form-control" type="password" id="password" v-model="settings.password" @keypress.enter="login()" :disabled="loggingIn"/>
                    </div>
                    <div class="mb-3" v-show="showAdvanced">
                        <label class="control-label" for="host">{{l('login.host')}}</label>
                        <div class="input-group">
                            <input class="form-control" id="host" v-model="settings.host" @keypress.enter="login()" :disabled="loggingIn"/>
                            <div class="input-group-append">
                                <button class="btn btn-outline-secondary" @click="resetHost"><span class="fas fa-undo-alt"></span></button>
                            </div>
                        </div>
                    </div>
                    <div class="mb-3">
                        <label class="control-label" for="theme">{{l('settings.theme')}}</label>
                        <select class="form-select form-select" id="theme" v-model="settings.theme">
                            <option v-for="theme in availableThemes" :value="theme">{{`${theme}`}}</option>
                        </select>
                    </div>
                    <div class="mb-3">
                        <label for="advanced"><input type="checkbox" id="advanced" v-model="showAdvanced" class="form-check-input"/> {{l('login.advanced')}}</label>
                    </div>
                    <div class="mb-3">
                        <label for="save"><input type="checkbox" id="save" v-model="saveLogin" class="form-check-input"/> {{l('login.save')}}</label>
                    </div>
                    <div class="mb-3" style="text-align:right">
                        <button class="btn btn-primary" @click="login()" :disabled="loggingIn">
                            <div
                                v-if="loggingIn"
                                class="spinner-border spinner-border-sm"
                                role="status"
                            ></div>
                            {{l(loggingIn ? 'login.working' : 'login.submit')}}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <chat v-else :ownCharacters="characters" :defaultCharacter="defaultCharacter" ref="chat"></chat>
        <settings-view ref="settingsView"></settings-view>
        <app-exporter-dialog ref="appExporterDialog"></app-exporter-dialog>
        <device-sync-dialog ref="deviceSyncDialog"></device-sync-dialog>
        <modal :buttons="false" ref="profileViewer" dialogClass="profile-viewer">
            <character-page :authenticated="true" :oldApi="true" :name="profileName"></character-page>
            <template slot="title">{{profileName}} <a class="btn" @click="openProfileInBrowser"><i class="fa fa-external-link-alt"></i></a>
            </template>
        </modal>
    </div>
</template>

<script lang="ts">
    import Vue from 'vue';
    import Chat from '../chat/Chat.vue';
    import core from '../chat/core';
    import l, {setLanguage} from '../chat/localize';
    import Socket from '../chat/WebSocket';
    import Modal from '../components/Modal.vue';
    import {SimpleCharacter} from '../interfaces';
    import CharacterPage from '../site/character_page/character_page.vue';
    import {appVersion, GeneralSettings, getGeneralSettings, setGeneralSettings, SettingsStore} from './filesystem';
    import {fetchApiTicket, ticketProvider} from './api-ticket';
    import SettingsView from '../chat/SettingsView.vue';
    import {EventBus, OpenSettingsMenuEvent} from '../chat/preview/event-bus';
    import {GeneralSettings as DesktopGeneralSettings} from '../electron/common';
    import AppExporterDialog from './AppExporterDialog.vue';
    import DeviceSyncDialog from './DeviceSyncDialog.vue';
    import UpdateBanner from './UpdateBanner.vue';
    import { notifyConfigJSON, pushNotifyConfig } from './notifyConfig';

    declare global {
        interface Window {
            NativeView: {
                setTheme(theme: string): void
            } | undefined;
        }

        const NativeBackground: {
            start(): void
            stop(): void
        };
    }

    export default Vue.extend({
        components: {chat: Chat, modal: Modal, characterPage: CharacterPage, 'settings-view': SettingsView, 'app-exporter-dialog': AppExporterDialog, 'device-sync-dialog': DeviceSyncDialog, 'update-banner': UpdateBanner},
        data() {
            return {
                showAdvanced: false,
                saveLogin: false,
                loggingIn: false,
                characters: undefined as ReadonlyArray<SimpleCharacter> | undefined,
                error: '',
                defaultCharacter: undefined as number | undefined,
                settingsStore: new SettingsStore(),
                l,
                settings: undefined as GeneralSettings | undefined,
                profileName: '',
                backButtonHandler: null as ((e: Event) => void) | null,
                availableThemes: [] as ReadonlyArray<string>,
                connected: false,
            };
        },
        async mounted(): Promise<void> {
            // In the mobile build target, theme names are exposed through the window object (rather than read from the .asar file like in the Electron build).
            this.availableThemes = (window as any).__availableThemes || [];
        },
        computed: {
            // Mirrors electron/Index.vue getActiveThemeName: a character's own theme (settings menu,
            // Appearance > Layout) wins while that character is connected.
            activeTheme(): string {
                const self = this as any;
                let characterTheme: string | undefined;
                try {
                    characterTheme = self.connected ? core.state.settings.risingCharacterTheme : undefined;
                } catch {
                    characterTheme = undefined; // settings not loaded (core init failed)
                }
                return characterTheme !== undefined && self.availableThemes.indexOf(characterTheme) !== -1
                    ? characterTheme : self.settings.theme;
            },
            styling(): string {
                const theme = (this as any).activeTheme;
                if(window.NativeView !== undefined) window.NativeView.setTheme(theme);
                //tslint:disable-next-line:no-require-imports
                return `<style id="themeStyle">${require('../scss/fa.scss')}${require(`../scss/themes/chat/${theme}.scss`)}</style>`;
            },
            // Since Horizon 2.5 the accessibility and text colour options are app settings applied as
            // classes on the page root (electron/Index.vue getThemeClass) rather than by ChatView, so the
            // mobile root has to carry them too or colourblind mode and the rest silently stop working.
            themeClass(): Record<string, boolean> {
                const settings = (this as any).settings;
                const colorblind = settings.horizonColorblindMode;
                const colorblindActive = typeof colorblind === 'string' && colorblind !== 'none';
                return {
                    colorblindMode: colorblindActive,
                    ...(colorblindActive ? {[`colorblind-${colorblind}`]: true} : {}),
                    vanillaTextColors: !!settings.horizonVanillaTextColors,
                    vanillaGenderColors: !!settings.horizonVanillaGenderColors,
                    'force-reduced-motion': !!settings.reducedMotion,
                    horizonHighContrast: !!settings.horizonHighContrast,
                    bbcodeGlow: !!settings.horizonBbcodeGlow,
                };
            },
        },
        methods: {
            openSettingsMenu(data: OpenSettingsMenuEvent): void {
                (<InstanceType<typeof SettingsView>>this.$refs['settingsView']).open(data.mode);
            },
            resetHost(): void {
                (this as any).settings.host = new GeneralSettings().host;
            },
            async login(): Promise<void> {
                const self = this as any;
                if(self.loggingIn) return;
                self.loggingIn = true;
                try {
                    const data = await fetchApiTicket(self.settings.account, self.settings.password);
                    if(data.error !== '') {
                        self.error = data.error;
                        return;
                    }
                    if(self.saveLogin) await setGeneralSettings(self.settings);
                    Socket.host = self.settings.host;
                    core.connection.setCredentials(self.settings.account, ticketProvider(self.settings.account, self.settings.password));
                    core.connection.onEvent('connected', () => {
                        self.connected = true;
                        // ChatView's settings button asks for the menu over the EventBus, which Chat.vue
                        // clears on every disconnect, so (re)register on each connect like electron/Index.vue.
                        EventBus.$on('open-settings-menu', self.openSettingsMenu);
                        self.backButtonHandler = (e: Event) => {
                            const chatView = (self.$refs['chat'] as any)?.$refs?.['chatview'] as any;
                            if (chatView) {
                                if (chatView.activeMenuType !== 'none') {
                                    chatView.$refs['userMenu']?.close();
                                    chatView.$refs['channelMenu']?.close();
                                    return;
                                }
                                const sidebar = chatView.$refs['sidebar'] as any;
                                if (sidebar?.expanded) {
                                    sidebar.expanded = false;
                                    return;
                                }
                            }
                            if (!confirm(l('chat.confirmLeave'))) e.preventDefault();
                        };
                        document.addEventListener('backbutton', self.backButtonHandler);
                        NativeBackground.start();
                    });
                    core.connection.onEvent('closed', () => {
                        self.connected = false;
                        document.removeEventListener('backbutton', self.backButtonHandler!);
                        NativeBackground.stop();
                    });
                    self.characters = Object.keys(data.characters).map((name) => ({name, id: data.characters[name], deleted: false}))
                        .sort((x: SimpleCharacter, y: SimpleCharacter) => x.name.localeCompare(y.name));
                    self.defaultCharacter = data.default_character;
                } catch(e) {
                    self.error = l('login.error');
                    if(process.env.NODE_ENV !== 'production') throw e;
                } finally {
                    self.loggingIn = false;
                }
            },
            openProfileInBrowser(): void {
                window.location.href = `profile://${(this as any).profileName.replace(/ /g, '%20')}`;
            },
        },
        async created(): Promise<void> {
            document.addEventListener('open-profile', (e: Event) => {
                const profileViewer = <Modal>this.$refs['profileViewer'];
                this.profileName = (<Event & {detail: string}>e).detail;
                profileViewer.show();
            });
            let settings = await getGeneralSettings();
            if(settings === undefined) settings = new GeneralSettings();
            if(settings.version !== appVersion) {
                settings.version = appVersion;
                await setGeneralSettings(settings);
            }
            if(settings.account.length > 0) this.saveLogin = true;
            // The shared settings menu reads and writes the full desktop set of app settings, but mobile's
            // GeneralSettings only declares a handful. Fill in the rest with the desktop defaults (and heal
            // nulls a partial file can carry) before the object becomes reactive, so every field exists and
            // is tracked. Unknown keys persist through _.merge in getGeneralSettings.
            const defaults = <Record<string, unknown>>(<unknown>new DesktopGeneralSettings());
            const loaded = <Record<string, unknown>>(<unknown>settings);
            for(const key of Object.keys(defaults))
                if(!(key in loaded) || loaded[key] == null) loaded[key] = defaults[key];
            this.settings = settings;
            // Apply the saved UI language on startup (mirrors electron/chat.ts).
            // Mobile's minimal GeneralSettings doesn't declare displayLanguage, but
            // it survives persistence via _.merge, so read it dynamically.
            setLanguage((settings as any).displayLanguage);
            (core.state as any).generalSettings = settings;
            (window as any).__generalSettings = settings;
            (window as any).__setGeneralSettings = setGeneralSettings;
            // Document events, not EventBus: Chat.vue calls EventBus.clear() on every disconnect,
            // which would silently drop these app-lifetime listeners after the first logout.
            document.addEventListener('open-mobile-exporter', () => {
                (<any>this.$refs['appExporterDialog']).show();
            });
            document.addEventListener('open-mobile-device-sync', () => {
                (<any>this.$refs['deviceSyncDialog']).show();
            });
            // iOS: keep the native background-notify config (chat.ts pushes it on connect) current as
            // channels are joined/left and notification settings change. Watching the serialized config
            // re-fires only on a real change; debounce coalesces bursts (e.g. joining many channels).
            if((window as any).NativeSocket !== undefined) { //tslint:disable-line:no-any
                let timer: number | undefined;
                this.$watch(() => notifyConfigJSON(), (json: string) => {
                    if(timer !== undefined) clearTimeout(timer);
                    timer = window.setTimeout(() => pushNotifyConfig(json), 250);
                });
            }
        },
    });
</script>

<style>
    html, body, #page {
        height: 100%;
    }

    #page {
        --page-pad: 10px;
    }

    /*
     * The sidebar drawers sit inside #page's padding (and, on iOS, inside the safe-area padding on html),
     * but their backdrop is a full-screen .modal-backdrop, so an open drawer had a darkened gutter on its
     * outer, top and bottom edges. Invisible on dark themes, obvious on light ones like peached. Stretch
     * the open drawer over that padding and pad it back by the same amount, so it meets the screen edges
     * while its contents and the expander button stay where they were.
     */
    .sidebar-wrapper.open .sidebar {
        top: calc(-1 * (var(--page-pad) + env(safe-area-inset-top, 0px)));
        bottom: calc(-1 * (var(--page-pad) + env(safe-area-inset-bottom, 0px)));
        padding-top: calc(var(--page-pad) + env(safe-area-inset-top, 0px));
        /* .sidebar already has 10px of bottom padding (scss/_chat.scss). */
        padding-bottom: calc(10px + var(--page-pad) + env(safe-area-inset-bottom, 0px));
    }

    .sidebar-wrapper.open .sidebar-left {
        left: calc(-1 * (var(--page-pad) + env(safe-area-inset-left, 0px)));
        padding-left: calc(var(--page-pad) + env(safe-area-inset-left, 0px));
    }

    .sidebar-wrapper.open .sidebar-right {
        right: calc(-1 * (var(--page-pad) + env(safe-area-inset-right, 0px)));
        padding-right: calc(var(--page-pad) + env(safe-area-inset-right, 0px));
    }

    html, .modal {
       padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }

    /*
     * Issue 10: long-pressing a link, eicon or avatar makes the app unusable until restart.
     * On touch the WebView starts its native long-press interaction (the text-selection/callout
     * ActionMode, or a native drag of the link/image). That stuck native gesture swallows
     * subsequent touches, so tapping anything (e.g. switching tabs) does nothing. This file is
     * mobile-only, so suppress those long-press affordances on the interactive chat elements. Taps
     * still navigate; plain message text stays selectable.
     */
    .bbcode a,
    .bbcode img,
    .user-link,
    .character-link,
    .character-avatar,
    img.eicon {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        user-select: none;
        -webkit-user-drag: none;
    }
</style>
