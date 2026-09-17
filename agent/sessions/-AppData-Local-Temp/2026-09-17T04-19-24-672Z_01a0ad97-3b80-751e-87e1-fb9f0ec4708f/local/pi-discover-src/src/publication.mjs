export const REVIEW_EVENT = 'discover-publication';

// Publication decisions live beside native history, so replay and forks cannot
// accidentally expose an unreviewed draft after a restart.
export function trackPublication(state, entry, getEntry) {
  if (entry.type === 'custom' && entry.customType === REVIEW_EVENT) {
    if (entry.data?.phase === 'start') state.pending = entry.data;
    else if (entry.data?.phase === 'publish' && state.pending?.turnId === entry.data.turnId) {
      const target = getEntry(entry.data.entryId);
      if (!target || target.message?.role !== 'assistant' || !state.hidden.has(target.id)) throw new Error('Invalid Discover publication record');
      state.pending = null;
      state.hidden.delete(target.id);
      return { entry: target, review: entry.data.review };
    } else if (entry.data?.phase === 'end' && state.pending?.turnId === entry.data.turnId) state.pending = null;
    return;
  }
  if (entry.type !== 'message') return;
  if (entry.message.role === 'assistant' && state.pending) { state.hidden.add(entry.id); return; }
  return { entry };
}
