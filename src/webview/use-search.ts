import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewFile } from '../model';
import { rowId } from './bridge';
import { DiffSearch, type SearchMatch, type SearchResult } from './search';

export interface IndexedMatch extends SearchMatch { index: number }
const emptyResult: SearchResult = { matches: [] };

export function useDiffSearch(files: ReviewFile[], query: string, regex: boolean, matchCase: boolean) {
  const rows = useMemo(() => files.flatMap(file => file.hunks.flatMap(hunk => hunk.lines.filter(row => row.kind !== 'note').map(row => ({ id: rowId(file.path, row), text: row.text })))), [files]);
  const input = useMemo(() => ({ rows, query, regex, matchCase }), [rows, query, regex, matchCase]);
  const previousCriteria = useRef('');
  const [search, setSearch] = useState<{ input: typeof input; result: SearchResult; index: number; scroll: boolean }>();

  useEffect(() => {
    const worker = new DiffSearch();
    const criteria = JSON.stringify([query, regex, matchCase]);
    const scroll = criteria !== previousCriteria.current;
    previousCriteria.current = criteria;
    let active = true;
    const timer = setTimeout(() => {
      worker.run(rows, query, regex, matchCase, result => {
        if (active) setSearch({ input, result, index: result.matches.length ? 0 : -1, scroll });
      });
    }, query ? 180 : 0);
    return () => { active = false; clearTimeout(timer); worker.cancel(); };
  }, [input, rows, query, regex, matchCase]);

  // Do not expose highlights or navigation from a superseded query while a worker is running.
  const current = search?.input === input ? search : undefined;
  const result = current?.result ?? emptyResult;
  const index = current?.index ?? -1;
  const byRow = useMemo(() => {
    const grouped = new Map<string, IndexedMatch[]>();
    result.matches.forEach((match, index) => {
      const entries = grouped.get(match.id) ?? [];
      entries.push({ ...match, index });
      grouped.set(match.id, entries);
    });
    return grouped;
  }, [result]);
  const move = (direction: number) => {
    setSearch(value => value?.input === input && value.result.matches.length ? { ...value, index: (value.index + direction + value.result.matches.length) % value.result.matches.length, scroll: true } : value);
  };
  const scrollRequest = useMemo(() => current?.scroll && result.matches[index] ? { index } : undefined, [current, result, index]);
  return { result, index, byRow, move, scrollRequest };
}
