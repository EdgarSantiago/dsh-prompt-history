/** Select by stable row key in an already-filtered, newest-first history list. */
export function selectHistoryItem(items, currentKey, move = 'older') {
  const rows = Array.isArray(items) ? items : [];
  const total = rows.length;
  const cleared = { key: null, index: -1, total };
  if (total === 0) return cleared;

  const currentIndex = currentKey == null ? -1 : rows.findIndex(item => item.key === currentKey);
  let index;
  if (move === 'first') index = 0;
  else if (move === 'newer') index = Math.max(0, currentIndex - 1);
  else index = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, total - 1);

  return { key: rows[index].key, index, total };
}
