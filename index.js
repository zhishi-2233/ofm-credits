/**
 * ofm-credits
 *
 * Shows the credit balance of the Our Free Model channel behind the model this
 * session is using, in a strip above the composer, with a refresh button.
 *
 * It deliberately touches no other plugin: earlier versions wrote the figure
 * into dsh-whale-widget's private data files, which meant fighting that widget's
 * cached copies and gave no reliable refresh path. This version owns the whole
 * path — read the channel, read its credits, render it itself.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOG_FILE = path.join(DSH_HOME, 'ofm-credits.log')
const LOG_LIMIT_BYTES = 256 * 1024

const CHANNEL_PACK_PATH = '/api/channel-pack'
const RPC_METHOD = 'channel-pack'

/**
 * Provider route -> OFM channel id that holds its accounts and credits.
 * Keys are the `llm` provider routes OFM registers (its own two, plus the
 * channel ids the absorbed Free Channel pack registers directly).
 */
const PROVIDER_CHANNEL = {
  'our-free-model': '',
  'our-free-model-region': '',
  trae: 'trae',
  cline: 'cline',
  codearts: 'codearts',
  buddy: 'buddy',
  workbuddy: 'workbuddy',
  lobsterai: 'lobsterai',
  qoder: 'qoder',
  qodercn: 'qodercn',
  loomy: 'loomy',
  raccoon: 'raccoon',
  minimax: 'minimax',
  zcode: 'zcode',
  gemini: 'gemini',
  opencode: 'opencode',
}

/**
 * The aggregate lanes name their upstream in the model id itself
 * (`minimax/minimax-m3.1-flash:free`, `kilo-auto/free`, ...). These recover the
 * channel when the provider route alone does not.
 *
 * A bare vendor name in a model id is NOT evidence of a channel: `glm-5.3-flash-free`
 * on the aggregate lane is not a ZCode account. Each hint therefore requires the
 * channel's own identity, and an unmatched lane reports "no channel".
 */
const MODEL_CHANNEL_HINTS = [
  [/opencode|kilo-auto|\bkilo\b/, 'opencode'],
  [/codearts/, 'codearts'],
  [/lobsterai/, 'lobsterai'],
  [/qodercn/, 'qodercn'],
  [/\bqoder\b/, 'qoder'],
  [/workbuddy/, 'workbuddy'],
  [/\bbuddy\b/, 'buddy'],
  [/\btrae\b/, 'trae'],
  [/\bcline\b/, 'cline'],
  [/\bloomy\b/, 'loomy'],
  [/\braccoon\b/, 'raccoon'],
  [/minimax/, 'minimax'],
  [/zcode/, 'zcode'],
  [/gemini/, 'gemini'],
]

/** Channel display names, matching the Free Channel pack's own `displayName`. */
const CHANNEL_LABELS = {
  codearts: 'CodeArts',
  trae: 'TRAE',
  cline: 'Cline',
  buddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  lobsterai: 'LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder 中国版',
  loomy: 'Loomy',
  raccoon: 'Raccoon',
  minimax: 'MiniMax',
  zcode: 'ZCode',
  gemini: 'Gemini',
  opencode: 'OpenCode',
}

/**
 * Channel label for display: the pack's own name when known, else the id.
 * A channel the static table has never heard of still renders as its id, so a
 * newly added one is readable before this file learns its display name.
 */
function channelLabel(channel, liveLabels) {
  if (!channel) return ''
  return (liveLabels && liveLabels[channel]) || CHANNEL_LABELS[channel] || channel
}

/**
 * Resolve an `llm` provider route plus model id to an OFM channel id.
 *
 * `knownChannels` is the live set the pack reports having accounts for. A route
 * that is unknown to the static table but present there is still accepted, which
 * is what makes a newly added channel work without editing this file.
 */
