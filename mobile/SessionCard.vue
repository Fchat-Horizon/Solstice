<template>
    <div class="session-card">
        <span class="session-card-label">Switch to</span>
        <button v-for="s in others" :key="s.id" type="button" class="session-card-av" :aria-label="s.character || 'New character'"
            @click="pick(s.id)">
            <img v-if="s.character" :src="avatar(s.character)" alt=""/>
            <span v-else class="session-avatar-empty"><span class="fas fa-user"></span></span>
            <span v-if="s.unread" class="session-badge">{{s.unread}}</span>
        </button>
        <button v-if="canAdd" type="button" class="session-card-add" aria-label="Add a character" @click="add()">
            <span class="fas fa-plus"></span>
        </button>
    </div>
</template>

<script lang="ts">
    import Vue from 'vue';
    import {characterImage} from '../chat/common';
    import {addSession, canAddSession, otherSessions, SessionInfo, sessions, switchTo} from './sessions';

    // Switcher prototype B: the other signed-in characters, under your own in the left drawer.
    export default Vue.extend({
        data() {
            return {sessions};
        },
        computed: {
            others(): SessionInfo[] {
                return (this as any).sessions.list.length >= 0 ? otherSessions() : [];
            },
            canAdd(): boolean {
                return (this as any).sessions.list.length >= 0 && canAddSession();
            },
        },
        methods: {
            avatar(name: string): string {
                return characterImage(name);
            },
            closeDrawer(): void {
                const wrapper = <(Element & {__vue__?: {expanded: boolean}}) | null>this.$el.closest('.sidebar-wrapper');
                if(wrapper !== null && wrapper.__vue__ !== undefined) wrapper.__vue__.expanded = false;
            },
            pick(id: number): void {
                this.closeDrawer();
                switchTo(id);
            },
            add(): void {
                this.closeDrawer();
                addSession();
            },
        },
    });
</script>
