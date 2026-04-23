<template><span></span></template>

<script lang="ts">
  import Vue from 'vue';
  import SettingsVue from '../electron/Settings.vue';

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
          new SettingsVue({
            el,
            data: { settings: (window as any).__generalSettings },
          });
        } else {
          this.container.style.display = '';
        }
        window.addEventListener('settings-window-close', this.hide as EventListener, { once: true });
      },
      hide(): void {
        if (this.container) this.container.style.display = 'none';
      },
    },
    beforeDestroy(): void {
      if (this.container) document.body.removeChild(this.container);
    },
  });
</script>