function channelOf(provider, model, knownChannels) {
  const route = String(provider || '')
  const direct = PROVIDER_CHANNEL[route]
  if (direct) return direct
  if (knownChannels && knownChannels.has(route)) return route
  const hay = `${route} ${model || ''}`.toLowerCase()
  for (const [re, channel] of MODEL_CHANNEL_HINTS) if (re.test(hay)) return channel
  return ''
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const pollMs = Math.max(30_000, Number(config.pollMs) || 120_000)
  let logSize = -1

  /** Append one diagnostic line, capped so a long-running host cannot grow it. */
  function log(message) {
    try {
      if (logSize < 0) {
        try {
          logSize = fs.statSync(LOG_FILE).size
        } catch {
          logSize = 0
        }
      }
      const line = `${new Date().toISOString()} ${message}\n`
      if (logSize + line.length > LOG_LIMIT_BYTES) {
        const existing = fs.readFileSync(LOG_FILE, 'utf8')
        const kept = existing.slice(Math.floor(existing.length / 2))
        fs.writeFileSync(LOG_FILE, kept.slice(kept.indexOf('\n') + 1), 'utf8')
        logSize = fs.statSync(LOG_FILE).size
      }
      fs.appendFileSync(LOG_FILE, line, 'utf8')
      logSize += line.length
    } catch {}
    logger?.info?.(`[ofm-credits] ${message}`)
  }

  /**
   * The channels the Free Channel pack has accounts for, read live.
   *
   * The pack exposes its account pool on the Host context, and that pool reads
   * its state file on every call. So a channel the user adds is visible on the
   * next lookup with no restart and nothing to edit here — which is the whole
   * point of not hard-coding the roster.
   *
   * The static table stays as a fallback: if the pool is missing (an older pack,
   * or a composition without it) channel resolution still works for the
   * channels this file knows about.
   */
  function discoverChannels() {
    const known = new Set()
    const labels = {}
    try {
      const pool = ctx.get('accountPool')
      // `getStateSnapshot()` is the pool's synchronous full read. Its
      // `listAllAccounts()` sibling is async, so it cannot be used here.
      let accounts = []
      if (pool && typeof pool.getStateSnapshot === 'function') {
        const snapshot = pool.getStateSnapshot()
        accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : []
      }
      for (const account of accounts) {
        const provider = String(account?.provider || '')
        if (!provider) continue
        known.add(provider)
        // The pool entry carries the account, not the product; fall back to
        // the static label table and then to the raw id.
        if (!labels[provider] && CHANNEL_LABELS[provider]) {
          labels[provider] = CHANNEL_LABELS[provider]
        }
      }
    } catch (error) {
      log(`channel discovery failed: ${String(error?.message || error)}`)
    }
    return { known, labels }
  }

  /** Cache with a short life: discovery is cheap, but not free per request. */
  let channelCache = { at: 0, known: new Set(), labels: {} }
  function channels(force = false) {
    if (!force && Date.now() - channelCache.at < 15_000) return channelCache
    const found = discoverChannels()
    channelCache = { at: Date.now(), known: found.known, labels: found.labels }
    return channelCache
  }

  /**
   * Per-session model record.
   *
   * `llm/stream` is process-wide (it also fires for subagents, title generation
   * and compaction), so "the last call anywhere" is not "this window's model".
   * The `agent/request` waterfall carries the exact agent and the config it is
   * about to dispatch, which is the only trustworthy per-window source.
   */
  const sessionModels = new Map() // sessionId -> { provider, model, at }
  let latestSession = ''
  /** Last reading, so the UI has something to show between fetches. */
  let last = {
    sessionId: '',
    channel: '',
    label: '',
    credits: null,
    currency: '',
    provider: '',
    model: '',
    at: 0,
    error: '',
  }
  let timer = null
  let running = null

  ctx.on('agent/request', (payload, next) => {
    const pending = next()
    try {
      const sessionId = payload?.agent?.id ? String(payload.agent.id) : ''
      return Promise.resolve(pending).then((resolved) => {
        try {
          if (sessionId && resolved && resolved.provider) {
            sessionModels.set(sessionId, {
              provider: resolved.provider,
              model: resolved.model,
              at: Date.now(),
            })
            latestSession = sessionId
            log(`agent/request ${sessionId} -> ${resolved.provider}/${resolved.model}`)
            if (
              channelOf(resolved.provider, resolved.model, channels().known) !== last.channel
            ) {
              void refresh(sessionId)
            }
          }
        } catch {}
        return resolved
      })
    } catch {
      return pending
    }
  })

  /** The model recorded for one session, else the newest, else none. */
  function modelFor(sessionId) {
    const wanted = String(sessionId || '')
    if (wanted && sessionModels.has(wanted)) {
      return { sessionId: wanted, ...sessionModels.get(wanted) }
    }
    if (latestSession && sessionModels.has(latestSession)) {
      return { sessionId: latestSession, ...sessionModels.get(latestSession) }
    }
    let newest = null
    for (const [id, entry] of sessionModels) {
      if (!newest || entry.at > newest.at) newest = { sessionId: id, ...entry }
    }
    return newest
  }

  /** Ask OFM for one channel's credits through the Host's own Peer. */
  async function fetchCredits(channel) {
    const connection = ctx.get('connection')
    if (!connection || typeof connection.createSharedFetchHandler !== 'function') {
      return { ok: false, error: '读取服务不可用' }
    }
    const origin = ctx.get('webServer')?.getOrigin?.() || 'http://127.0.0.1'
    const handler = connection.createSharedFetchHandler('/api')
    const url = new URL(CHANNEL_PACK_PATH, origin).toString()
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: `ofm-credits-${Date.now()}`,
      method: RPC_METHOD,
      payload: { method: 'credits.balances', payload: { provider: channel } },
    })
    let response
    try {
      response = await handler.fetch(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
        connection.browserPeer,
      )
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const reply = await response.json().catch(() => null)
    const result = reply && reply.result
    if (!result || result.ok !== true) {
      return { ok: false, error: String(result?.error?.message || '渠道接口拒绝') }
    }
    // The RPC result is either `{ ok, value }` or the bare handler value.
    const value = result.value !== undefined ? result.value : result
    const accounts = Array.isArray(value?.accounts) ? value.accounts : []
    if (accounts.length === 0) {
      return { ok: false, error: `${channelLabel(channel, channels().labels)} 无账号` }
    }
    // A channel reports `balance` as `{ total, packages, expiredTotal }`; older
    // shapes may carry the bare number. Accept both.
    let credits = 0
    let readable = 0
    let firstError = ''
    let currency = ''
    for (const account of accounts) {
      const balance = account?.balance
      const total =
        typeof balance === 'number'
          ? balance
          : typeof balance?.total === 'number' && Number.isFinite(balance.total)
            ? balance.total
            : null
      if (total !== null) {
        credits += total
        readable += 1
        if (!currency && typeof balance?.packages?.[0]?.unit === 'string') {
          currency = balance.packages[0].unit.toLowerCase() === 'usd' ? 'USD' : 'CREDIT'
        }
      } else if (!firstError) {
        firstError = String(account?.error || '')
      }
    }
    if (readable === 0) {
      return { ok: false, error: firstError || '没有账号返回积分' }
    }
    return { ok: true, credits: Math.round(credits * 100) / 100, currency: currency || 'CREDIT' }
  }

  /**
   * Read the model for one session and refresh its channel's credits.
   *
   * `fresh` re-reads the pack's account list instead of using the short cache.
   * The button and the status route pass it so a channel the user just added is
   * recognised immediately, not up to 15 seconds later.
   */
  async function refresh(preferredSession = '', explicit = null, fresh = false) {
    // An explicit provider/model from the composer wins over the recorded one:
    // a model the user just picked has not been dispatched yet, so no Host-side
    // record can name it.
    const model =
      explicit && explicit.provider
        ? { sessionId: String(preferredSession || ''), ...explicit, at: Date.now() }
        : modelFor(preferredSession)
    if (!model) {
      last = {
        sessionId: String(preferredSession || ''),
        channel: '',
        label: '',
        credits: null,
        currency: '',
        provider: '',
        model: '',
        at: Date.now(),
        error: '',
        idle: true,
      }
      return last
    }
    // Discovery runs before resolution so a channel added since the last read is
    // known by the time the model is classified.
    const live = channels(fresh)
    const channel = channelOf(model.provider, model.model, live.known)
    if (!channel) {
      last = {
        sessionId: model.sessionId,
        channel: '',
        label: '',
        credits: null,
        currency: '',
        provider: model.provider,
        model: model.model,
        at: Date.now(),
        error: '当前模型不属于 Our Free Model 渠道',
      }
      log(`no channel for ${model.provider}/${model.model}`)
      return last
    }
    // Collapse concurrent reads of the same channel. Three callers can land here
    // within a second — the poll, a model request, and the strip's own status
    // read — and each one would otherwise hit the upstream separately.
    const pendingByChannel = new Map()
    const reading =
      pendingByChannel.get(channel) ||
      fetchCredits(channel).finally(() => pendingByChannel.delete(channel))
    pendingByChannel.set(channel, reading)
    const resolved = await reading
    last = {
      sessionId: model.sessionId,
      channel,
      label: channelLabel(channel, live.labels),
      credits: resolved.ok ? resolved.credits : null,
      currency: resolved.ok ? resolved.currency : '',
      provider: model.provider,
      model: model.model,
      at: Date.now(),
      error: resolved.ok ? '' : resolved.error,
    }
    log(
      resolved.ok
        ? `refresh ${channel}: credits=${resolved.credits} (${model.provider}/${model.model})`
        : `refresh ${channel}: ${resolved.error}`,
    )
    return last
  }

  ctx.effect(() => {
    timer = setInterval(() => {
      if (running) return
      running = refresh()
        .catch(() => last)
        .finally(() => {
          running = null
        })
    }, pollMs)
    timer.unref?.()
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  })

  /**
   * JSON state route behind the composer strip.
   *
   * `session` names the window the caller is looking at: several sessions run at
   * once on different models, and answering from a shared "latest" would make
   * one window show another's channel. `refresh=1` forces a fresh read.
   */
  ctx.effect(() => {
    const server = ctx.get('webServer')
    if (!server || typeof server.register !== 'function') {
      log('FATAL: webServer unavailable, state route NOT registered')
      return
    }
    const connection = ctx.get('connection')
    const dispose = server.register({
      kind: 'prefix',
      path: '/ofm-credits',
      handler: async (req, res) => {
        // Same-origin requests from the app's page carry the session cookie and
        // pass the Host's trust fence; a loopback caller is the local operator.
        const remote = String(req.socket?.remoteAddress || '')
        const loopback =
          remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        if (!loopback) {
          const rejection =
            connection && typeof connection.requestRejection === 'function'
              ? connection.requestRejection(req)
              : 403
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
            return
          }
        }
        const url = new URL(req.url || '/', 'http://localhost')
        const sessionParam = url.searchParams.get('session') || ''
        const force = url.searchParams.get('refresh') === '1'
        const explicitProvider = url.searchParams.get('provider') || ''
        const explicitModel = url.searchParams.get('model') || ''
        const explicit =
          explicitProvider !== ''
            ? { provider: explicitProvider, model: explicitModel }
            : null
        const send = (payload) => {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        }
        // The strip reads here; the button presses `refresh=1`.
        const stale = last.sessionId !== sessionParam
        // Read the pack's account list afresh here: this route backs both the
        // strip's periodic read and the button, and a channel added a moment ago
        // must resolve now rather than after the cache expires.
        const live = channels(true)
        const wanted = explicit ? channelOf(explicit.provider, explicit.model, live.known) : ''
        const channelMoved = wanted !== '' && wanted !== last.channel
        const state =
          force || stale || channelMoved
            ? await refresh(sessionParam, explicit, true)
            : last
        send({ ok: true, ...state })
      },
    })
    log(`state route registered at /ofm-credits (origin ${server.getOrigin?.() || '?'})`)
    return () => {
      try {
        dispose()
      } catch {}
    }
  })
}

/**
 * Dependencies. `webServer` must be live before `apply` runs, otherwise the
 * state route is silently never registered and the strip has nothing to read.
 * `connection` is only needed once a request actually refreshes, so it stays
 * lazily read inside `fetchCredits`.
 */
export const inject = ['webServer']
