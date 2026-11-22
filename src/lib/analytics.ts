import type { PostHog } from 'posthog-js';
import { ANALYTICS_ENABLED } from '@/config/features';

// Get these from env variables in a real deployment
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || 'YOUR_POSTHOG_KEY';
const configuredPosthogHost = import.meta.env.VITE_POSTHOG_HOST || 'https://eu.posthog.com';
const POSTHOG_HOST = (() => {
  try {
    const url = new URL(configuredPosthogHost);
    return url.protocol === 'https:' ? url.toString() : 'https://eu.posthog.com';
  } catch {
    return 'https://eu.posthog.com';
  }
})();

let posthogPromise: Promise<PostHog | null> | null = null;
let initialized = false;

function loadPosthog(): Promise<PostHog | null> {
  if (!(ANALYTICS_ENABLED && POSTHOG_KEY && POSTHOG_KEY !== 'YOUR_POSTHOG_KEY')) {
    return Promise.resolve(null);
  }
  if (!posthogPromise) {
    posthogPromise = import('posthog-js')
      .then((module) => {
        const client = module.default;
        if (!initialized) {
          client.init(POSTHOG_KEY, {
            api_host: POSTHOG_HOST,
            autocapture: false, // We'll manually capture important events
            capture_pageview: false, // Manually track pageviews via wouter/react
          });
          initialized = true;
        }
        return client;
      })
      .catch(() => {
        posthogPromise = null;
        return null;
      });
  }
  return posthogPromise;
}

export const initAnalytics = () => {
  // Only initialize if we're not in a dev/test environment and have a valid key
  if (ANALYTICS_ENABLED && POSTHOG_KEY && POSTHOG_KEY !== 'YOUR_POSTHOG_KEY') {
    void loadPosthog();
  }
};

export const captureEvent = (eventName: string, properties?: Record<string, any>) => {
  if (ANALYTICS_ENABLED && POSTHOG_KEY && POSTHOG_KEY !== 'YOUR_POSTHOG_KEY') {
    void loadPosthog().then((client) => {
      client?.capture(eventName, properties);
    });
  }
};

export const capturePageView = (url: string) => {
  if (ANALYTICS_ENABLED && POSTHOG_KEY && POSTHOG_KEY !== 'YOUR_POSTHOG_KEY') {
    void loadPosthog().then((client) => {
      client?.capture('$pageview', {
        $current_url: url,
      });
    });
  }
};
