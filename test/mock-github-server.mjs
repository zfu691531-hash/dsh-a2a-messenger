// Minimal in-memory mock of the GitHub REST endpoints used by GitHubTransport.
import { createServer } from 'node:http'

export function startMockGitHub({ port = 0, tokens = {} } = {}) {
  // tokens: { 'tok-alice': 'alice', ... }
  const issues = [] // { number, title, labels: [], comments: [{id, body, user, created_at}] }
  let nextIssue = 1
  let nextComment = 1

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => (data += chunk))
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

  function loginOf(req) {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    return tokens[token]
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const login = loginOf(req)
    if (!login) return json(res, 401, { message: 'Bad credentials' })

    try {
      if (req.method === 'GET' && url.pathname === '/user') {
        return json(res, 200, { login })
      }

      // /repos/{owner}/{name}/...
      const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/)
      if (!m) return json(res, 404, { message: 'not found' })
      const rest = m[2] ?? ''

      if (req.method === 'GET' && rest === '/collaborators') {
        return json(res, 200, Object.values(tokens).map((l) => ({ login: l })))
      }

      if (req.method === 'GET' && rest === '/issues') {
        return json(
          res,
          200,
          issues.map((i) => ({ number: i.number, title: i.title, labels: i.labels })),
        )
      }

      if (req.method === 'POST' && rest === '/issues') {
        const body = await readBody(req)
        const issue = {
          number: nextIssue++,
          title: body.title,
          labels: (body.labels ?? []).map((l) => ({ name: l })),
          comments: [],
        }
        issues.push(issue)
        return json(res, 201, { number: issue.number, title: issue.title })
      }

      const cm = rest.match(/^\/issues\/(\d+)\/comments$/)
      if (cm) {
        const issue = issues.find((i) => i.number === Number(cm[1]))
        if (!issue) return json(res, 404, { message: 'issue not found' })

        if (req.method === 'POST') {
          const body = await readBody(req)
          const comment = {
            id: nextComment++,
            body: body.body,
            user: { login },
            created_at: new Date().toISOString(),
          }
          issue.comments.push(comment)
          return json(res, 201, comment)
        }

        if (req.method === 'GET') {
          const since = url.searchParams.get('since')
          const list = since
            ? issue.comments.filter((c) => c.created_at > since)
            : issue.comments
          return json(res, 200, list)
        }
      }

      return json(res, 404, { message: 'not found' })
    } catch (err) {
      return json(res, 500, { message: String(err) })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state: { issues },
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}
