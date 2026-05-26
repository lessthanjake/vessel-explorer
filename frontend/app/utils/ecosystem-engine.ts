/**
 * Ecosystem map rendering engine.
 *
 * 3D carousel orbit: project nodes revolve in an elliptical path with
 * perspective. Closer nodes are larger, farther nodes are smaller.
 * Clicking a node selects it and rotates the carousel to bring it forward.
 * Text reflows around the moving nodes via pretext's layoutNextLine().
 */

import type {
  prepareWithSegments as PrepareWithSegmentsFn,
  layoutNextLine as LayoutNextLineFn,
  LayoutCursor,
  PreparedTextWithSegments,
} from '@chenglou/pretext'

import type { EcosystemProject, EcosystemCategory } from './ecosystem'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Interval = { left: number; right: number }

type PositionedLine = { x: number; y: number; text: string; width: number; slotWidth: number }

type CarouselNode = {
  slug: string
  category: EcosystemCategory
  angle: number           // radians, position on the orbit
  baseW: number
  baseH: number
  el: HTMLDivElement
  visible: boolean
  // computed each frame:
  screenX: number
  screenY: number
  screenW: number
  screenH: number
  depth: number           // 0 = front, 1 = back
  scale: number
}

type SpinDrag = {
  startX: number
  lastX: number
  lastTime: number
  velocity: number          // radians/sec from drag gesture
  startAngleOffset: number
  didMove: boolean          // distinguish click from drag
  originalTarget: HTMLElement // target at pointerdown (capture redirects later events)
}

type EngineState = {
  container: HTMLElement
  nodes: CarouselNode[]
  selectedSlug: string | null
  targetAngleOffset: number  // carousel rotation target
  currentAngleOffset: number // current rotation (eases toward target)
  orbitSpeed: number         // radians per second (ambient rotation)
  spinDrag: SpinDrag | null
  flickSpeed: number         // inertial spin from flick (decays to 0)
  prepared: PreparedTextWithSegments | null
  linePool: HTMLDivElement[]
  rafId: number | null
  lastTime: number | null
  filter: EcosystemCategory | 'all'
  onChainValues: Record<string, string>
  destroyed: boolean
}

