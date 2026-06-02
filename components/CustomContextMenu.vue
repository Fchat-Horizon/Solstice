<template>
  <div class="list-group bg-solid-text context-menu shadow-sm">
    <slot></slot>
    <a
      v-for="(item, index) in menuItems"
      :key="index"
      :href="item.href || '#'"
      target="_blank"
      tabindex="-1"
      class="list-group-item list-group-item-action"
      :class="{
        disabled: item.disabled,
        'list-group-item-danger': item.dangerous,
        'parent-menu-item': item.children && item.children.length > 0
      }"
      :style="item.topBorder ? { borderTopWidth: '1px' } : undefined"
      @mouseenter="item.children?.length ? positionChild($event) : undefined"
      @click="onItemClick(item, index, $event)"
    >
      <span v-if="item.iconClass" :class="item.iconClass" class="fa-fw"></span>
      <span class="action-label">{{ item.label }}</span>
      <span
        v-if="item.children && item.children.length > 0"
        class="fas fa-fw fa-caret-right"
        style="
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
        "
      ></span>
      <custom-context-menu
        v-if="item.children && item.children.length > 0"
        :menu-items="item.children"
        class="child-menu"
        :class="{ 'child-menu-inline': isMobilePlatform }"
        :style="
          isMobilePlatform
            ? { display: activeChildIndex === index ? 'block' : 'none' }
            : undefined
        "
      />
    </a>
  </div>
</template>

<script lang="ts">
  import Vue, { PropType } from 'vue';

  /**
   * @interface ContextMenuItemProps
   * @description Represents a single item in the context menu, which can optionally have child items for nested submenus.
   */
  export interface ContextMenuItemProps {
    /**
     * The display text for the menu item.
     */
    label: string;
    /**
     * Indicates whether the menu item is disabled. Disabled items are not interactive and are styled accordingly.
     */
    disabled?: boolean;
    /**
     * An optional URL that the menu item links to.
     */
    href?: string;
    /**
     * An optional click handler function that is called when the menu item is clicked.
     */
    onClick?: () => void;
    /**
     * An optional CSS class for an icon to be displayed alongside the menu item label. This allows for visual enhancement of the menu item.
     */
    iconClass?: string;
    /**
     * An optional array of child menu items, allowing for the creation of nested submenus. Each child item is also of type {@link ContextMenuItemProps}.
     */
    children?: ContextMenuItemProps[];
    /**
     * An optional boolean that, when true, adds a top border to the menu item. This can be used to visually separate groups of items within the menu.
     */
    topBorder?: boolean;
    /**
     * An optional boolean that, when true, styles the menu item as dangerous, typically indicating a destructive action.
     */
    dangerous?: boolean;
  }

  export default Vue.extend({
    name: 'CustomContextMenu',
    props: {
      menuItems: {
        type: Array as PropType<ContextMenuItemProps[]>,
        required: true
      }
    },
    data() {
      return {
        activeChildIndex: null as number | null
      };
    },
    computed: {
      isMobilePlatform(): boolean {
        return document.documentElement.dataset.mobilePlatform === 'true';
      }
    },
    methods: {
      onItemClick(item: ContextMenuItemProps, index: number, e: Event): void {
        if (item.disabled) {
          e.preventDefault();
          return;
        }
        // Mobile: tapping a parent item toggles its inline submenu (no hover).
        if (this.isMobilePlatform && item.children?.length) {
          e.preventDefault();
          this.activeChildIndex =
            this.activeChildIndex === index ? null : index;
          return;
        }
        if (item.onClick) {
          e.preventDefault();
          item.onClick();
          return;
        }
        if (item.href) {
          // A real link (e.g. the profile item). In the WebView, target="_blank"
          // won't open (no multi-window support), so route it through window.open
          // — which the native shell handles — and dismiss the menu. On desktop,
          // let the default <a href target="_blank"> navigation happen.
          if (this.isMobilePlatform) {
            e.preventDefault();
            window.open(item.href, '_blank');
            this.$emit('close');
          }
          return;
        }
        // No handler and no real href (just an "#" anchor): never navigate.
        e.preventDefault();
      },
      positionChild(event: MouseEvent): void {
        const item = event.currentTarget as HTMLElement;
        const child = item.querySelector<HTMLElement>(':scope > .child-menu');
        if (!child) return;

        child.style.visibility = 'hidden';
        child.style.display = 'block';
        const itemRect = item.getBoundingClientRect();
        const childW = child.offsetWidth;
        const childH = child.offsetHeight;
        child.style.visibility = '';
        child.style.display = '';

        child.style.left =
          itemRect.right + childW > window.innerWidth ? 'auto' : '100%';
        child.style.right =
          itemRect.right + childW > window.innerWidth ? '100%' : 'auto';

        const overflowBottom = itemRect.top + childH - window.innerHeight;
        child.style.top = overflowBottom > 0 ? `${-overflowBottom}px` : '0';
      }
    }
  });
</script>

<style scoped lang="scss">
  .parent-menu-item {
    position: relative;

    .child-menu {
      display: none;
      position: absolute;
      left: 100%;
      top: 0;
      z-index: 1000;
      min-width: 220px;
    }
    &:hover .child-menu:not(.child-menu-inline) {
      display: block;
    }

    // On mobile the submenu expands inline (below the parent item) instead of
    // flying out to the side, which would render off the edge of the screen.
    .child-menu-inline {
      position: static;
      left: auto;
      top: auto;
      min-width: 0;
      width: 100%;
      margin-top: 3px;
      box-shadow: none;
    }
  }
  .context-menu {
    border-radius: 15px;
    max-width: 265px;

    & .list-group-item {
      padding: 3px 5px 3px 5px;
    }

    & .list-group-item-action {
      font-size: 1.04em;
      border-top-width: 0;
      border-top-style: solid;
      border-color: var(--bs-border-color);
    }
    .action-label {
      margin-left: 0.4rem;
    }
  }
</style>
