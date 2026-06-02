<template>
  <div v-if="updateUrl" class="solstice-update-banner">
    <span class="banner-text">
      New version <strong>{{ latestVersion }}</strong> available
    </span>
    <a class="btn btn-sm btn-primary" @click.prevent="open">Download</a>
    <a
      class="btn btn-sm dismiss"
      aria-label="Dismiss"
      @click.prevent="updateUrl = ''"
    >
      <span class="fas fa-times"></span>
    </a>
  </div>
</template>

<script lang="ts">
  import Vue from 'vue';
  import { appVersion } from './filesystem';

  // Solstice releases (incl. prereleases) live on the org repo. We hit /releases
  // rather than /releases/latest because the latter skips prereleases (betas/devs).
  const RELEASES_API =
    'https://api.github.com/repos/Fchat-Horizon/Solstice/releases?per_page=15';

  // Minimal semver-ish "is `latest` newer than `current`?", supporting X.Y.Z and
  // X.Y.Z-pre.N (e.g. 2.2.0-beta.3). A stable release outranks a prerelease of the
  // same core version. Avoids pulling in a semver dependency.
  function isNewer(latest: string, current: string): boolean {
    const parse = (v: string) => {
      const [core, pre = ''] = v.split('-');
      return {
        nums: core.split('.').map(n => parseInt(n, 10) || 0),
        pre: pre ? pre.split('.') : []
      };
    };
    const a = parse(latest);
    const b = parse(current);
    for (let i = 0; i < 3; i++) {
      const x = a.nums[i] || 0;
      const y = b.nums[i] || 0;
      if (x !== y) return x > y;
    }
    if (a.pre.length === 0 && b.pre.length === 0) return false;
    if (a.pre.length === 0) return true; // stable > prerelease
    if (b.pre.length === 0) return false; // prerelease < stable
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
      const ai = a.pre[i];
      const bi = b.pre[i];
      if (ai === undefined) return false;
      if (bi === undefined) return true;
      if (/^\d+$/.test(ai) && /^\d+$/.test(bi)) {
        const an = parseInt(ai, 10);
        const bn = parseInt(bi, 10);
        if (an !== bn) return an > bn;
      } else if (ai !== bi) {
        return ai > bi;
      }
    }
    return false;
  }

  export default Vue.extend({
    data() {
      return { latestVersion: '', updateUrl: '' };
    },
    async mounted(): Promise<void> {
      try {
        // Stable-only by default; include prereleases only if the user opted in.
        const settings = (window as any).__generalSettings;
        const includePrereleases = !!(settings && settings.updateCheckPrereleases);

        const res = await fetch(RELEASES_API, {
          headers: { Accept: 'application/vnd.github+json' }
        });
        if (!res.ok) return;
        const releases = await res.json();
        if (!Array.isArray(releases)) return;

        // Releases come back newest-first; take the first matching the channel.
        const latest = releases.find(
          (r: any) => !r.draft && (includePrereleases || !r.prerelease)
        );
        if (!latest) return;

        const tag = String(latest.tag_name || '').replace(/^v/, '');
        if (tag && isNewer(tag, appVersion)) {
          this.latestVersion = latest.tag_name;
          this.updateUrl = latest.html_url;
        }
      } catch (e) {
        // Offline or API error — silently skip; the banner just won't show.
      }
    },
    methods: {
      open(): void {
        if (this.updateUrl) window.open(this.updateUrl);
      }
    }
  });
</script>

<style scoped>
  .solstice-update-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2000;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: calc(env(safe-area-inset-top) + 6px) 10px 6px 10px;
    background: #1f2233;
    color: #fff;
    font-size: 0.9rem;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }

  .solstice-update-banner .banner-text {
    flex: 1;
  }

  .solstice-update-banner .dismiss {
    color: #ccc;
  }
</style>
