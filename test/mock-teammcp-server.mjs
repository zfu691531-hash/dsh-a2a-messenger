// In-memory mock of the TeamMCP relay endpoints used by this plugin.
// Doubles as a local dev fixture: `npm run mock-server` starts it on :3100.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

export function startMockTeamMcp({ port = 0, registerSecret } = {}) {
  const agentsByToken = new Map() // token -> { name, role }
  const tokensByName = new Map() // name -> token
  const inboxes = new Map() // name -> message[]
  const sseClients = new Map() // name -> Set<res>
  const channels = ['general']
  const sentLog = []

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
      })
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  function authAgent(req) {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    return token ? agentsByToken.get(token) : undefined
  }

  function deliver(recipient, message) {
    const online = sseClients.get(recipient)
    if (online && online.size > 0) {
      for (const res of online) {
        res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
      }
    } else {
      if (!inboxes.has(recipient)) inboxes.set(recipient, [])
      inboxes.get(recipient).push(message)
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    try {
      if (route === 'GET /api/health') return json(res, 200, { ok: true })

      if (route === 'POST /api/register') {
        const body = await readBody(req)
        if (registerSecret && body.secret !== registerSecret) {
          return json(res, 403, { error: 'bad secret' })
        }
        if (typeof body.name !== 'string' || body.name.length === 0) {
          return json(res, 400, { error: 'name required' })
        }
        if (tokensByName.has(body.name)) return json(res, 409, { error: 'name taken' })
        const apiKey = `tmcp_${randomUUID().replaceAll('-', '')}`
        agentsByToken.set(apiKey, { name: body.name, role: body.role ?? '' })
        tokensByName.set(body.name, apiKey)
        return json(res, 200, { apiKey, agent: { name: body.name, role: body.role ?? '' } })
      }

      const agent = authAgent(req)
      if (!agent) return json(res, 401, { error: 'unauthorized' })

      if (route === 'POST /api/send') {
        const body = await readBody(req)
        if (typeof body.content !== 'string' || body.content.length === 0) {
          return json(res, 400, { error: 'content required' })
        }
        const message = {
          id: randomUUID(),
          from: agent.name,
          channel: typeof body.channel === 'string' ? body.channel : undefined,
          to: typeof body.to === 'string' ? body.to : undefined,
          content: body.content,
          ts: Date.now(),
        }
        sentLog.push(message)
        if (message.to) {
          if (!tokensByName.has(message.to)) return json(res, 404, { error: 'unknown recipient' })
          deliver(message.to, message)
        } else if (message.channel) {
          for (const name of tokensByName.keys()) {
            if (name !== agent.name) deliver(name, message)
          }
        } else {
          return json(res, 400, { error: 'channel or to required' })
        }
        return json(res, 200, { id: message.id, ts: message.ts })
      }

      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        if (!sseClients.has(agent.name)) sseClients.set(agent.name, new Set())
        sseClients.get(agent.name).add(res)
        req.on('close', () => {
          sseClients.get(agent.name)?.delete(res)
        })
        return
      }

      if (route === 'GET /api/inbox') {
        return json(res, 200, { messages: inboxes.get(agent.name) ?? [] })
      }

      if (route === 'POST /api/inbox/ack') {
        inboxes.set(agent.name, [])
        return json(res, 200, { ok: true })
      }

      if (route === 'GET /api/agents') {
        const list = [...tokensByName.keys()].map((name) => ({
          name,
          role: [...agentsByToken.values()].find((a) => a.name === name)?.role,
          online: (sseClients.get(name)?.size ?? 0) > 0,
        }))
        return json(res, 200, { agents: list })
      }

      if (route === 'GET /api/channels') {
        return json(res, 200, { channels: channels.map((name) => ({ name })) })
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: String(err) })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        state: { agentsByToken, tokensByName, inboxes, sseClients, sentLog },
        close: () =>
          new Promise((done) => {
            for (const set of sseClients.values()) for (const res of set) res.end()
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

if (process.argv.includes('--standalone')) {
  const port = Number(process.env.PORT ?? 3100)
  const { url } = await startMockTeamMcp({ port })
  console.log(`mock TeamMCP relay listening on ${url}`)
}
