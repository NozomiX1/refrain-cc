// The mod's wiring, run by `claude plugin test .` (design.md 7.13). Nothing sits beneath the mod in a test: the
// hooks below stand for the engine, and core/cli.ts is answered from a table instead of a process.
import { expect, test } from 'claude-code/testing'

type Core = Record<string, (args: any) => unknown>
type Call = { cmd: string; args: any }

const TOOLS_MD = ['search', 'read', 'submit'].map((n) => `## ${n}\n\n\`\`\`\n${n} tool\n\`\`\`\n\n\`\`\`json\n{ "type": "object" }\n\`\`\`\n`).join('\n')
const DOCS: Record<string, string> = {
  'tools.md': `header\n---\n${TOOLS_MD}`,
  'scribe-system.md': 'header\n---\nyou are the scribe',
  'tool-results.md': '主模型调用 submit\n```\nsubmit is not for you\n```\n主模型用 Edit、Write\n```\nnot in the memory folder\n```\n',
}

function engine(on: any, table: Core = {}) {
  const calls: Call[] = []
  const agents: any[] = []
  const core: Core = { info: () => ({ home: '/home/user/.refrain' }), enable: () => ({ changed: null }), ...table }
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === '--version') return { value: { exitCode: 0, stdout: 'v24.1.0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const cmd = e.argv[2]
    const args = JSON.parse(e.init?.stdin ?? '{}')
    calls.push({ cmd, args })
    return { value: { exitCode: 0, stdout: JSON.stringify(core[cmd]?.(args) ?? {}), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_: any, e: any) => ({ value: DOCS[e.path.split('/').at(-1)] ?? '' }))
  on('session.id', () => ({ value: 'cc-1' }))
  on('session.root', () => ({ value: '/home/user/proj' }))
  on('tool.register', () => ({ value: {} }))
  on('agent.register', (_: any, e: any) => (agents.push(e), { value: {} }))
  on('command.register', () => ({ value: { command: 'refrain' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { calls, agents, of: (cmd: string) => calls.filter((c) => c.cmd === cmd) }
}

const start = ($: any) => $.session.start({ cwd: '/home/user/proj', surface: 'terminal', isInteractive: true })

test('the scribe is registered on Haiku at high effort, with only refrain\'s three tools', async ($: any, on: any) => {
  const { agents } = engine(on)
  await start($)
  expect(agents.length).toBe(1)
  expect(agents[0]).toMatchObject({ name: 'scribe', model: 'haiku', effort: 'high', omitClaudeMd: true, background: true, prompt: 'you are the scribe' })
  expect(agents[0].tools).toEqual(['mcp__refrain__search', 'mcp__refrain__read', 'mcp__refrain__submit'])
})

test('SessionStart gives the main session its briefing, and nothing again on resume or fork', async ($: any, on: any) => {
  engine(on, { briefing: () => ({ text: '# 记忆\n\nK1 先讨论再动手' }) })
  on('classic.SessionStart', () => ({}))
  await start($)
  for (const source of ['startup', 'clear', 'compact'] as const)
    expect((await $.classic.SessionStart({ source })).additionalContext).toEqual(['# 记忆\n\nK1 先讨论再动手'])
  for (const source of ['resume', 'fork'] as const) expect((await $.classic.SessionStart({ source })).additionalContext).toBeUndefined()
})

const msg = (role: 'user' | 'assistant', text: string) => ({ role, text, toolUses: [] })
const MESSAGES = [msg('user', 'first ask'), msg('assistant', 'first answer'), msg('user', 'tail starts here'), msg('assistant', 'last answer')]

test('compaction: auto and idle are refused, precompute skipped, a subagent left to CC, a manual one replaced by the handoff', async ($: any, on: any) => {
  let handoff: any = { status: 'ok', text: 'HANDOFF', tail: { turns: 1, firstText: 'tail starts here' } }
  engine(on, { handoff: () => handoff })
  on('session.compact', () => ({ messages: [msg('user', 'CC native summary')] }))
  await start($)
  for (const trigger of ['auto', 'idle', 'precompute'] as const) expect((await $.session.compact({ trigger, messages: MESSAGES })).skip).toBeDefined()
  expect((await $.session.compact({ trigger: 'manual', agentId: 'a9', messages: MESSAGES })).messages[0].text).toBe('CC native summary')
  const ours = await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: '重点保留' })
  expect(ours.messages.map((m: any) => m.text)).toEqual(['HANDOFF', 'tail starts here', 'last answer'])
  // The person's messages keep their handle; replies and tool results go back without one, so CC rebuilds them (e11).
  const tail = [{ ...msg('user', 'tail starts here'), handle: 'h1' }, { ...msg('assistant', 'reading'), toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }], handle: 'h2' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'file', isError: false }], handle: 'h3' }, { ...msg('assistant', ''), handle: 'h5' }, { ...msg('assistant', 'done'), handle: 'h4' }]
  const kept = (await $.session.compact({ trigger: 'manual', messages: [...MESSAGES.slice(0, 2), ...tail] })).messages
  expect(kept.map((m: any) => m.handle)).toEqual([undefined, 'h1', undefined, undefined, undefined])
  expect(kept[2].toolUses[0].tool_use_id).toBe('t1')
  expect(kept[3].toolResults[0].text).toBe('file')
  handoff = { status: 'skip', notice: 'refrain：暂不压缩。压缩后上下文不会明显减少。' }
  expect(await $.session.compact({ trigger: 'manual', messages: MESSAGES })).toEqual({ skip: 'refrain：暂不压缩。压缩后上下文不会明显减少。' })
  handoff = { status: 'native', reason: 'no user message to keep' }
  expect((await $.session.compact({ trigger: 'manual', messages: MESSAGES })).messages[0].text).toBe('CC native summary')
})

