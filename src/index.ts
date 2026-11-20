import { ACTIONS } from "./domain/actions.js"
import { createBigQueryPlugin } from "./plugin.js"
import { HANDLERS, isModelTool, toolSpecs } from "./registry.js"
import { createPorts } from "./wiring.js"

export default createBigQueryPlugin({
  specs: (options, released) => toolSpecs(options, createPorts(options, released)),
  isModelTool,
  notBuilt: ACTIONS.filter((entry) => entry.kind === "tool" && !(entry.name in HANDLERS)).length,
})
