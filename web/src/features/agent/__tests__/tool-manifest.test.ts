import { describe, expect, it } from 'vitest'

import { AGENT_TOOL_MANIFEST } from '../tool-manifest'

describe('Agent tool manifest', () => {
  it('does not advertise CLI write or impact operations that are not implemented', () => {
    const tools = new Map(AGENT_TOOL_MANIFEST.map((tool) => [tool.id, tool]))

    expect(tools.get('jj')?.capabilities).toEqual(['vcs.history'])
    expect(tools.get('ast-grep')?.capabilities).toEqual(['code.search'])
    expect(tools.get('codegraph')?.capabilities).toEqual(['code.graph'])
    expect(tools.get('yazi')?.capabilities).toEqual([])

    const advertisedCapabilities = AGENT_TOOL_MANIFEST.flatMap(
      (tool) => tool.capabilities
    )
    expect(advertisedCapabilities).not.toContain('vcs.change')
    expect(advertisedCapabilities).not.toContain('code.rewrite')
    expect(advertisedCapabilities).not.toContain('code.impact')
  })
})
