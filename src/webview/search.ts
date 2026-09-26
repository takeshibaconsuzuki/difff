export interface SearchRow { id: string; text: string }
export interface SearchMatch { id: string; start: number; end: number }
export interface SearchResult { matches: SearchMatch[]; error?: string; capped?: boolean }

// Run arbitrary user regexes off the UI thread so even catastrophic backtracking can be cancelled.
function workerMain(): void {
  const worker = self as unknown as {
    onmessage: (event: MessageEvent<{ rows: SearchRow[]; query: string; regex: boolean; matchCase: boolean }>) => void;
    postMessage: (result: SearchResult) => void;
  };
  worker.onmessage = ({ data }) => {
    const matches: SearchMatch[] = [];
    try {
      const pattern = data.regex ? data.query : data.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(pattern, data.matchCase ? 'g' : 'gi');
      for (const row of data.rows) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(row.text))) {
          matches.push({ id: row.id, start: match.index, end: match.index + match[0].length });
          if (matches.length >= 5000) { worker.postMessage({ matches, capped: true }); return; }
          if (!match[0].length) regex.lastIndex++;
        }
      }
      worker.postMessage({ matches });
    } catch (error) {
      worker.postMessage({ matches: [], error: error instanceof Error ? error.message : 'Invalid regular expression.' });
    }
  };
}

export class DiffSearch {
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  cancel(): void {
    this.worker?.terminate();
    clearTimeout(this.timer);
  }
  run(rows: SearchRow[], query: string, regex: boolean, matchCase: boolean, done: (result: SearchResult) => void): void {
    this.cancel();
    if (!query) { done({ matches: [] }); return; }
    const url = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));
    const worker = this.worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (event: MessageEvent<SearchResult>) => { this.cancel(); done(event.data); };
    worker.onerror = () => { this.cancel(); done({ matches: [], error: 'Search could not run.' }); };
    this.timer = setTimeout(() => {
      this.cancel();
      done({ matches: [], error: 'Regex took too long. Try a simpler expression.' });
    }, 1500);
    worker.postMessage({ rows, query, regex, matchCase });
  }
}
