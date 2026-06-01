<template>
  <modal
    :action="l('eicon.action')"
    ref="dialog"
    :buttons="false"
    @close="close"
    dialogClass="eicon-selector big"
    iconClass="fas fa-face-smile"
  >
    <div class="eicon-selector-ui">
      <div
        v-if="!storeLoaded || refreshing"
        class="d-flex align-items-center loading"
      >
        <strong>{{ l('common.loading') }}</strong>
        <div
          class="spinner-border ms-auto"
          role="status"
          aria-hidden="true"
        ></div>
      </div>
      <div v-else>
        <div>
          <div class="search-bar">
            <input
              type="text"
              class="form-control search"
              id="search"
              v-model="search"
              ref="search"
              :placeholder="l('eicon.searchPlaceholder')"
              @input="searchUpdateDebounce()"
              tabindex="0"
              @click.prevent.stop="setFocus()"
              @mousedown.prevent.stop
              @mouseup.prevent.stop
            />
            <div class="btn-group search-buttons">
              <div
                class="btn btn-light favorites"
                @click.prevent.stop="searchWithString('category:favorites')"
                :class="{ active: search === 'category:favorites' }"
                :title="l('eicon.category.favorites')"
                role="button"
                tabindex="0"
              >
                <i class="fas fa-thumbtack"></i>
              </div>

              <div
                class="btn btn-light recent"
                @click.prevent.stop="searchWithString('category:recent')"
                :class="{ active: search === 'category:recent' }"
                :title="l('eicon.category.recent')"
                role="button"
                tabindex="0"
              >
                <i class="fas fa-history"></i>
              </div>

              <div
                class="btn btn-light refresh"
                @click.prevent.stop="refreshIcons()"
                :title="l('eicon.refresh')"
                role="button"
                tabindex="0"
              >
                <i class="fas fa-sync"></i>
              </div>
            </div>
          </div>

          <div class="courtesy">
            {{ l('eicon.courtesy') }}
            <a href="https://xariah.net/eicons">xariah.net</a>
          </div>

          <div class="upload">
            <a href="https://www.f-list.net/icons.php">{{
              l('eicon.upload')
            }}</a>
          </div>
        </div>

        <div class="carousel slide w-100 results">
          <draggable
            v-if="search === 'category:favorites'"
            v-model="allResults"
            class="carousel-inner w-100 hidden-scrollbar"
            role="listbox"
            :animation="150"
            @end="saveFavoritesOrder"
          >
            <div
              class="carousel-item"
              v-for="eicon in allResults"
              :key="eicon"
              role="img"
              :aria-label="eicon"
              tabindex="0"
            >
              <img
                class="eicon"
                :alt="eicon"
                :src="
                  'https://static.f-list.net/images/eicon/' + eicon + '.gif'
                "
                :title="eicon"
                role="button"
                :aria-label="eicon"
                @click.prevent.stop="selectIcon(eicon, $event)"
              />

              <div
                class="btn favorite-toggle"
                :class="{ favorited: isFavorite(eicon) }"
                @click.prevent.stop="toggleFavorite(eicon)"
                role="button"
                :aria-label="
                  isFavorite(eicon)
                    ? l('eicon.removeFromFavorites')
                    : l('eicon.addToFavorites')
                "
              >
                <i class="fas fa-thumbtack"></i>
              </div>
            </div>
          </draggable>

          <div
            v-else
            class="carousel-inner w-100 hidden-scrollbar"
            role="listbox"
            ref="resultsContainer"
          >
            <div
              class="carousel-item"
              v-for="eicon in results"
              :key="eicon"
              role="img"
              :aria-label="eicon"
              tabindex="0"
            >
              <div
                class="btn recent-delete"
                @click.prevent.stop="deleteRecent(eicon)"
                role="button"
                :aria-label="l('eicon.deleteRecent')"
                v-if="search === 'category:recent'"
              >
                <i class="fas fa-times"></i>
              </div>

              <img
                class="eicon"
                :alt="eicon"
                :src="
                  'https://static.f-list.net/images/eicon/' + eicon + '.gif'
                "
                :title="eicon"
                role="button"
                :aria-label="eicon"
                @click.prevent.stop="selectIcon(eicon, $event)"
              />

              <div
                class="btn favorite-toggle"
                :class="{ favorited: isFavorite(eicon) }"
                @click.prevent.stop="toggleFavorite(eicon)"
                role="button"
                :aria-label="
                  isFavorite(eicon)
                    ? l('eicon.removeFromFavorites')
                    : l('eicon.addToFavorites')
                "
              >
                <i class="fas fa-thumbtack"></i>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </modal>
</template>

