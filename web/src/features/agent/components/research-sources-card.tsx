/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { BookOpen, ExternalLink, GitBranch, Globe2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type Source = {
  name: string
  description: string
  url: string
  icon: typeof GitBranch
}

const SOURCES: Source[] = [
  {
    name: 'GitHub Issues & PRs',
    description: 'Issue、Pull Request 和项目趋势',
    url: 'https://github.com/issues',
    icon: GitBranch,
  },
  {
    name: 'GitHub Trending',
    description: '每日流行项目与语言榜单',
    url: 'https://github.com/trending',
    icon: GitBranch,
  },
  {
    name: 'RustCC',
    description: 'Rust 中文社区讨论与实践',
    url: 'https://rustcc.cn/',
    icon: Globe2,
  },
  {
    name: 'CodeReset',
    description: '开发工具与前沿项目分享',
    url: 'https://code-reset.com/',
    icon: Globe2,
  },
  {
    name: 'Hugging Face',
    description: '模型、数据集与 Spaces',
    url: 'https://huggingface.co/',
    icon: Search,
  },
  {
    name: 'OpenAlex',
    description: 'Papers and scholarly works',
    url: 'https://openalex.org/',
    icon: BookOpen,
  },
  {
    name: 'GHFind',
    description: '发现有趣的 GitHub 项目',
    url: 'https://ghfind.com/',
    icon: Search,
  },
]

export function ResearchSourcesCard() {
  const { t } = useTranslation()

  return (
    <Card size='sm'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <Search className='text-primary size-4' />
          {t('Research sources')}
        </CardTitle>
        <CardDescription className='text-xs leading-5'>
          {t(
            'Search GitHub/Hugging Face for technical discovery. OpenAlex is searched only for paper queries. RustCC, CodeReset and GHFind are links, not indexed sources. Provide a public HTTPS URL for browser reading when CORS allows. No cookies are sent.'
          )}
        </CardDescription>
        <CardDescription className='text-xs leading-5'>
          {t(
            'Paste a public HTTPS URL into chat to read it. Results in the search popover go to the model only after you add them to the message.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-1.5'>
        {SOURCES.map((source) => {
          const Icon = source.icon

          return (
            <Button
              className='h-auto min-h-8 justify-start gap-2 px-2 text-left'
              key={source.name}
              render={<a href={source.url} rel='noreferrer' target='_blank' />}
              size='sm'
              variant='ghost'
            >
              <Icon className='size-3.5 shrink-0' />
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-xs'>{t(source.name)}</span>
                <span className='text-muted-foreground block truncate text-[10px]'>
                  {t(source.description)}
                </span>
              </span>
              <ExternalLink className='text-muted-foreground size-3 shrink-0' />
            </Button>
          )
        })}
      </CardContent>
    </Card>
  )
}
