import { describe, expect, it } from 'vitest'

import {
  createRadxaPairingScript,
  RADXA_COMPANION_RELEASE_TAG,
} from './radxa-pairing-script'

describe('createRadxaPairingScript', () => {
  it('copies the pinned prebuilt installer and current HTTPS site origin', () => {
    expect(createRadxaPairingScript('https://api.lain42.top')).toBe(
      `bash -o pipefail -c 'curl --fail --location --silent --show-error https://github.com/lilyco-42/new-api/releases/download/${RADXA_COMPANION_RELEASE_TAG}/install.sh | bash -s -- --api-origin https://api.lain42.top'`
    )
  })

  it('normalizes an HTTPS origin and rejects paths or embedded credentials', () => {
    expect(createRadxaPairingScript('https://api.lain42.top/')).toContain(
      '--api-origin https://api.lain42.top'
    )
    expect(() =>
      createRadxaPairingScript('https://api.lain42.top/agent')
    ).toThrow('HTTPS site origin')
    expect(() =>
      createRadxaPairingScript('http://api.lain42.top')
    ).toThrow('HTTPS site origin')
    expect(() =>
      createRadxaPairingScript('https://user:secret@api.lain42.top')
    ).toThrow('HTTPS site origin')
  })
})
