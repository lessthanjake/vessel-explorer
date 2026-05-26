import { VESSEL_ADDRESS, VESSEL_ABI } from './vessel'
import configData from '~/config/ecosystem.json'

export type EcosystemCategory = 'protocol' | 'token' | 'art' | 'tool' | 'community'

export interface EcosystemProject {
  slug: string
  name: string
  description: string
  category: EcosystemCategory
  status: 'live' | 'building' | 'concept'
  action: 'modal' | 'navigate'
  navigateTo?: string
  contracts?: { address: `0x${string}`; name: string; chain: string }[]
  urls?: { label: string; href: string }[]
  connections?: string[]
  artworkSrc?: string
  artworkSize?: { w: number; h: number }
  onChainQuery?: {
    functionName: string
    address: `0x${string}`
    abi: readonly any[]
    label: string
  }
}

export const ECOSYSTEM_CATEGORIES: EcosystemCategory[] = [
  'protocol', 'token', 'art', 'tool', 'community',
]

// On-chain queries keyed by slug — ABIs can't live in JSON
const ON_CHAIN_QUERIES: Record<string, EcosystemProject['onChainQuery']> = {
  vessel: {
    functionName: 'claimedCount',
    address: VESSEL_ADDRESS,
    abi: VESSEL_ABI,
    label: 'claimed',
  },
}

export const ECOSYSTEM_PROJECTS: EcosystemProject[] = (configData as any[]).map(entry => ({
  ...entry,
  contracts: entry.contracts?.map((c: any) => ({ ...c, address: c.address as `0x${string}` })),
  onChainQuery: ON_CHAIN_QUERIES[entry.slug],
}))