type PretextApi = {
  prepareWithSegments: typeof PrepareWithSegmentsFn
  layoutNextLine: typeof LayoutNextLineFn
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEXT_FONT = '14px "JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, monospace'
const LINE_HEIGHT = 22
const PADDING = 24
const OBSTACLE_PAD = 20
const MIN_SLOT_WIDTH = 60

const ORBIT_SPEED = 0.15        // radians/sec ambient rotation
const EASE_FACTOR = 3.0         // how fast selection snaps
const MIN_SCALE = 0.55          // back of carousel
const MAX_SCALE = 1.15          // front of carousel
const SELECTED_SCALE = 1.4      // selected node bonus
const ORBIT_RX_RATIO = 0.35     // horizontal radius as fraction of container width
const ORBIT_RY_RATIO = 0.12     // vertical radius as fraction — squashed ellipse
const ORBIT_CY_RATIO = 0.32     // vertical center as fraction of container height
const BASE_W = 130
const BASE_H = 90
const FLICK_FRICTION = 0.92       // multiply each frame — decays to 0
const FLICK_MIN = 0.01            // below this, snap to 0

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

function buildNarrative(projects: EcosystemProject[], onChainValues: Record<string, string>): string {
  const claimed = onChainValues['vessel'] ?? '...'
  const parts = [
    `The Vessel is an on-chain storage protocol — 10,000 ERC-721 tokens on Ethereum mainnet, ${claimed} claimed so far. Each token is a byte container whose capacity equals its token ID. Capsules overwrite. Vaults append. Machines delegate to external contracts at render time.`,
    '',
    'Around that core, an ecosystem of projects has grown:',
    '',
  ]

  for (const p of projects) {
    parts.push(`${p.name} — ${p.description}`)
    parts.push('')
  }

  parts.push(
    'Every project connects back to the Vessel contract. The on-chain storage layer is the substrate — bytes go in, art comes out, and the network remembers.',
  )

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Slot carving (from editorial-engine)
// ---------------------------------------------------------------------------

function carveTextLineSlots(base: Interval, blocked: Interval[]): Interval[] {
  let slots = [base]
  for (let i = 0; i < blocked.length; i++) {
    const b = blocked[i]!
    const next: Interval[] = []
    for (let j = 0; j < slots.length; j++) {
      const s = slots[j]!
      if (b.right <= s.left || b.left >= s.right) {
        next.push(s)
        continue
      }
      if (b.left > s.left) next.push({ left: s.left, right: b.left })
      if (b.right < s.right) next.push({ left: b.right, right: s.right })
    }
    slots = next
  }
  return slots.filter(s => s.right - s.left >= MIN_SLOT_WIDTH)
}

// ---------------------------------------------------------------------------
// Text layout around obstacles
// ---------------------------------------------------------------------------

function layoutText(
  api: PretextApi,
  prepared: PreparedTextWithSegments,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  nodes: CarouselNode[],
): PositionedLine[] {
  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
  let lineTop = regionY
  const lines: PositionedLine[] = []

  while (lineTop + LINE_HEIGHT <= regionY + regionH) {
    const bandTop = lineTop
    const bandBottom = lineTop + LINE_HEIGHT
    const blocked: Interval[] = []

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      if (!n.visible) continue
      const pad = OBSTACLE_PAD
      const left = n.screenX - pad
      const right = n.screenX + n.screenW + pad
      const top = n.screenY - pad
      const bottom = n.screenY + n.screenH + pad
      if (bandBottom <= top || bandTop >= bottom) continue
      blocked.push({ left, right })
    }

    const slots = carveTextLineSlots({ left: regionX, right: regionX + regionW }, blocked)
    if (slots.length === 0) {
      lineTop += LINE_HEIGHT
      continue
    }

    const ordered = [...slots].sort((a, b) => a.left - b.left)
    let exhausted = false

    for (let i = 0; i < ordered.length; i++) {
      const slot = ordered[i]!
      const slotWidth = slot.right - slot.left
      const line = api.layoutNextLine(prepared, cursor, slotWidth)
      if (line === null) {
        exhausted = true
        break
      }
      lines.push({
        x: Math.round(slot.left),
        y: Math.round(lineTop),
        text: line.text,
        width: line.width,
        slotWidth,
      })
      cursor = line.end
    }

    if (exhausted) break
    lineTop += LINE_HEIGHT
  }

  return lines
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function syncLinePool(pool: HTMLDivElement[], count: number, container: HTMLElement): void {
  while (pool.length < count) {
    const el = document.createElement('div')
    el.className = 'text-line'
    container.appendChild(el)
    pool.push(el)
  }
  for (let i = 0; i < pool.length; i++) {
    pool[i]!.style.display = i < count ? '' : 'none'
  }
}

function createNodeElement(project: EcosystemProject): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = 'artwork-wrap'
  wrap.dataset.slug = project.slug

  if (project.artworkSrc) {
    const iframe = document.createElement('iframe')
    iframe.src = project.artworkSrc
    iframe.sandbox.add('allow-scripts', 'allow-same-origin')
    iframe.width = String(project.artworkSize?.w ?? BASE_W)
    iframe.height = String(project.artworkSize?.h ?? BASE_H)
    wrap.appendChild(iframe)
  } else {
    const placeholder = document.createElement('div')
    placeholder.className = `artwork-placeholder color-${project.category}`
    placeholder.textContent = project.name[0]?.toUpperCase() ?? '?'
    wrap.appendChild(placeholder)
  }

  const overlay = document.createElement('div')
  overlay.className = 'artwork-overlay'
  wrap.appendChild(overlay)

  const label = document.createElement('div')
  label.className = `artwork-label color-${project.category}`
  label.textContent = `[${project.name}]`
  wrap.appendChild(label)

  return wrap
}

// ---------------------------------------------------------------------------
// Carousel math
// ---------------------------------------------------------------------------

/** Update screen positions from current angles */
function computeNodePositions(
  nodes: CarouselNode[],
  containerW: number,
  containerH: number,
  angleOffset: number,
  selectedSlug: string | null,
): void {
  const cx = containerW / 2
  const cy = Math.max(containerH * ORBIT_CY_RATIO, 160)
  const rx = Math.max(containerW * ORBIT_RX_RATIO, 120)
  const ry = Math.max(containerH * ORBIT_RY_RATIO, 40)

  for (const n of nodes) {
    if (!n.visible) continue
    const a = n.angle + angleOffset

    // Elliptical orbit: x = cx + rx*cos(a), y = cy + ry*sin(a)
    // sin(a) > 0 = front (bottom of ellipse = closer to viewer)
    const cosA = Math.cos(a)
    const sinA = Math.sin(a)

    // depth: 0 = front (sin=1), 1 = back (sin=-1)
    n.depth = (1 - sinA) / 2

    // Scale: lerp between MIN_SCALE and MAX_SCALE based on depth
    let scale = MIN_SCALE + (1 - n.depth) * (MAX_SCALE - MIN_SCALE)
    if (n.slug === selectedSlug) {
      scale = Math.max(scale, SELECTED_SCALE)
    }
    n.scale = scale

    n.screenW = Math.round(n.baseW * scale)
    n.screenH = Math.round(n.baseH * scale)

    // Center the node on its orbit position
    n.screenX = Math.round(cx + rx * cosA - n.screenW / 2)
    n.screenY = Math.round(cy + ry * sinA - n.screenH / 2)
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(st: EngineState, api: PretextApi): void {
  if (st.destroyed || !st.prepared) return

  const containerW = st.container.clientWidth
  const stageH = Math.max(600, window.innerHeight - 100)

  // Compute positions
  computeNodePositions(st.nodes, containerW, stageH, st.currentAngleOffset, st.selectedSlug)

  // Text region: below the carousel orbit area
  const orbitBottom = Math.max(stageH * ORBIT_CY_RATIO + stageH * ORBIT_RY_RATIO + BASE_H, 300)
  const textTop = Math.round(orbitBottom + PADDING)
  const regionX = PADDING
  const regionW = containerW - PADDING * 2

  // Nodes in the orbit zone act as obstacles for text that overlaps
  // But also lay out text in the region below the orbit
  const textRegionH = 2000 // enough room for the narrative
  const lines = layoutText(api, st.prepared, regionX, textTop, regionW, textRegionH, st.nodes)

  // Sync line DOM
  syncLinePool(st.linePool, lines.length, st.container)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const el = st.linePool[i]!
    el.style.left = `${l.x}px`
    el.style.top = `${l.y}px`
    el.style.width = `${l.slotWidth}px`
    el.textContent = l.text
  }

  // Sort nodes by depth for z-ordering (back first, front last)
  const sorted = [...st.nodes].sort((a, b) => b.depth - a.depth)

  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!
    const el = n.el
    if (!n.visible) {
      el.style.display = 'none'
      continue
    }
    el.style.display = ''
    el.style.left = `${n.screenX}px`
    el.style.top = `${n.screenY}px`
    el.style.width = `${n.screenW}px`
    el.style.zIndex = `${i + 1}`
    el.style.transform = `scale(1)` // actual size is set via screenW/screenH
    el.style.opacity = `${0.4 + 0.6 * (1 - n.depth)}`

    // Scale the placeholder height to match
    const placeholder = el.querySelector('.artwork-placeholder') as HTMLElement | null
    if (placeholder) {
      placeholder.style.height = `${Math.round(n.baseH * n.scale)}px`
    }
  }

  // Size container to fit
  const lastLineBottom = lines.length > 0 ? lines[lines.length - 1]!.y + LINE_HEIGHT : textTop
  st.container.style.height = `${Math.max(lastLineBottom + PADDING * 2, stageH)}px`
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

function tick(st: EngineState, api: PretextApi, now: number): void {
  if (st.destroyed) return

  const dt = st.lastTime !== null ? Math.min((now - st.lastTime) / 1000, 0.05) : 0
  st.lastTime = now

  // During an active drag, tick just renders — angle is set directly by onPointerMove
  if (!st.spinDrag) {
    // Apply flick inertia
    if (Math.abs(st.flickSpeed) > FLICK_MIN) {
      st.currentAngleOffset += st.flickSpeed * dt
      st.flickSpeed *= FLICK_FRICTION
    } else if (st.flickSpeed !== 0) {
      st.flickSpeed = 0
      // Flick ended — resume ambient rotation
      if (st.selectedSlug === null) {
        st.orbitSpeed = ORBIT_SPEED
      }
    }

    // Ambient rotation
    st.currentAngleOffset += st.orbitSpeed * dt

    // Ease toward target if a node is selected
    if (st.selectedSlug !== null) {
      const diff = st.targetAngleOffset - st.currentAngleOffset
      // Normalize to [-PI, PI]
      const wrapped = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
      st.currentAngleOffset += wrapped * EASE_FACTOR * dt
    }
  }

  render(st, api)

  st.rafId = requestAnimationFrame((t) => tick(st, api, t))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createEcosystemEngine() {
  let st: EngineState | null = null
  let api: PretextApi | null = null
  let openModalCallback: ((slug: string) => void) | null = null

  const DRAG_THRESHOLD = 5         // px before drag is recognized
  const DRAG_SENSITIVITY = 0.004    // radians per pixel of horizontal drag

  function onPointerDown(e: PointerEvent) {
    if (!st) return
    st.spinDrag = {
      startX: e.clientX,
      lastX: e.clientX,
      lastTime: performance.now(),
      velocity: 0,
      startAngleOffset: st.currentAngleOffset,
      didMove: false,
      originalTarget: e.target as HTMLElement,
    }
    st.flickSpeed = 0  // kill any running flick
    st.container.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent) {
    if (!st?.spinDrag) return
    const drag = st.spinDrag
    const dx = e.clientX - drag.startX

    if (!drag.didMove && Math.abs(e.clientX - drag.startX) > DRAG_THRESHOLD) {
      drag.didMove = true
      st.container.classList.add('grabbing')
      // Pause ambient rotation and deselect while dragging
      st.orbitSpeed = 0
      st.selectedSlug = null
    }

    if (!drag.didMove) return

    // Map horizontal drag to angle offset (inverted — drag right = spin left)
    st.currentAngleOffset = drag.startAngleOffset - dx * DRAG_SENSITIVITY

    // Track velocity from recent movement
    const now = performance.now()
    const timeDelta = (now - drag.lastTime) / 1000
    if (timeDelta > 0.001) {
      const pixelDelta = e.clientX - drag.lastX
      drag.velocity = -(pixelDelta * DRAG_SENSITIVITY) / timeDelta
    }
    drag.lastX = e.clientX
    drag.lastTime = now
  }

  function onPointerUp(e: PointerEvent) {
    if (!st?.spinDrag) return
    const drag = st.spinDrag
    st.spinDrag = null
    st.container.classList.remove('grabbing')
    st.container.releasePointerCapture(e.pointerId)

    if (!drag.didMove) {
      // This was a click, not a drag — handle node selection
      handleClick(drag.originalTarget)
      return
    }

    // Apply flick inertia from drag velocity
    st.flickSpeed = drag.velocity
    st.orbitSpeed = 0 // stay paused — flick takes over, then ambient resumes when it decays
  }

  function handleClick(clickTarget: HTMLElement) {
    if (!st) return
    const target = clickTarget.closest('.artwork-wrap') as HTMLElement | null
    if (!target) {
      // Click on empty space — deselect
      if (st.selectedSlug !== null) {
        st.selectedSlug = null
        st.orbitSpeed = ORBIT_SPEED
      }
      return
    }

    const slug = target.dataset.slug
    if (!slug) return

    const node = st.nodes.find(n => n.slug === slug)
    if (!node || !node.visible) return

    if (st.selectedSlug === slug) {
      // Clicking selected node again — open modal
      if (openModalCallback) openModalCallback(slug)
      return
    }

    // Select: rotate carousel so this node comes to front (angle = PI/2)
    st.selectedSlug = slug
    st.orbitSpeed = 0 // stop ambient rotation while selected
    st.flickSpeed = 0 // kill any flick

    // Target offset: we want node.angle + offset = PI/2 (front position)
    const frontAngle = Math.PI / 2
    st.targetAngleOffset = frontAngle - node.angle
  }

  function onResize() {
    // Animation loop handles re-render continuously
  }

  return {
    async init(
      container: HTMLElement,
      projects: EcosystemProject[],
      pretextApi: PretextApi,
      onChainValues: Record<string, string> = {},
    ) {
      api = pretextApi
      await document.fonts.ready

      const narrative = buildNarrative(projects, onChainValues)
      const prepared = pretextApi.prepareWithSegments(narrative, TEXT_FONT)

      // Distribute nodes evenly around the orbit
      const nodes: CarouselNode[] = []
      const visibleProjects = projects
      const step = (Math.PI * 2) / visibleProjects.length

      for (let i = 0; i < visibleProjects.length; i++) {
        const project = visibleProjects[i]!
        const el = createNodeElement(project)
        container.appendChild(el)
        const hasArt = !!project.artworkSrc
        const w = hasArt ? (project.artworkSize?.w ?? BASE_W) : BASE_W
        const h = hasArt ? (project.artworkSize?.h ?? BASE_H) : BASE_H

        nodes.push({
          slug: project.slug,
          category: project.category,
          angle: step * i,
          baseW: w,
          baseH: h,
          el,
          visible: true,
          screenX: 0,
          screenY: 0,
          screenW: w,
          screenH: h,
          depth: 0,
          scale: 1,
        })
      }

      st = {
        container,
        nodes,
        selectedSlug: null,
        targetAngleOffset: 0,
        currentAngleOffset: 0,
        orbitSpeed: ORBIT_SPEED,
        spinDrag: null,
        flickSpeed: 0,
        prepared,
        linePool: [],
        rafId: null,
        lastTime: null,
        filter: 'all',
        onChainValues,
        destroyed: false,
      }

      container.style.touchAction = 'pan-y' // allow vertical scroll, capture horizontal
      container.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('resize', onResize)

      // Start animation loop
      st.rafId = requestAnimationFrame((t) => tick(st!, api!, t))
    },

    setFilter(category: EcosystemCategory | 'all') {
      if (!st) return
      st.filter = category
      for (const n of st.nodes) {
        n.visible = category === 'all' || n.category === category
      }
      // Re-distribute angles for visible nodes
      const visible = st.nodes.filter(n => n.visible)
      const step = visible.length > 0 ? (Math.PI * 2) / visible.length : 0
      for (let i = 0; i < visible.length; i++) {
        visible[i]!.angle = step * i
      }
      st.selectedSlug = null
      st.orbitSpeed = ORBIT_SPEED
    },

    onOpenModal(cb: (slug: string) => void) {
      openModalCallback = cb
    },

    updateNarrative(projects: EcosystemProject[], onChainValues: Record<string, string>) {
      if (!st || !api) return
      st.onChainValues = onChainValues
      const narrative = buildNarrative(projects, onChainValues)
      st.prepared = api.prepareWithSegments(narrative, TEXT_FONT)
    },

    destroy() {
      if (!st) return
      const container = st.container
      st.destroyed = true
      if (st.rafId !== null) cancelAnimationFrame(st.rafId)
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('resize', onResize)

      for (const el of st.linePool) el.remove()
      for (const n of st.nodes) n.el.remove()
      st = null
      api = null
    },
  }
}
