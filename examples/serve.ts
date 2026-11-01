const root = import.meta.dir
const port = Number(process.env.PORT ?? 8080)
Bun.serve({
  port,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname)
    const file = Bun.file(`${root}${path.endsWith('/') ? path + 'index.html' : path}`)
    if (path.includes('..') || !(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(file)
  },
})
console.log(`SVV demo: http://localhost:${port}/`)
