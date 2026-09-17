import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerDiscover } from './src/extension.mjs';

export default function discover(pi: ExtensionAPI) {
  // Pi resolves its SDK here; the research runtime does not load at startup.
  registerDiscover(pi, { loadSdk: () => import('@earendil-works/pi-coding-agent') });
}
