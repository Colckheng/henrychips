import { useSyncExternalStore } from 'react';

export type Route =
  | { page: 'tools'; category: string; query: string }
  | { page: 'tool'; name: string; example: boolean }
  | { page: 'runs' | 'integrations' | 'servers' | 'missing' };

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const [path, search = ''] = (hash.slice(1) || '/tools').split('?');
  const params = new URLSearchParams(search);
  if (path === '/tools' || path === '/') {
    return { page: 'tools', category: params.get('category') ?? 'all', query: params.get('q') ?? '' };
  }
  if (path === '/runs') return { page: 'runs' };
  if (path === '/integrations') return { page: 'integrations' };
  if (path === '/servers') return { page: 'servers' };
  const match = path.match(/^\/tools\/([^/]+)$/);
  if (match) {
    try { return { page: 'tool', name: decodeURIComponent(match[1]), example: params.has('example') }; }
    catch { return { page: 'missing' }; }
  }
  return { page: 'missing' };
}

export function catalogLink(category: string, query = ''): string {
  const params = new URLSearchParams();
  if (category !== 'all') params.set('category', category);
  if (query) params.set('q', query);
  return `#/tools${params.size ? `?${params}` : ''}`;
}
