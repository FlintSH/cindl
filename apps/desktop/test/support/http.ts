/** Raw HTTP for loopback-listener tests: full control over the Host header and target. */
import http from 'node:http'

/** A raw GET with full control over the Host header (fetch does not allow that). */
export function rawGet(
  port: number,
  target: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: target, method, headers, agent: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}
