// The server entry: one `register` call wires every method through the contract's doors (contract §9), and the accounts
// module registers one integration per alias. No door code, no tool registration, no permission rule is written here.
import { Plugin } from "@opencode/plugin";
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register";
import { registerPluginAccounts } from "./accounts.js";
import { type AuthContext, attachAuthHost, authHost, createAuthPort } from "./auth/index.js";
import { stateDirOf } from "./auth/keys.js";
import { createHandlers } from "./handlers/index.js";
import { manifest, version } from "./manifest.js";
import { loadOptions } from "./options.js";
import { createProvider } from "./provider/index.js";

export default Plugin.define({
  id: manifest.plugin.name,
  async setup(context) {
    // An untested host is refused before anything is registered, so it leaves no half-wired plugin behind.
    assertHost(context, manifest);
    const options = loadOptions(context.options);
    const stateDir = stateDirOf();
    const detach = attachAuthHost(options, authHost(context as unknown as AuthContext), stateDir);
    try {
      const auth = createAuthPort({ options, fetch: globalThis.fetch, stateDir });
      // The accounts' problems are recorded before `register`, never after it: status reads them from the handler's own
      // closure, not from state the registration wrote.
      const registered = await registerPluginAccounts({ context: context as never, options, fetch: globalThis.fetch, stateDir });
      const accountProblems = [...registered.problems];
      const ports = createProvider({ options, auth, fetch: globalThis.fetch, stateDir });
      const handlers = createHandlers({ manifest, ports, options, version, hostVersion: context.app.version, accountProblems });
      const registration = await register(context, manifest, handlers);
      return async () => {
        await registration.dispose();
        detach();
      };
    } catch (error) {
      detach();
      throw error;
    }
  },
});
