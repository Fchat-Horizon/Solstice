<template>
    <div id="page" style="position: relative; padding: var(--page-pad);" :class="[themeClass, sessionClass]" :style="sessionStyle" v-if="settings">
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
        <div v-else class="session-host">
            <!-- Switcher prototype A: a tab per signed-in character, like the desktop window's tab bar. -->
            <div v-if="switcherDesign === 'tabs' && sessionsEnabled" class="session-strip">
                <button v-for="s in sessions.list" :key="s.id" type="button" class="session-tab" :class="{active: s.id === sessions.self}"
                    @click="switchTo(s.id)" :aria-label="s.character || 'New character'">
                    <img v-if="s.character" :src="avatar(s.character)" class="session-avatar" alt=""/>
                    <span v-else class="session-avatar session-avatar-empty"><span class="fas fa-user"></span></span>
                    <span v-if="s.id === sessions.self" class="session-name">{{s.character || 'Choose a character'}}</span>
                    <span v-if="s.id !== sessions.self && s.unread" class="session-badge">{{s.unread}}</span>
                    <span v-if="s.id === sessions.self && sessions.list.length > 1" class="session-close fas fa-times" role="button"
                        aria-label="Log out this character" @click.stop="closeSession(s.id)"></span>
                </button>
                <button v-if="canAddSession()" type="button" class="session-add" aria-label="Add a character" @click="addSession()">
                    <span class="fas fa-plus"></span>
                </button>
            </div>
            <chat :ownCharacters="availableCharacters" :defaultCharacter="defaultCharacter" ref="chat"></chat>
        </div>
        <!-- Switcher prototype C: the avatar in the chat box opens this sheet. -->
        <template v-if="sheetOpen">
            <div class="session-scrim" @click="sheetOpen = false"></div>
            <div class="session-sheet" role="dialog" aria-label="Talking as">
                <div class="session-grab"></div>
                <h5 class="session-sheet-title">Talking as</h5>
                <div v-for="s in sessions.list" :key="s.id" class="session-row" :class="{active: s.id === sessions.self}" role="button" @click="pickSession(s.id)">
                    <img v-if="s.character" :src="avatar(s.character)" class="session-avatar lg" alt=""/>
                    <span v-else class="session-avatar lg session-avatar-empty"><span class="fas fa-user"></span></span>
                    <div class="session-row-text">
                        <b>{{s.character || 'Choosing a character'}}</b>
                        <span class="session-meta"><i class="session-status" :class="'status-' + (s.status || 'offline')"></i>{{sessionSummary(s)}}</span>
                    </div>
                    <span v-if="s.id === sessions.self" class="fas fa-check session-check"></span>
                    <span v-else-if="s.unread" class="session-pill">{{s.unread}}</span>
                    <span v-if="s.id !== sessions.self" class="fas fa-times session-row-close" role="button" aria-label="Log out"
                        @click.stop="closeSession(s.id)"></span>
                </div>
                <div v-if="canAddSession()" class="session-row add" role="button" @click="sheetOpen = false; addSession()">
                    <span class="session-avatar lg session-avatar-empty"><span class="fas fa-plus"></span></span>
                    <div class="session-row-text"><b>Log in another character</b><span class="session-meta">{{sessions.list.length}} of {{sessions.max}} signed in</span></div>
                </div>
                <div v-else class="session-note">{{sessions.max}} of {{sessions.max}} signed in. Log one out to add another.</div>
            </div>
        </template>
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
    import {characterImage} from '../chat/common';
    import {Conversation} from '../chat/interfaces';
    import {
        addSession, canAddSession, charactersInUse, closeSession, isSpawnedSession, otherUnread, report, SessionInfo, sessions,
        sessionsEnabled, shareCredentials, sharedCredentials, switchTo, switcherDesign
    } from './sessions';

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
                sessions,
                sessionsEnabled,
                switcherDesign,
                sheetOpen: false,
            };
        },
        async mounted(): Promise<void> {
            // In the mobile build target, theme names are exposed through the window object (rather than read from the .asar file like in the Electron build).
            this.availableThemes = (window as any).__availableThemes || [];
        },
        computed: {
            // Characters another session already has signed in are left out of this one's list.
            availableCharacters(): ReadonlyArray<SimpleCharacter> | undefined {
                const self = this as any;
                if(self.characters === undefined) return undefined;
                const inUse = charactersInUse();
                return inUse.length === 0 ? self.characters : self.characters.filter((c: SimpleCharacter) => inUse.indexOf(c.name) === -1);
            },
            sessionClass(): Record<string, boolean> {
                return {
                    [`switcher-${switcherDesign}`]: sessionsEnabled,
                    'other-unread': sessionsEnabled && otherUnread() > 0,
                };
            },
            // The unread count for the other characters, for the CSS badges in designs B and C.
            sessionStyle(): Record<string, string> {
                return sessionsEnabled ? {'--other-unread': `"${otherUnread()}"`} : {};
            },
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
            avatar(name: string): string {
                return characterImage(name);
            },
            switchTo, addSession, canAddSession,
            closeSession(id: number): void {
                // Closing this page's own character: disconnect cleanly first, then let the host drop the page.
                if(id === sessions.self && core.connection.isOpen) core.connection.close();
                closeSession(id);
            },
            pickSession(id: number): void {
                (this as any).sheetOpen = false;
                switchTo(id);
            },
            sessionSummary(s: SessionInfo): string {
                const status = s.status !== undefined ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : 'Not connected';
                if(s.id === sessions.self) return status;
                const parts = [status];
                if(s.pmFrom !== undefined && s.pmFrom.length > 0)
                    parts.push(s.pmFrom.length === 1 ? `PMs from ${s.pmFrom[0]}` : `PMs from ${s.pmFrom.length} people`);
                if(s.mentions !== undefined && s.mentions.length > 0)
                    parts.push(s.mentions.length === 1 ? `mentioned in ${s.mentions[0]}` : `mentioned in ${s.mentions.length} channels`);
                return parts.join(' \u00b7 ');
            },
            // What the other sessions show about this one: who it is, and what is waiting for it.
            sessionReport(): Omit<SessionInfo, 'id'> {
                const self = this as any;
                if(!self.connected) return {connected: false};
                const conversations = core.conversations;
                return {
                    character: core.connection.character,
                    connected: true,
                    status: core.characters.ownCharacter.status,
                    unread: conversations.newCount,
                    pmFrom: conversations.privateConversations.filter((c) => c.unreadCount > 0).map((c) => c.character.name),
                    mentions: conversations.channelConversations.filter((c) => c.unread === Conversation.UnreadState.Mention).map((c) => c.name),
                };
            },
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
                    shareCredentials(self.settings.account, self.settings.password);
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
                window.location.href = `profile://${(this as any).profileName}`;
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
            if(sessionsEnabled) {
                this.$watch(() => (this as any).sessionReport(), (info: Omit<SessionInfo, 'id'>) => report(info), {immediate: true, deep: true});
                // A page the user cannot see behaves like a blurred window, so its messages count as unread
                // and the conversation it had open is marked read again when it comes back.
                this.$watch(() => sessions.active === sessions.self, (visible: boolean) => {
                    window.dispatchEvent(new Event(visible ? 'focus' : 'blur'));
                    (this as any).sheetOpen = false;
                });
                // Design C: the avatar in the chat box toolbar opens the sheet.
                if(switcherDesign === 'sheet')
                    document.addEventListener('click', (e: Event) => {
                        const target = <Element | null>e.target;
                        if(target === null || target.closest('.bbcode-toolbar .character-btn') === null) return;
                        e.preventDefault();
                        e.stopPropagation();
                        // Otherwise the message box keeps focus and the keyboard comes up under the sheet.
                        const focused = <HTMLElement | null>document.activeElement;
                        if(focused !== null && typeof focused.blur === 'function') focused.blur();
                        (this as any).sheetOpen = true;
                    }, true);
                // A character added from another page logs in with the same account straight away.
                if(isSpawnedSession()) {
                    const credentials = sharedCredentials();
                    if(credentials !== undefined) {
                        settings.account = credentials.account;
                        settings.password = credentials.password;
                    }
                    if(settings.account !== '' && settings.password !== '') void this.login();
                }
            }
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
    /* ---------- Character switcher prototypes (mobile/sessions.ts) ---------- */
    .session-host {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .session-host > :last-child {
        flex: 1;
        min-height: 0;
    }

    .session-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        object-fit: cover;
        flex: none;
    }

    .session-avatar.lg {
        width: 44px;
        height: 44px;
        border-radius: 8px;
    }

    .session-avatar-empty {
        display: inline-grid;
        place-items: center;
        background: var(--bs-secondary-bg);
        color: var(--bs-secondary-color);
    }

    .session-badge {
        position: absolute;
        top: -3px;
        right: -3px;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--bs-danger);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 18px;
        text-align: center;
    }

    /* A: tab strip above the chat. */
    .session-strip {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        margin: calc(-1 * var(--page-pad)) calc(-1 * var(--page-pad)) 6px;
        padding: 6px var(--page-pad);
        background: var(--bs-tertiary-bg);
        border-bottom: 1px solid var(--bs-border-color);
        overflow-x: auto;
    }

    .session-tab {
        position: relative;
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--bs-body-color);
    }

    .session-tab.active {
        background: var(--bs-secondary-bg);
        padding-right: 8px;
    }

    .session-name {
        font-weight: 600;
        white-space: nowrap;
    }

    .session-close {
        padding: 4px 2px 4px 8px;
        opacity: .7;
    }

    .session-add {
        flex: none;
        width: 36px;
        height: 36px;
        border-radius: 10px;
        border: 1px dashed var(--bs-border-color);
        background: transparent;
        color: var(--bs-secondary-color);
    }

    /* The strip is app-level, like desktop's tab bar, so it stays bright and tappable above a drawer's backdrop. */
    .switcher-tabs .session-strip {
        position: relative;
        z-index: 20;
    }

    /* With the strip above the chat, an open drawer starts under it instead of at the screen top. */
    .switcher-tabs .sidebar-wrapper.open .sidebar {
        top: 0;
        padding-top: 0;
    }

    /* B: the "switch to" strip in the drawer, and a dot on the menu button. */
    .session-card {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 10px 8px 0;
        padding: 8px 10px;
        border-radius: 10px;
        background: var(--bs-secondary-bg);
    }

    .session-card-label {
        flex: 1;
        color: var(--bs-secondary-color);
    }

    .session-card-av {
        position: relative;
        width: 40px;
        height: 40px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
    }

    .session-card-av img,
    .session-card-av .session-avatar-empty {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        object-fit: cover;
    }

    .session-card-add {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: 1px dashed var(--bs-border-color);
        background: transparent;
        color: var(--bs-secondary-color);
    }

    /* The expander is rotated 270deg, so its bottom-right corner is the one that shows top-right. */
    .switcher-drawer.other-unread .sidebar-left .expander::after {
        content: "";
        position: absolute;
        bottom: -4px;
        right: -4px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--bs-danger);
        box-shadow: 0 0 0 2px var(--bs-body-bg);
    }

    /* C: the avatar in the chat box opens a sheet; its badge counts the other characters' unread. */
    .switcher-sheet .bbcode-toolbar .character-btn {
        position: relative;
        cursor: pointer;
    }

    .switcher-sheet.other-unread .bbcode-toolbar .character-btn::after {
        content: var(--other-unread);
        position: absolute;
        /* Inside the button: the toolbar clips anything that pokes out of it. */
        top: 2px;
        right: 2px;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--bs-danger);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 18px;
        text-align: center;
        z-index: 2;
    }

    .session-scrim {
        position: fixed;
        inset: 0;
        z-index: 1060;
        background: rgba(0, 0, 0, .5);
    }

    .session-sheet {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 1061;
        background: var(--bs-body-bg);
        color: var(--bs-body-color);
        border-radius: 18px 18px 0 0;
        padding: 10px 16px calc(16px + env(safe-area-inset-bottom, 0px));
        box-shadow: 0 -8px 30px rgba(0, 0, 0, .35);
    }

    .session-grab {
        width: 44px;
        height: 5px;
        border-radius: 3px;
        background: var(--bs-border-color);
        margin: 0 auto 12px;
    }

    .session-sheet-title {
        margin: 0 0 6px;
    }

    .session-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px solid var(--bs-border-color);
        cursor: pointer;
    }

    .session-row-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .session-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--bs-secondary-color);
        font-size: .88em;
    }

    .session-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
        background: var(--bs-secondary-color);
    }

    .status-online { background: #cfd2e0; }
    .status-looking { background: #2fbf5f; }
    .status-busy { background: #e08a1e; }
    .status-away, .status-idle { background: #e6b800; }
    .status-dnd { background: #d03030; }

    .session-check {
        color: var(--bs-primary);
    }

    .session-pill {
        padding: 0 8px;
        border-radius: 10px;
        background: var(--bs-danger);
        color: #fff;
        font-size: .85em;
        font-weight: 700;
    }

    .session-row-close {
        padding: 8px;
        opacity: .6;
    }

    .session-note {
        padding-top: 10px;
        border-top: 1px solid var(--bs-border-color);
        color: var(--bs-secondary-color);
        font-size: .9em;
    }
</style>
