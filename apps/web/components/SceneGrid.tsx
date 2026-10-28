'use client';

import { useMemo, useState } from 'react';
import type { WorldSceneEntry } from '@/lib/worlds';
import SceneCard from './SceneCard';

type SortKey = 'newest' | 'name' | 'objects';

/**
 * Searchable, sortable scene grid. Owns rename/delete state locally so
 * the page stays a server component (data fetched once, no refetch).
 */
export default function SceneGrid({ initial }: { initial: WorldSceneEntry[] }) {
  const [scenes, setScenes] = useState(initial);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? scenes.filter((s) => s.name.toLowerCase().includes(q)) : [...scenes];
    switch (sort) {
      case 'name':
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'objects':
        filtered.sort((a, b) => b.objects - a.objects);
        break;
      case 'newest':
      default:
        filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        break;
    }
    return filtered;
  }, [scenes, query, sort]);

  return (
    <div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search worlds…"
          aria-label="Search worlds"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 sm:max-w-xs"
        />
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200"
          >
            <option value="newest">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="objects">Most objects</option>
          </select>
        </label>
        {query.trim() && (
          <p className="text-xs text-neutral-500">
            {visible.length} of {scenes.length} match
          </p>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="mt-10 rounded-xl border border-white/10 bg-[#111113] px-5 py-8 text-center text-sm text-neutral-400">
          No worlds match “{query.trim()}”.
        </p>
      ) : (
        <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((s) => (
            <SceneCard
              key={s.id}
              entry={s}
              onDeleted={(id) => setScenes((prev) => prev.filter((x) => x.id !== id))}
              onRenamed={(id, name) => setScenes((prev) => prev.map((x) => (x.id === id ? { ...x, name } : x)))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
