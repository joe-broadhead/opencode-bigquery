// A port whose every method answers NOT_BUILT: what the plugin wires in until a package builds the real one.
import { BigQueryError } from "./domain/errors.js"

export function unbuilt<T extends object>(port: string, keep: Partial<T> = {}): T {
  return new Proxy(keep as T, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key)
      if (typeof key !== "string" || key === "then") return undefined
      return () => {
        throw new BigQueryError("NOT_BUILT", `The ${port} port's ${key} is not built yet`)
      }
    },
  })
}
