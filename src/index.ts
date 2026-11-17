import { ACTIONS } from "./domain/actions.js"
import { createBigQueryPlugin } from "./plugin.js"
import { HANDLERS, isModelTool, toolSpecs } from "./registry.js"
import { createPorts } from "./wiring.js"

export default createBigQueryPlugin({
  specs: (options) => toolSpecs(options, createPorts(options)),
  isModelTool,
  notBuilt: ACTIONS.filter((entry) => entry.kind === "tool" && !(entry.name in HANDLERS)).length,
})
