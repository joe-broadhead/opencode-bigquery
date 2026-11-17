import { createBigQueryPlugin } from "./plugin.js"
import { toolSpecs } from "./registry.js"

export default createBigQueryPlugin({ specs: toolSpecs })
