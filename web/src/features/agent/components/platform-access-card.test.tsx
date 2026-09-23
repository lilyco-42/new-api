/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { PlatformAccessCard } from './platform-access-card'

describe('PlatformAccessCard', () => {
  test('links to the desktop release instead of the latest platform release', () => {
    render(<PlatformAccessCard />)

    expect(
      screen.getByRole('link', { name: /Download Lain42 Agent desktop app/ })
    ).toHaveAttribute(
      'href',
      'https://github.com/lilyco-42/new-api/releases/tag/agent-v0.1.1'
    )
  })
})
