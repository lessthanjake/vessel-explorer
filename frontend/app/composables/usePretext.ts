import type {
  prepareWithSegments as PrepareWithSegmentsFn,
  layoutNextLine as LayoutNextLineFn,
  layoutWithLines as LayoutWithLinesFn,
  walkLineRanges as WalkLineRangesFn,
} from '@chenglou/pretext'

type PretextApi = {
  prepareWithSegments: typeof PrepareWithSegmentsFn
  layoutNextLine: typeof LayoutNextLineFn
  layoutWithLines: typeof LayoutWithLinesFn
  walkLineRanges: typeof WalkLineRangesFn
}

export function usePretext() {
  const ready = ref(false)
  let mod: PretextApi | null = null

  onMounted(async () => {
    const m = await import('@chenglou/pretext')
    mod = {
      prepareWithSegments: m.prepareWithSegments,
      layoutNextLine: m.layoutNextLine,
      layoutWithLines: m.layoutWithLines,
      walkLineRanges: m.walkLineRanges,
    }
    ready.value = true
  })

  return {
    ready,
    getApi(): PretextApi | null { return mod },
  }
}
