/** Release-gated capabilities. Both are opt-in and false in an ordinary local build. */
const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : ({} as Record<string, string | undefined>);
export const CLOUD_SYNC_ENABLED = env.VITE_ENABLE_CLOUD_SYNC === 'true';
export const CLOUD_SYNC_V2_ENABLED = env.VITE_PANVAS_SYNC_V2 !== 'false';
export const ANALYTICS_ENABLED = env.VITE_ENABLE_ANALYTICS === 'true'
  && env.VITE_MARKETING_ONLY === 'true';