<script lang="ts">
  import draggable from 'vuedraggable';
  import { EIconStore } from '../learn/eicon/store';
  import core from '../chat/core';
  import modal from '../components/Modal.vue';
  import CustomDialog from '../components/custom_dialog';
  import l from '../chat/localize';
  import { EventBus } from '../chat/preview/event-bus';

  function debounce<T>(
    func: (this: T, ...args: any) => void,
    wait: number = 330
  ): () => void {
    let timer: ReturnType<typeof setTimeout>;
    return function (this: T, ...args: any) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        func.apply(this, args);
      }, wait);
    };
  }

  let store: EIconStore | undefined;

  export default CustomDialog.extend({
    components: { modal, draggable },
    props: {
      onSelect: Function
    },
    data() {
      return {
        l: l,
        storeLoaded: false as boolean,
        results: [] as string[],
        allResults: [] as string[],
        displayedCount: 77 as number,
        loadIncrement: 77 as number,
        recentMax: 55 as number,
        random_max: 2000,
        search: '' as string,
        refreshing: false,
        isLoadingMore: false,
        searchUpdateDebounce: (() => {}) as () => void,
        handleScroll: (() => {}) as () => void
      };
    },
    created(): void {
      this.searchUpdateDebounce = debounce(() => {
        this.runSearch();
      }, 350);

      this.handleScroll = debounce(() => {
        const resultsContainer = this.$refs['resultsContainer'] as HTMLElement;
        if (!resultsContainer || this.isLoadingMore) return;

        const scrollTop = resultsContainer.scrollTop;
        const scrollHeight = resultsContainer.scrollHeight;
        const clientHeight = resultsContainer.clientHeight;

        if (scrollTop + clientHeight >= scrollHeight - 200) {
          this.loadMoreResults();
        }
      }, 100);
    },
    async mounted(): Promise<void> {
      store = await EIconStore.getSharedStore();
      this.storeLoaded = true;

      EventBus.$on('eicon-pinned', (data: any) => {
        this.forceAddFavorite(data.eicon);
      });
      this.searchWithString('category:favorites');

      this.$nextTick(() => {
        const resultsContainer = this.$refs['resultsContainer'] as HTMLElement;
        if (resultsContainer) {
          resultsContainer.addEventListener('scroll', this.handleScroll);
        }
      });
    },
    beforeDestroy(): void {
      const resultsContainer = this.$refs['resultsContainer'] as HTMLElement;
      if (resultsContainer) {
        resultsContainer.removeEventListener('scroll', this.handleScroll);
      }
    },
    methods: {
      saveFavoritesOrder(e: { oldIndex: number; newIndex: number }): void {
        if (e.oldIndex === e.newIndex) return;
        const newFavorites: Record<string, boolean> = {};
        for (const fav of this.allResults) {
          if (!this.isFavorite(fav)) continue;
          newFavorites[fav] = true;
        }
        core.state.favoriteEIcons = newFavorites;
        void core.settingsStore.set(
          'favoriteEIcons',
          core.state.favoriteEIcons
        );
      },

      loadMoreResults(): void {
        if (this.displayedCount >= this.allResults.length) return;

        this.isLoadingMore = true;

        const newCount = Math.min(
          this.displayedCount + this.loadIncrement,
          this.allResults.length
        );

        this.displayedCount = newCount;
        this.results = this.allResults.slice(0, this.displayedCount);

        this.$nextTick(() => {
          this.isLoadingMore = false;
        });
      },

      searchWithString(s: string) {
        this.search = s;
        this.runSearch();
      },

      runSearch() {
        let s = this.search.toLowerCase();
        const bbcodeMatch = s.match(/^\[eicon\](.*?)\[\/eicon\]\s*$/i);
        if (bbcodeMatch) {
          s = bbcodeMatch[1].trim();
        }

        // reset pagination
        this.displayedCount = this.loadIncrement;

        if (s.startsWith('category:')) {
          const category = s.substring(9).trim();
          this.allResults = this.getCategoryResults(category);
        } else if (s.length === 0) {
          this.allResults = [...(store?.nextPage(this.random_max) || [])];
        } else {
          this.allResults = store?.search(s) || [];
        }

        this.results = this.allResults.slice(0, this.displayedCount);

        this.$nextTick(() => {
          // returns user to top after changing search; also ensures scroll
          // listener is attached whenever the non-favorites container renders
          const resultsContainer = this.$refs[
            'resultsContainer'
          ] as HTMLElement;
          if (resultsContainer) {
            resultsContainer.scrollTop = 0;
            resultsContainer.addEventListener('scroll', this.handleScroll);
          }
        });
      },

      getCategoryResults(category: string): string[] {
        switch (category) {
          case 'favorites':
            return Object.keys(core.state.favoriteEIcons);
          case 'recent':
            return core.state.recentEIcons;
        }

        return [];
      },

      selectIcon(eicon: string, event: MouseEvent): void {
        const shift = event.shiftKey;

        if (this.onSelect) {
          this.onSelect(eicon, shift);
        }

        const index = core.state.recentEIcons.indexOf(eicon);
        if (index !== -1) core.state.recentEIcons.splice(index, 1);
        if (core.state.recentEIcons.length > this.recentMax)
          core.state.recentEIcons.pop();
        core.state.recentEIcons.unshift(eicon);
        core.settingsStore.set('recentEIcons', core.state.recentEIcons);
      },

      async refreshIcons(): Promise<void> {
        this.refreshing = true;

        await store?.checkForUpdates();
        this.runSearch();

        this.refreshing = false;

        this.$nextTick(() => {
          const resultsContainer = this.$refs[
            'resultsContainer'
          ] as HTMLElement;
          if (resultsContainer) {
            resultsContainer.addEventListener('scroll', this.handleScroll);
          }
        });
      },

      setFocus(): void {
        (this.$refs['search'] as HTMLInputElement).focus();
        (this.$refs['search'] as HTMLInputElement).select();
      },

      isFavorite(eicon: string): boolean {
        return eicon in core.state.favoriteEIcons;
      },

      toggleFavorite(eicon: string): void {
        if (eicon in core.state.favoriteEIcons) {
          delete core.state.favoriteEIcons[eicon];
        } else {
          core.state.favoriteEIcons[eicon] = true;
        }

        void core.settingsStore.set(
          'favoriteEIcons',
          core.state.favoriteEIcons
        );

        this.$forceUpdate();
      },

      deleteRecent(eicon: string): void {
        const index = core.state.recentEIcons.indexOf(eicon);
        if (index !== -1) {
          core.state.recentEIcons.splice(index, 1);
          void core.settingsStore.set('recentEIcons', core.state.recentEIcons);
          this.runSearch();
        }
      },

      forceAddFavorite(eicon: string): void {
        if (eicon in core.state.favoriteEIcons) return;

        core.state.favoriteEIcons[eicon] = true;

        core.settingsStore.set('favoriteEIcons', core.state.favoriteEIcons);

        if (this.search === 'category:favorites') {
          this.runSearch();
        }
      },

      forceRemove(eicon: string): void {
        if (!(eicon in core.state.favoriteEIcons)) return;

        delete core.state.favoriteEIcons[eicon];

        core.settingsStore.set('favoriteEIcons', core.state.favoriteEIcons);

        if (this.search === 'category:favorites') {
          this.runSearch();
        }
      },

      close(): void {
        store?.shuffle();
      }
    }
  });
