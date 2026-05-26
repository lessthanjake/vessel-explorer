<template>
  <div class="ecosystem-page">
    <AppHeader />

    <main class="ecosystem-content">
      <div class="eco-toolbar">
        <button class="text-btn back-link" type="button" @click="$router.back()">[back]</button>
        <h1 class="eco-heading">ecosystem</h1>
        <div class="eco-filters">
          <button
            v-for="cat in filterOptions"
            :key="cat"
            class="text-btn"
            :class="{ 'filter-active': activeFilter === cat }"
            type="button"
            @click="setFilter(cat)"
          >
            [{{ cat }}]
          </button>
        </div>
      </div>

      <div v-if="!pretextReady" class="status">loading layout engine...</div>
      <div ref="stageRef" class="eco-stage" />
    </main>

    <!-- Modal overlay -->
    <Teleport to="body">
      <div v-if="modalProject" class="eco-modal-backdrop" @click.self="closeModal">
        <div class="eco-modal">
          <div class="eco-modal-header">
            <span :class="`color-${modalProject.category}`">[{{ modalProject.name }}]</span>
            <button class="text-btn" type="button" @click="closeModal">[close]</button>
          </div>
          <div class="eco-modal-body">
            <div v-if="modalProject.artworkSrc" class="eco-modal-artwork">
              <iframe
                :src="modalProject.artworkSrc"
                sandbox="allow-scripts allow-same-origin"
                frameborder="0"
              />
            </div>
            <div v-else class="eco-modal-placeholder">
              <span :class="`color-${modalProject.category}`">{{ modalProject.name[0]?.toUpperCase() }}</span>
            </div>
            <p class="eco-modal-desc">{{ modalProject.description }}</p>
            <div v-if="modalProject.urls?.length" class="eco-modal-links">
              <a
                v-for="link in modalProject.urls"
                :key="link.href"
                :href="link.href"
                target="_blank"
                rel="noopener"
                class="eco-modal-link"
              >[{{ link.label }}]</a>
            </div>
            <div v-if="modalProject.contracts?.length" class="eco-modal-contracts">
              <a
                v-for="c in modalProject.contracts"
                :key="c.address"
                :href="`https://evm.now/address/${c.address}`"
                target="_blank"
                rel="noopener"
                class="eco-modal-link"
              >[{{ c.name }}]</a>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { readContract } from '@wagmi/core'
import { useConfig } from '@wagmi/vue'
import { ECOSYSTEM_PROJECTS, ECOSYSTEM_CATEGORIES, type EcosystemCategory, type EcosystemProject } from '~/utils/ecosystem'
import { createEcosystemEngine } from '~/utils/ecosystem-engine'
import { usePretext } from '~/composables/usePretext'

const wagmiConfig = useConfig()
const { ready: pretextReady, getApi } = usePretext()

const stageRef = ref<HTMLElement | null>(null)
const activeFilter = ref<EcosystemCategory | 'all'>('all')
const filterOptions = ['all', ...ECOSYSTEM_CATEGORIES] as const
const onChainValues = reactive<Record<string, string>>({})
const modalProject = ref<EcosystemProject | null>(null)

let engine: ReturnType<typeof createEcosystemEngine> | null = null

async function fetchOnChainData() {
  for (const project of ECOSYSTEM_PROJECTS) {
    if (!project.onChainQuery) continue
    try {
      const result = await readContract(wagmiConfig, {
        address: project.onChainQuery.address,
        abi: project.onChainQuery.abi,
        functionName: project.onChainQuery.functionName,
      })
      onChainValues[project.slug] = `${result}`
    } catch {
      // ignore — on-chain data is progressive enrichment
    }
  }
}

function setFilter(cat: EcosystemCategory | 'all') {
  activeFilter.value = cat
  engine?.setFilter(cat)
}

const router = useRouter()

function openModal(slug: string) {
  const project = ECOSYSTEM_PROJECTS.find(p => p.slug === slug)
  if (!project) return

  if (project.action === 'navigate') {
    const target = project.navigateTo || project.urls?.[0]?.href
    if (target?.startsWith('/')) {
      router.push(target)
    } else if (target) {
      window.open(target, '_blank', 'noopener')
    }
  } else {
    modalProject.value = project
  }
}

function closeModal() {
  modalProject.value = null
}

async function initEngine() {
  if (!pretextReady.value || !stageRef.value) return
  const api = getApi()
  if (!api) return
  if (engine) return // already initialized

  engine = createEcosystemEngine()
  engine.onOpenModal(openModal)
  await engine.init(stageRef.value, ECOSYSTEM_PROJECTS, api, onChainValues)

  fetchOnChainData().then(() => {
    engine?.updateNarrative(ECOSYSTEM_PROJECTS, onChainValues)
  })
}

watch(pretextReady, initEngine)
onMounted(initEngine)

onUnmounted(() => {
  engine?.destroy()
  engine = null
})
</script>

<style scoped>
.ecosystem-page {
  min-height: 100vh;
}

.ecosystem-content {
  padding: 0 1rem;
}

.eco-toolbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 0;
  flex-wrap: wrap;
}

.eco-heading {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  text-transform: lowercase;
  margin: 0;
}

.eco-filters {
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}

.filter-active {
  color: var(--color) !important;
  text-decoration: underline;
}

/* Modal */
.eco-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.eco-modal {
  background: var(--background);
  border: 1px solid var(--border-color);
  width: 100%;
  max-width: 640px;
  max-height: 80vh;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 13px;
}

.eco-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  font-size: 14px;
  font-weight: 700;
  text-transform: lowercase;
}

.eco-modal-body {
  padding: 1rem;
}

.eco-modal-artwork {
  width: 100%;
  aspect-ratio: 4 / 3;
  border: 1px solid var(--border-color);
  margin-bottom: 1rem;
}

.eco-modal-artwork iframe {
  width: 100%;
  height: 100%;
  display: block;
  border: none;
}

.eco-modal-placeholder {
  width: 100%;
  aspect-ratio: 4 / 3;
  border: 1px solid var(--border-color);
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 64px;
  font-weight: 700;
  opacity: 0.3;
}

.eco-modal-desc {
  color: var(--muted);
  line-height: 1.6;
  margin: 0 0 1rem;
}

.eco-modal-links,
.eco-modal-contracts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.eco-modal-link {
  color: var(--muted);
  text-decoration: none;
  text-transform: lowercase;

  &:hover {
    color: var(--color);
  }
}
</style>
