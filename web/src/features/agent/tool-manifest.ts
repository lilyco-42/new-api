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
import {
  FileCode2,
  Folder,
  GitBranch,
  Network,
  ScanSearch,
  type LucideIcon,
} from 'lucide-react'

export type AgentToolProtocol = 'cli' | 'mcp' | 'builtin'

export const AGENT_TOOL_MANIFEST_VERSION = 1 as const

export type AgentToolManifest = {
  id: string
  protocol: AgentToolProtocol
  name: string
  description: string
  capabilities: string[]
  command: string
  installCommand: string
  url?: string
  icon: LucideIcon
}

/**
 * The UI is driven by this manifest. The desktop adapter only accepts the
 * corresponding ids, so adding a tool does not require a new UI component or
 * a new Tauri command.
 */
export const AGENT_TOOL_MANIFEST: AgentToolManifest[] = [
  {
    id: 'gh',
    protocol: 'cli',
    name: 'GitHub CLI',
    description: '用 gh 查看仓库、Issue、Pull Request 和项目趋势。',
    capabilities: ['repo.read', 'issues.read', 'pulls.read'],
    command: 'gh auth status',
    installCommand: 'winget install GitHub.cli',
    url: 'https://cli.github.com/manual/',
    icon: GitBranch,
  },
  {
    id: 'yazi',
    protocol: 'cli',
    name: 'Yazi',
    description:
      'Rust 终端文件管理器；Agent 文件浏览使用独立的受限工作区接口。',
    capabilities: ['terminal.ui'],
    command: 'yazi',
    installCommand: 'cargo binstall yazi-fm',
    url: 'https://yazi-rs.github.io/docs/installation',
    icon: Folder,
  },
  {
    id: 'workspace-files',
    protocol: 'builtin',
    name: '工作区文件浏览',
    description: '在管理员指定的目录内只读浏览和预览文本文件；预览前需要确认。',
    capabilities: ['files.browse', 'files.preview'],
    command: 'files.browse · files.preview',
    installCommand: '配置 LAIN42_AGENT_WORKSPACE',
    icon: Folder,
  },
  {
    id: 'jj',
    protocol: 'cli',
    name: 'Jujutsu (jj)',
    description: 'Git 兼容的版本控制工具，适合小步提交和并行实验。',
    capabilities: ['vcs.history', 'vcs.change'],
    command: 'jj',
    installCommand: 'cargo binstall jj-cli',
    url: 'https://docs.jj-vcs.dev/latest/install-and-setup/',
    icon: GitBranch,
  },
  {
    id: 'ast-grep',
    protocol: 'cli',
    name: 'ast-grep',
    description: '按语法树搜索、检查和重写代码，适合安全批量重构。',
    capabilities: ['code.search', 'code.rewrite'],
    command: 'ast-grep',
    installCommand: 'cargo binstall ast-grep',
    url: 'https://ast-grep.github.io/guide/quick-start.html',
    icon: ScanSearch,
  },
  {
    id: 'codegraph',
    protocol: 'cli',
    name: 'CodeGraph',
    description: '为代码库建立知识图谱，探索符号、调用链和影响范围。',
    capabilities: ['code.graph', 'code.impact'],
    command: 'codegraph explore "目标符号或问题"',
    installCommand: 'codegraph init .',
    icon: Network,
  },
  {
    id: 'ast-grep-mcp',
    protocol: 'mcp',
    name: 'ast-grep MCP',
    description: '把结构化代码搜索暴露给支持 MCP 的 Agent。',
    capabilities: ['mcp.tools'],
    command: 'ast-grep-mcp',
    installCommand: 'cargo binstall ast-grep-mcp',
    url: 'https://github.com/ast-grep/ast-grep',
    icon: FileCode2,
  },
  {
    id: 'lilyco',
    protocol: 'mcp',
    name: 'Lilyco framework',
    description:
      '同一份 Rust schema 可渲染 CLI、TUI、Web 和 MCP，适合长期扩展工具。',
    capabilities: ['mcp.tools', 'schema.shared', 'agent.extensions'],
    command: 'lilyco --mcp',
    installCommand: 'cargo binstall lilyco',
    url: 'https://github.com/lilyco-42/lilyco',
    icon: Network,
  },
]
