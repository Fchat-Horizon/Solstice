<template>
  <div class="list-group bg-solid-text context-menu shadow-sm">
    <slot></slot>
    <a
      v-for="(item, index) in menuItems"
      :key="index"
      href="#"
      tabindex="-1"
      class="list-group-item list-group-item-action"
      :class="{
        disabled: item.disabled,
        'list-group-item-danger': item.dangerous,
        'parent-menu-item': item.children && item.children.length > 0
      }"
      :style="item.topBorder ? { borderTopWidth: '1px' } : undefined"
      @mouseenter="item.children?.length ? positionChild($event) : undefined"
      @click.prevent="onItemClick(item, index)"
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

  export interface ContextMenuItemProps {
    label: string;
    disabled?: boolean;
    onClick?: () => void;
    iconClass?: string;
    children?: ContextMenuItemProps[];
    topBorder?: boolean;
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
      onItemClick(item: ContextMenuItemProps, index: number): void {
        if (item.disabled) return;
        if (this.isMobilePlatform && item.children?.length) {
          this.activeChildIndex =
            this.activeChildIndex === index ? null : index;
          return;
        }
        item.onClick?.();
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
