<template>
    <div id="page" style="position: relative; padding: 10px;" v-if="settings">
        <div v-html="styling"></div>
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
                            <option>default</option>
                            <option>dark</option>
                            <option>light</option>
                        </select>
                    </div>
                    <div class="mb-3">
                        <label for="advanced"><input type="checkbox" id="advanced" v-model="showAdvanced"/> {{l('login.advanced')}}</label>
                    </div>
                    <div class="mb-3">
                        <label for="save"><input type="checkbox" id="save" v-model="saveLogin"/> {{l('login.save')}}</label>
                    </div>
                    <div class="mb-3" style="text-align:right">
                        <button class="btn btn-primary" @click="login()" :disabled="loggingIn">
                            {{l(loggingIn ? 'login.working' : 'login.submit')}}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <chat v-else :ownCharacters="characters" :defaultCharacter="defaultCharacter" ref="chat"></chat>
        <app-settings-dialog ref="appSettingsDialog"></app-settings-dialog>
        <app-exporter-dialog ref="appExporterDialog"></app-exporter-dialog>
        <modal :buttons="false" ref="profileViewer" dialogClass="profile-viewer">
            <character-page :authenticated="true" :oldApi="true" :name="profileName"></character-page>
            <template slot="title">{{profileName}} <a class="btn" @click="openProfileInBrowser"><i class="fa fa-external-link-alt"></i></a>
            </template>
        </modal>
    </div>
</template>

<script lang="ts">
    import Axios from 'axios';
    import * as qs from 'qs';
    import Vue from 'vue';
    import Chat from '../chat/Chat.vue';
    import core from '../chat/core';
    import l from '../chat/localize';
    import Socket from '../chat/WebSocket';
    import Modal from '../components/Modal.vue';
    import {SimpleCharacter} from '../interfaces';
    import CharacterPage from '../site/character_page/character_page.vue';
    import {appVersion, GeneralSettings, getGeneralSettings, setGeneralSettings, SettingsStore} from './filesystem';
    import AppSettingsDialog from './AppSettingsDialog.vue';
    import AppExporterDialog from './AppExporterDialog.vue';
    import { EventBus } from '../chat/preview/event-bus';

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
        components: {chat: Chat, modal: Modal, characterPage: CharacterPage, 'app-settings-dialog': AppSettingsDialog, 'app-exporter-dialog': AppExporterDialog},
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
            };
        },
        computed: {
            styling(): string {
                if(window.NativeView !== undefined) window.NativeView.setTheme((this as any).settings.theme);
                //tslint:disable-next-line:no-require-imports
                return `<style id="themeStyle">${require('../scss/fa.scss')}${require(`../scss/themes/chat/${(this as any).settings.theme}.scss`)}</style>`;
            },
        },
        methods: {
            resetHost(): void {
                (this as any).settings.host = new GeneralSettings().host;
            },
            async login(): Promise<void> {
                const self = this as any;
                if(self.loggingIn) return;
                self.loggingIn = true;
                try {
                    const data = <{ticket?: string, error: string, characters: {[key: string]: number}, default_character: number}>
                        (await Axios.post('https://www.f-list.net/json/getApiTicket.php', qs.stringify({
                            account: self.settings.account, password: self.settings.password, no_friends: true, no_bookmarks: true,
                            new_character_list: true
                        }))).data;
                    if(data.error !== '') {
                        self.error = data.error;
                        return;
                    }
                    if(self.saveLogin) await setGeneralSettings(self.settings);
                    Socket.host = self.settings.host;
                    core.connection.setCredentials(self.settings.account, self.settings.password);
                    core.connection.onEvent('connected', () => {
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
            this.settings = settings;
            (core.state as any).generalSettings = settings;
            (window as any).__generalSettings = settings;
            (window as any).__setGeneralSettings = setGeneralSettings;
            EventBus.$on('open-mobile-app-settings', () => {
                (<any>this.$refs['appSettingsDialog']).show();
            });
            EventBus.$on('open-mobile-exporter', () => {
                (<any>this.$refs['appExporterDialog']).show();
            });
        },
    });
</script>

<style>
    html, body, #page {
        height: 100%;
    }

    html, .modal {
       padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
</style>
