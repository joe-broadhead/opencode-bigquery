/** A real loopback GET, for the sign-in listener; `fetch` is the test's faked Google and must not see it. */
import { get as httpGet, request } from "node:http"
import { createServer } from "node:net"

export async function loopbackGet(url: string): Promise<{ readonly status: number; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const request_ = httpGet(url, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => (body += chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request_.on("error", reject)
    request_.end()
  })
}

/** A port nothing is listening on, for the relay test's callbackPort. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = address && typeof address === "object" ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** One HTTP request, used only when a test needs a non-GET method. */
export function requestOnce(url: string, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode ?? 0))
    })
    req.on("error", reject)
    req.end()
  })
}
