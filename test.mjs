/**
 * Offline test for the plugin's read path.
 *
 * Mocks the Host context and a channel-pack reply, then drives the real
 * `agent/request` waterfall and the state route: the channel is derived from
 * the session's model, the credits come from the mocked RPC, and a session with
 * a different model resolves to a different channel.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credits-test-'))
process.env.DSH_HOME = home

const CREDITS = { trae: 1700.5, codearts: 8300, minimax: 2222, cline: 5 }
/** Cline reports its balance in USD, not as a credit count. */
const UNITS = { cline: 'usd' }

/** Accounts the stub pool reports; the test appends to this to add a channel. */
const poolAccounts = []

/** A Host context stub: only what `apply` actually touches. */
function fakeContext() {
  const handlers = new Map()
  const routes = []
  const effects = []
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'accountPool') {
        // Mirrors the real pool: `getStateSnapshot` re-reads state each call, so
        // a channel added after startup is visible on the next lookup.
        return {
          getStateSnapshot: () => ({ accounts: poolAccounts.map((a) => ({ ...a })) }),
        }
      }
      if (name === 'connection') {
        return {
          browserPeer: { id: 'test-peer' },
          createSharedFetchHandler() {
            return {
              async fetch(_request) {
                // The RPC envelope carries the channel; answer with its credits.
                const compiled = String(_request.callsChannel || '')
                const channel = compiled
                return new Response(
                  JSON.stringify({
                    type: 'server-response',
                    rpcId: 't',
                    result: {
                      ok: true,
                      value: {
                        accounts: [
                          {
                            accountId: 'a1',
                            balance: {
                              total: CREDITS[channel] ?? 0,
                              packages: [{ name: 'p', unit: UNITS[channel] ?? 'credits' }],
                              expiredTotal: 0,
                            },
                          },
                        ],
                      },
                    },
                  }),
                  { status: 200, headers: { 'content-type': 'application/json' } },
                )
              },
            }
          },
        }
      }
      if (name === 'webServer') {
        return {
          getOrigin: () => 'http://127.0.0.1:1',
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      handlers.set(event, listener)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    handlers,
    routes,
  }
}

// The RPC body names the channel; expose it to the fetch stub so the mock can
// answer with that channel's figure.
const realRequest = globalThis.Request
globalThis.Request = class extends realRequest {
  constructor(input, init) {
    super(input, init)
    try {
      this.callsChannel = JSON.parse(init?.body ?? '{}')?.payload?.payload?.provider ?? ''
    } catch {
      this.callsChannel = ''
    }
  }
}

const { apply } = await import('./index.js')

/** Drive one model request through the waterfall. */
async function request(ctx, sessionId, provider, model) {
  const handler = ctx.handlers.get('agent/request')
  assert.ok(handler, 'the plugin listens to agent/request')
  return handler(
    { agent: { id: sessionId }, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ provider, model }),
  )
}

/** Call the state route the Client half uses. */
async function state(ctx, sessionId, query = '') {
  const route = ctx.routes.find((r) => r.path === '/ofm-credits')
  assert.ok(route, 'the state route was registered')
  const headers = { host: '127.0.0.1:1' }
  const url = `/ofm-credits/state?session=${encodeURIComponent(sessionId)}${query}`
  const result = await new Promise((resolve) => {
    const res = {
      writeHead() {},
      end(body) {
        resolve(JSON.parse(body))
      },
    }
    route.handler({ method: 'GET', url, headers, socket: { remoteAddress: '127.0.0.1' } }, res)
  })
  return result
}

const ctx = fakeContext()
apply(ctx, { pollMs: 600_000 })

// A trae session resolves to the trae channel and its credits.
await request(ctx, 'session-a', 'trae', 'deepseek-v4.1-flash')
await new Promise((r) => setTimeout(r, 30))
const a = await state(ctx, 'session-a')
assert.equal(a.channel, 'trae', 'trae session resolves to the trae channel')
assert.equal(a.label, 'TRAE', 'the channel is labelled with its display name')
assert.equal(a.credits, CREDITS.trae, 'credits come from the channel')

// A second session on another model resolves independently — this is the bug
// that made one window show another window's channel.
await request(ctx, 'session-b', 'codearts', 'GLM-5.2')
await new Promise((r) => setTimeout(r, 30))
const b = await state(ctx, 'session-b')
assert.equal(b.channel, 'codearts', 'the codearts session resolves to its own channel')
assert.equal(b.credits, CREDITS.codearts, 'and its own credits')

// The first window still answers for itself, not for the most recent session.
const aAgain = await state(ctx, 'session-a')
assert.equal(aAgain.channel, 'trae', 'an older window keeps its own channel')

// An explicit model from the composer selector overrides the recorded one.
const explicit = await state(ctx, 'session-a', '&provider=minimax&model=MiniMax-M3.1-Flash')
assert.equal(explicit.channel, 'minimax', 'the composer selection wins before it is dispatched')
assert.equal(explicit.credits, CREDITS.minimax, 'and reads that channel credits')

// A model with no OFM channel behind it says so instead of showing a figure.
await request(ctx, 'session-c', 'deepseek', 'DeepSeek-V4-Pro')
await new Promise((r) => setTimeout(r, 30))
const c = await state(ctx, 'session-c')
assert.equal(c.channel, '', 'no channel is claimed for a non-OFM model')
assert.equal(c.credits, null, 'and no figure is shown')
assert.match(String(c.error), /渠道/, 'the strip gets a reason to display')

// Channel mapping must not guess from a bare vendor name on an aggregate lane.
const aggregate = await state(
  ctx,
  'session-a',
  '&provider=our-free-model&model=glm-5.3-flash-free',
)
assert.equal(aggregate.channel, '', 'a bare glm model is not treated as a ZCode account')

// A channel whose balance is money, not a credit count, keeps its unit.
const money = await state(ctx, 'session-a', '&provider=cline&model=cline-free')
assert.equal(money.channel, 'cline', 'the cline channel resolves')
assert.equal(money.currency, 'USD', 'and reports USD, so the figure is not read as credits')
assert.equal(money.credits, CREDITS.cline, 'with its dollar balance')

// A channel this file has never heard of, added to the pack after startup, is
// picked up from the live pool — the point of not hard-coding the roster.
CREDITS.newsome = 777
poolAccounts.push({ id: 'acc-new', provider: 'newsome', nickname: 'new' })
const fresh = await state(ctx, 'session-a', '&provider=newsome&model=whatever')
assert.equal(fresh.channel, 'newsome', 'a newly added channel resolves without a code change')
assert.equal(fresh.credits, 777, 'and its credits are read like any other channel')
assert.equal(fresh.label, 'newsome', 'an unknown channel falls back to its id as the label')

console.log('PASS: per-session channels, explicit composer override, honest gaps')
console.log('  trae    ', JSON.stringify({ channel: a.channel, credits: a.credits }))
console.log('  codearts', JSON.stringify({ channel: b.channel, credits: b.credits }))
console.log('  dynamic ', JSON.stringify({ channel: fresh.channel, credits: fresh.credits }))
fs.rmSync(home, { recursive: true, force: true })
