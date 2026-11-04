// Cloudflare Worker entry point.
// Static files in /public are served by Cloudflare's asset hosting; this handles /api/*.
// Set the key with:  npx wrangler secret put RDM_API_KEY   (or in the dashboard as a Secret)

import stations from '../data/stations.json';
import { createApi } from './api.js';

let api;
let apiFor;

export default {
  async fetch(request, env) {
    // Build once per isolate (keeps the 20 s cache), rebuild if settings change.
    const key = `${env.RDM_API_KEY || ''}|${env.RDM_DEPARTURES_URL || ''}`;
    if (!api || apiFor !== key) {
      api = createApi({ stations, apiKey: env.RDM_API_KEY, apiUrl: env.RDM_DEPARTURES_URL });
      apiFor = key;
    }
    const res = await api(new URL(request.url));
    return res || env.ASSETS.fetch(request);
  },
};
