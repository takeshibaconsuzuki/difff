type Alignment = 'start' | 'center' | 'nearest';

// Scroll only the owning pane. scrollIntoView also moves ancestor containers,
// including the webview document and horizontally scrolling code tables.
export function scrollInPane(pane: HTMLElement, target: HTMLElement, alignment: Alignment = 'center', onlyIfHidden = false, behavior: ScrollBehavior = 'smooth', insetTop = 0): void {
  const bounds = pane.getBoundingClientRect();
  const top = bounds.top + pane.clientTop + insetTop;
  const bottom = bounds.top + pane.clientTop + pane.clientHeight;
  const item = target.getBoundingClientRect();
  if (onlyIfHidden && item.top >= top && item.bottom <= bottom) return;
  const delta = alignment === 'center' ? (item.top + item.bottom - top - bottom) / 2
    : alignment === 'start' ? item.top - top
    : item.top < top ? item.top - top : item.bottom > bottom ? item.bottom - bottom : 0;
  if (Math.abs(delta) > .5) pane.scrollTo({ top: pane.scrollTop + delta, behavior });
}

export function revealInDiff(target: HTMLElement, onlyIfHidden = false): void {
  const pane = target.closest<HTMLElement>('#diff');
  if (!pane) return;
  const header = target.closest('.file-card')?.querySelector<HTMLElement>('.file-header');
  const inset = header?.getBoundingClientRect().height ?? 0;
  // A visible editor should keep its position; account for the sticky header.
  const bounds = pane.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  if (onlyIfHidden && item.top >= bounds.top + inset && item.bottom <= bounds.top + pane.clientHeight) return;
  scrollInPane(pane, target);
}

export function focusComposer(composer: HTMLElement): void {
  composer.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  revealInDiff(composer, true);
}

export function revealFileLink(path: string): void {
  const pane = document.getElementById('files');
  const link = [...pane?.querySelectorAll<HTMLElement>('.file-link') ?? []].find(link => link.dataset.path === path);
  if (pane && link) scrollInPane(pane, link, 'nearest', true, 'instant');
}

export function captureDiffPosition(pane: HTMLElement): () => void {
  const bounds = pane.getBoundingClientRect();
  const row = [...pane.querySelectorAll<HTMLElement>('[data-row], .inline-comment, .composer, .context-gap')].find(row => {
    const rect = row.getBoundingClientRect();
    const header = row.closest('.file-card')?.querySelector('.file-header');
    return rect.bottom > bounds.top + (header?.getBoundingClientRect().height ?? 0) && rect.top < bounds.bottom;
  });
  const top = row?.getBoundingClientRect().top;
  return () => {
    if (row?.isConnected && top !== undefined) pane.scrollTop += row.getBoundingClientRect().top - top;
  };
}
