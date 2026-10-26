window.__ModuleLoader__.load({
  id: 'ofm-credits',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE = '/ofm-credits/state'
    /** How often the strip re-reads state while the page is open. */
    const POLL_MS = 30_000

    /**
     * Read the model the composer has selected right now.
     *
     * The Host cannot know this. A selection becomes durable only once a request
     * is actually dispatched, so a freshly picked model sits in `pending` and is
     * invisible from Node. The composer state is the only place the pending
     * choice exists, so the strip reports it on demand.
     */
    function readComposerModel(input) {
      if (!input || typeof input !== 'object') return null
      const candidates = [input.modelSelection, input.selection, input.model, input.selectedModel]
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue
        if (typeof candidate.provider === 'string' && typeof candidate.model === 'string') {
          return { provider: candidate.provider, model: candidate.model }
        }
        for (const key of ['pending', 'lastUsed']) {
          const value = candidate[key]
          if (value && typeof value.provider === 'string' && typeof value.model === 'string') {
            return { provider: value.provider, model: value.model }
          }
        }
      }
      return null
    }

    const fmtCredits = (value) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return '--'
      // Credits are whole-ish counts; keep two decimals only when they carry them.
      return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
    }

    /**
     * The credits strip above the composer.
     *
     * It owns its data end to end: this plugin reads the channel's credits and
     * renders them here, so nothing depends on another plugin's cached copies.
     */
    function CreditsStrip(props) {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const useInput = props.useInput
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      let input
      try {
        input = typeof useInput === 'function' ? useInput((value) => value) : undefined
      } catch {
        input = undefined
      }

      const load = React.useCallback(
        async (force) => {
          const picked = readComposerModel(input)
          const params = new URLSearchParams()
          if (sessionId) params.set('session', sessionId)
          // Name the composer's choice explicitly: a not-yet-used model never
          // reaches the Host's durable record, so this is the only way the strip
          // can follow the selector before the next message is sent.
          if (picked) {
            params.set('provider', picked.provider)
            params.set('model', picked.model)
          }
          if (force) params.set('refresh', '1')
          try {
            const response = await fetch(`${STATE}?${params.toString()}`, { cache: 'no-store' })
            const body = await response.json().catch(() => null)
            if (!alive.current) return
            if (!response.ok || !body || body.ok !== true) {
              setState({ error: '读取失败' })
              return
            }
            setState(body)
          } catch {
            if (alive.current) setState({ error: '读取失败' })
          }
        },
        [input, sessionId],
      )

      React.useEffect(() => {
        void load(false)
        const timer = setInterval(() => void load(false), POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const press = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setNote('')
        try {
          await load(true)
          if (alive.current) setNote('已刷新')
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [busy, load])

      React.useEffect(() => {
        if (!note) return undefined
        const timer = setTimeout(() => setNote(''), 3000)
        return () => clearTimeout(timer)
      }, [note])

      const idle = !state || state.idle === true
      const label = state && state.label ? state.label : ''
      const credits = state && state.credits !== null && state.credits !== undefined ? state.credits : null
      const error = state && state.error ? String(state.error) : ''
      // A channel's balance is not always a credit count: Cline reports USD, so
      // a bare number would read as "5 credits" for five dollars.
      const currency = state && state.currency ? String(state.currency) : ''
      const unit = currency === 'USD' ? '$' : ''
      const figure = credits === null ? '' : `${unit}${fmtCredits(credits)}`

      let text
      if (idle) text = '积分 —'
      else if (credits !== null) text = `${label} 积分 ${fmtCredits(credits)}`
      else text = label ? `${label} 积分 —` : '积分 —'

      // The label reads as ordinary header text; the figure carries the brand
      // blue so the number is what stands out, not the button.
      //
      // Plain colours, not the `--dsw-alias-*` theme tokens: those resolved to
      // the inherited foreground here, which painted the figure white. Header
      // chrome inherits normally, and the accent is fixed so it stays blue in
      // both themes.
      const labelColor = 'inherit'
      const ACCENT = '#4d6bfe'
      const figureColor = error ? 'inherit' : credits !== null ? ACCENT : 'inherit'

      const hint = error
        ? error
        : state && state.model
          ? `当前模型 ${state.provider}/${state.model}`
          : '读取当前模型所属渠道的积分'

      return h(
        React.Fragment,
        null,
        // Scoped keyframes: rendering them as an element means unmounting removes
        // them, with no stylesheet bookkeeping of our own.
        h(
          'style',
          null,
          '@keyframes ofm-credits-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '2px',
              marginLeft: '8px',
              // Compact: this lives inside the header strip, so it must not add
              // vertical bulk of its own.
              padding: 0,
              fontSize: '12px',
              lineHeight: '18px',
              whiteSpace: 'nowrap',
              color: labelColor,
            },
          },
          h(
            'span',
            { title: hint },
            h(
              'span',
              null,
              idle || credits === null ? text : currency === 'USD' ? `${label} 余额 ` : `${label} 积分 `,
            ),
            idle || credits === null
              ? null
              : h('span', { style: { color: figureColor, fontWeight: 600 } }, figure),
            error
              ? h('span', { style: { marginLeft: '6px', opacity: 0.7 } }, `（${error}）`)
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: press,
              disabled: busy,
              title: note || hint,
              'aria-label': '刷新积分',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 2px',
                border: 'none',
                background: 'transparent',
                // Same colour as the surrounding header text: the button is chrome,
                // not a call to action. It flashes the accent while working so the
                // press is visible without a label.
                color: busy || note ? ACCENT : 'inherit',
                fontSize: '13px',
                lineHeight: '18px',
                cursor: busy ? 'progress' : 'pointer',
                whiteSpace: 'nowrap',
              },
            },
            h(
              'span',
              {
                'aria-hidden': true,
                style: busy
                  ? {
                      display: 'inline-block',
                      animation: 'ofm-credits-spin 900ms linear infinite',
                    }
                  : { display: 'inline-block' },
              },
              '⟳',
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Title-adjacent header actions: this sits in the header strip beside the
        // session title, which is the empty band the user pointed at. It is a
        // `replaceRisk: none` list, so it adds a cell rather than shadowing
        // shipped chrome.
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.actions', id: 'ofm-credits', order: 25 },
            CreditsStrip,
          ),
        )
      },
    }
  },
})