</script>

<style lang="scss">
  .eicon-selector {
    width: 580px;
    max-width: 580px;
    line-height: 1;
    z-index: 1000;

    &.big {
      min-height: 530px;
    }

    .eicon-selector-ui {
      .search-bar {
        display: flex;

        .search {
          flex: 1;
          border-top-right-radius: 0;
          border-bottom-right-radius: 0;
        }

        .search-buttons {
          margin-left: -1px;

          .btn {
            border-bottom: 1px solid var(--bs-secondary);
          }

          .favorites {
            border-top-left-radius: 0;
            border-bottom-left-radius: 0;
          }
        }
      }

      .courtesy {
        position: absolute;
        bottom: 7px;
        font-size: 9px;
        right: 1rem;
        opacity: 50%;
      }

      .upload {
        position: absolute;
        bottom: 7px;
        font-size: 9px;
        left: 1rem;
      }

      .results {
        max-height: 200px;
        overflow: hidden;
        margin-top: 5px;

        .carousel-inner {
          overflow-x: scroll;
          overflow-y: hidden;

          .carousel-item {
            display: table-cell;
            border: solid 1px transparent !important;
            position: relative;
            &:hover {
              &:not(:active) {
                background-color: var(--bs-light) !important;
                border: solid 1px var(--bs-light) !important;
              }
              .favorite-toggle,
              .recent-delete {
                visibility: visible;
              }
            }

            .recent-delete {
              position: absolute;
              left: 0;
              top: 0;
              border: none;
              margin: 0;
              padding: 4px;
              border-radius: 0;
              visibility: hidden;

              i {
                color: var(--bs-danger);
                opacity: 0.85;
                -webkit-text-stroke-width: thin;
                -webkit-text-stroke-color: var(--bs-secondary-color);

                &:hover {
                  opacity: 1;
                  filter: brightness(1.1);
                }
              }
            }

            .favorite-toggle {
              position: absolute;
              right: 0;
              top: 0;
              border: none;
              margin: 0;
              padding: 4px;
              border-radius: 0;
              visibility: hidden;

              i {
                color: var(--bs-secondary-text-emphasis);
                opacity: 0.85;
                -webkit-text-stroke-width: thin;
                -webkit-text-stroke-color: var(--bs-secondary-color);

                &:hover {
                  opacity: 1;
                }
              }

              &.favorited {
                visibility: visible;

                i {
                  color: var(--bs-success);
                  opacity: 1;

                  &:hover {
                    filter: brightness(1.1);
                  }
                }
              }
            }

            img.eicon {
              width: 75px;
              height: 75px;
              max-width: 75px;
              max-height: 75px;
            }
          }
        }
      }
    }

    &.big {
      min-height: 530px;
      width: 590px;
      max-width: 590px;

      .eicon-selector-ui {
        .carousel.results {
          max-height: unset;
          height: 535px;
          margin-bottom: 0.75rem;

          .carousel-inner {
            overflow-x: hidden;
            overflow-y: scroll;
            height: 100%;
          }

          .carousel-item {
            display: inline-block;
          }
        }
      }
    }
  }
</style>
