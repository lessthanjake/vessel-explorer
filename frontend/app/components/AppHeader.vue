<template>
  <header class="app-header">
    <NuxtLink to="/" class="app-title">vessel explorer</NuxtLink>
    <Tooltip v-if="statsLoading || claimed != null || statsError" side="bottom" align="center" :side-offset="8" :delay-duration="100" :arrow="false">
      <template #trigger>
        <span class="header-stats" @mouseenter="loadFilledBytes">
          <template v-if="statsLoading">loading stats...</template>
          <template v-else-if="statsError">{{ statsError }}</template>
          <template v-else>{{ claimed }} claimed<template v-if="blocksSinceDeploy != null"> since {{ blocksSinceDeploy.toLocaleString() }} blocks</template></template>
        </span>
      </template>
      <div class="stats-popover">
        <div class="stats-row" v-if="statsLoading">
          <span class="stats-label">stats</span>
          <span class="stats-value">loading...</span>
        </div>
        <div class="stats-row" v-else-if="statsError">
          <span class="stats-label">stats</span>
          <span class="stats-value">{{ statsError }}</span>
        </div>
        <div class="stats-row">
          <span class="stats-label">capacity claimed</span>
          <span class="stats-value">{{ formatBytes(claimedCapacity) }} <span class="stat-sep">/ {{ formatBytes(TOTAL_CAPACITY) }}</span></span>
        </div>
        <div class="stats-row">
          <span class="stats-label">bytes filled</span>
          <span class="stats-value">
            <template v-if="filledBytes != null">{{ formatBytes(filledBytes) }}<span v-if="filledLoading" class="spinner" /></template>
            <template v-else>loading...</template>
          </span>
        </div>
        <div class="stats-row" v-if="holderCount">
          <span class="stats-label">unique holders</span>
          <span class="stats-value">{{ holderCount }}</span>
        </div>
        <div class="stats-row" v-if="holderCount && claimed">
          <span class="stats-label">avg vessels/holder</span>
          <span class="stats-value">{{ (claimed / holderCount).toFixed(1) }}</span>
        </div>
        <div class="stats-row" v-if="largestHolder">
          <span class="stats-label">largest holder</span>
          <span class="stats-value">
            <NuxtLink :to="`/address/${largestHolder.address}`" class="stats-link">
              <AddressDisplay :address="largestHolder.address" />
            </NuxtLink>
            <span class="stat-sep"> ({{ largestHolder.count }})</span>
          </span>
        </div>
      </div>
    </Tooltip>
    <div class="header-actions">
      <NuxtLink to="/ecosystem" class="text-btn">[ecosystem]</NuxtLink>
      <NuxtLink to="/grid" class="text-btn">[grid]</NuxtLink>
      <NuxtLink to="/all" class="text-btn">[all]</NuxtLink>
      <button class="text-btn" @click="toggleDark">
        {{ isDark ? '[light]' : '[dark]' }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { readContract, getBlockNumber } from '@wagmi/core'
import { useConfig } from '@wagmi/vue'
import { VESSEL_ADDRESS, VESSEL_ABI, hexToBytes } from '~/utils/vessel'
import { fetchOwnership } from '~/composables/useOwnership'

const wagmiConfig = useConfig()
const COLOR_MODE_KEY = 'vessel-color-mode'
const isDark = ref(true)
const claimed = ref<number | null>(null)
const claimedIds = ref<string[]>([])
const holderCount = ref(0)
const largestHolder = ref<{ address: string; count: number } | null>(null)
const filledBytes = ref<number | null>(null)
const filledLoading = ref(false)
const blocksSinceDeploy = ref<number | null>(null)
const statsLoading = ref(true)
const statsError = ref<string | null>(null)
let blocksTimer: ReturnType<typeof setInterval> | null = null

const TOTAL_CAPACITY = 50_005_000

const claimedCapacity = computed(() => {
  let sum = 0
  for (const id of claimedIds.value) sum += Number(id)
  return sum
})

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

onMounted(async () => {
  const root = document.documentElement
  const stored = localStorage.getItem(COLOR_MODE_KEY)
  const shouldBeDark = stored ? stored === 'dark' : true
  root.classList.toggle('dark', shouldBeDark)
  isDark.value = shouldBeDark

  try {
    if (claimed.value == null) {
      const [claimedCount] = await Promise.all([
        readContract(wagmiConfig, {
          address: VESSEL_ADDRESS,
          abi: VESSEL_ABI,
          functionName: 'claimedCount',
        }) as Promise<bigint>,
      ])
      claimed.value = Number(claimedCount)
    }
    const { ownership, ownerTokens } = await fetchOwnership()
    claimedIds.value = [...ownership.keys()]
    holderCount.value = ownerTokens.size

    let maxCount = 0
    let maxAddr = ''
    for (const [addr, tokens] of ownerTokens.entries()) {
      if (tokens.length > maxCount) {
        maxCount = tokens.length
        maxAddr = addr
      }
    }
    if (maxAddr) largestHolder.value = { address: maxAddr, count: maxCount }

    if (blocksSinceDeploy.value == null) {
      const DEPLOY_BLOCK = 24624612n
      const currentBlock = await getBlockNumber(wagmiConfig)
      blocksSinceDeploy.value = Number(currentBlock - DEPLOY_BLOCK)
    }
  } catch {
    if (claimed.value == null) statsError.value = 'stats unavailable'
  } finally {
    statsLoading.value = false
  }

  if (blocksSinceDeploy.value != null) {
    blocksTimer = setInterval(() => { blocksSinceDeploy.value!++ }, 12_000)
  }
})

onUnmounted(() => {
  if (blocksTimer != null) clearInterval(blocksTimer)
})

// Lazy load filled bytes on first hover
async function loadFilledBytes() {
  if (filledLoading.value || filledBytes.value != null || claimedIds.value.length === 0) return
  filledLoading.value = true

  try {
    let total = 0
    const BATCH = 20
    for (let i = 0; i < claimedIds.value.length; i += BATCH) {
      const batch = claimedIds.value.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(id =>
          readContract(wagmiConfig, {
            address: VESSEL_ADDRESS,
            abi: VESSEL_ABI,
            functionName: 'craftToPayload',
            args: [BigInt(id)],
          }).catch(() => '0x') as Promise<string>
        )
      )
      for (const raw of results) {
        total += hexToBytes(raw).length
      }
      filledBytes.value = total
    }
  } finally {
    filledLoading.value = false
  }
}

function toggleDark() {
  const root = document.documentElement
  root.classList.toggle('dark')
  isDark.value = root.classList.contains('dark')
  localStorage.setItem(COLOR_MODE_KEY, isDark.value ? 'dark' : 'light')
}
</script>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  font-family: var(--font-mono);
  font-size: 14px;
}

.app-title {
  color: var(--color);
  text-decoration: none;
  font-weight: 700;
  text-transform: lowercase;
}

.header-stats {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;

  &:hover {
    color: var(--color);
  }
}

.stat-sep {
  color: var(--text-faint);
}

.stats-popover {
  font-family: var(--font-mono);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.25rem 0;
  min-width: 14rem;
}

.stats-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.stats-label {
  color: var(--muted);
}

.stats-value {
  color: var(--color);
  text-align: right;
}

.stats-link {
  color: var(--color);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-left: 4px;
  border: 1.5px solid var(--text-faint);
  border-top-color: var(--color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: -1px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .header-stats {
    display: none;
  }
}
</style>
