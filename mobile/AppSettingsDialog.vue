<template><span></span></template>

<script lang="ts">
  import Vue from 'vue';
  import SettingsVue from '../electron/Settings.vue';
  import { GeneralSettings as DesktopGeneralSettings } from '../electron/common';

  export default Vue.extend({
    data() {
      return { container: null as HTMLElement | null };
    },
    methods: {
      show(): void {
        if (!this.container) {
          // Mount outside any Vue-managed DOM to avoid virtual-DOM conflicts
          const el = document.createElement('div');
          el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:1050;overflow:auto';
          document.body.appendChild(el);
          this.container = el;
          try {
            // Mount into a child node, not `el` itself: Vue replaces its mount
            // element with the component's root, which would leave `this.container`
            // detached and make hide() (display:none) target an orphan — the window
            // would then be impossible to close. Keeping the container as a stable
            // wrapper lets hide()/show() toggle visibility reliably.
            const mountPoint = document.createElement('div');
            el.appendChild(mountPoint);
            // The desktop Settings.vue reads ~60 settings fields, but mobile's
            // GeneralSettings only defines a handful. Backfill any missing fields
            // with their desktop defaults so the window can render — otherwise an
            // undefined field (e.g. soundTheme) throws during mount and the dialog
            // silently fails to open. Mutate in place to keep the shared reference
            // (and persistence) intact. `|| {}` guards a nullish global so the
            // `in` check below can't throw.
            const settings = (window as any).__generalSettings || {};
            const defaults = new DesktopGeneralSettings() as Record<string, unknown>;
            for (const key of Object.keys(defaults)) {
              // Vue.set, not plain assignment: __generalSettings is already a
              // reactive object, so added keys must be registered reactively —
              // otherwise Settings.vue's watchers (e.g. displayLanguage → setLanguage)
              // never fire and changes like the UI language silently don't apply.
              // Also heal present-but-null fields: a stale/partial !settings (e.g.
              // on a MIUI app-clone with its own data dir) can carry a null where
              // Settings.vue expects a real value, which throws during render.
              if (!(key in settings) || settings[key] == null) Vue.set(settings, key, defaults[key]);
            }
            // parent: this so render/lifecycle errors in Settings.vue propagate to
            // this component's errorCaptured() — a standalone root instance would
            // otherwise swallow them, leaving a blank overlay that looks like the
            // window "disappeared".
            new SettingsVue({ el: mountPoint, parent: this, data: { settings } });
          } catch (e) {
            this.fail(e);
            return;
          }
        } else {
          this.container.style.display = '';
        }
        window.addEventListener('settings-window-close', this.hide as EventListener, { once: true });
      },
      hide(): void {
        if (this.container) this.container.style.display = 'none';
      },
      // Tear down the overlay and surface the error instead of leaving an invisible
      // container that swallows taps and looks like a vanished window.
      fail(e: unknown): void {
        console.error('App settings failed to open', e);
        if (this.container) {
          document.body.removeChild(this.container);
          this.container = null;
        }
        const message = e instanceof Error ? e.message : String(e);
        alert(`Couldn't open settings: ${message}`);
      },
    },
    errorCaptured(e: Error): boolean {
      this.fail(e);
      return false;
    },
    beforeDestroy(): void {
      if (this.container) document.body.removeChild(this.container);
    },
  });
</script>