test('an idle compaction leaves its line once the compacted conversation starts, and only once', async ($: any, on: any) => {
  engine(on, { handoff: () => ({ status: 'ok', text: 'HANDOFF', tail: { turns: 1, firstText: 'tail starts here' }, notice: 'refrain：已自动压缩' }), briefing: () => ({ text: '' }) })
  const lines: string[] = []
  on('ui.log', (_: any, e: any) => (lines.push(e.text), { value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('session.compact', () => ({ messages: [] }))
  await start($)
  await $.session.compact({ trigger: 'plugin', messages: MESSAGES })
  expect(lines).toEqual([])
  await $.classic.SessionStart({ source: 'compact' })
  await $.classic.SessionStart({ source: 'compact' })
  expect(lines).toEqual(['refrain：已自动压缩'])
})

const ended = (agentId?: string) => ({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...(agentId && { agentId }) })

// A test cannot start a subagent (its id is the engine's to set), so the scribe's own steps (an accepted submit,
// its end finished with usage, its notice dropped) are checked in a real CC by the self-check, items 8 and 9.
test('a main turn asks for the scribe; one that does not start fails its run; the main model may not submit', async ($: any, on: any) => {
  const { of } = engine(on, {
    prepare: () => ({ status: 'ready', runId: 7, prompt: 'PROMPT' }),
    finish: () => ({ status: 'failed', paused: false }),
  })
  const spawned: any[] = []
  on('agent.spawn', (_: any, e: any) => (spawned.push(e), { model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'the engine ran it' }))
  on('prompt.submit', () => ({ text: 'passed on' }))
  on('ui.log', () => ({ value: undefined }))
  await start($)

  await $.turn.complete(ended())
  expect(spawned).toEqual([expect.objectContaining({ subagent_type: 'refrain:scribe', prompt: 'PROMPT', run_in_background: true })])
  expect(of('finish')).toEqual([{ cmd: 'finish', args: { runId: 7, error: expect.stringContaining('没能起书记员') } }])

  await $.turn.complete(ended('a9'))
  expect(of('prepare').length).toBe(1)
  expect(of('finish').length).toBe(1)

  const submission = { summaries: [], knowledge: [], state: null }
  expect((await $.tool.call({ tool: 'mcp__refrain__submit', ...submission })).deny).toBe('submit is not for you')
  expect((await $.tool.call({ tool: 'mcp__refrain__submit', agentId: 'a9', ...submission })).deny).toBe('submit is not for you')
  expect(of('submit')).toEqual([])
  expect((await $.prompt.submit({ text: 'a message from the user' })).drop).toBeUndefined()
})

test('the main model cannot write into refrain\'s data folder', async ($: any, on: any) => {
  engine(on)
  on('tool.call', () => ({ result: 'written' }))
  await start($)
  expect((await $.tool.call({ tool: 'Write', file_path: '/home/user/.refrain/memory.db', content: '' })).deny).toBe('not in the memory folder')
  expect((await $.tool.call({ tool: 'Write', file_path: '/home/user/proj/notes.md', content: '' })).result).toBe('written')
})
