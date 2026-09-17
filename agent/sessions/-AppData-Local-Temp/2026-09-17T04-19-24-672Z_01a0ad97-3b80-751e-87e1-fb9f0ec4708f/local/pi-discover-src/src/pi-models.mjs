// Bridge Pi's public extension registry into an isolated SDK runtime. Reuse the
// host's provider implementation and resolve its current auth for every request;
// never copy credentials into the vault or assume a vendor's API/model names.
export function createPiRuntime(sdk, options = {}) {
  const hostOnly = async () => { throw new Error('Manage model credentials in Pi.'); };
  return sdk.ModelRuntime.create({ ...options, allowModelNetwork: false, modelsPath: null, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], modify: hostOnly, delete: hostOnly } });
}

export function bindPiModel(runtime, registry, model) {
  const provider = registry.getProvider(model.provider);
  if (!provider) throw new Error(`The selected provider is no longer available in Pi: ${model.provider}`);
  const current = () => {
    const value = registry.getProvider(model.provider);
    if (!value) throw new Error(`The selected provider is no longer available in Pi: ${model.provider}`);
    return value;
  };
  runtime.registerNativeProvider({
    id: provider.id, name: provider.name,
    getModels: () => [model],
    auth: { apiKey: {
      name: 'Pi session authentication',
      check: async ({ signal }) => {
        signal.throwIfAborted();
        const configured = registry.hasConfiguredAuth(model) || await registry.getProviderAuth(model.provider);
        signal.throwIfAborted();
        return configured ? { type: registry.isUsingOAuth(model) ? 'oauth' : 'api_key', source: 'Pi session' } : undefined;
      },
      resolve: async ({ signal }) => {
        signal.throwIfAborted();
        const resolved = await registry.getApiKeyAndHeaders(model);
        signal.throwIfAborted();
        if (!resolved.ok) throw new Error(resolved.error);
        return { auth: { apiKey: resolved.apiKey, headers: resolved.headers, baseUrl: resolved.baseUrl }, env: resolved.env, source: 'Pi session' };
      },
    } },
    stream: (selected, context, options) => current().stream(selected, context, options),
    streamSimple: (selected, context, options) => current().streamSimple(selected, context, options),
    ...(provider.fetchDeferred ? { fetchDeferred: (selected, handle, options) => current().fetchDeferred(selected, handle, options) } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: (selected, handle, options) => current().cancelDeferred(selected, handle, options) } : {}),
  });
}
