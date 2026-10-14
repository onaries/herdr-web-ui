/**
 * One browser-local identity for one native conversation lifetime. `incarnation`
 * increments when a history without an ID is replaced in the same pane.
 */
export interface ChatRowScope {
  readonly machineId: string;
  readonly paneId: string;
  readonly historyId: string | null;
  readonly incarnation: number;
}

export interface ChatRowSlot {
  readonly key: string;
}

/**
 * The assigned slots for loaded logical rows. Slots are allocated only when a
 * known ingestion transition adds rows; immutable turn revisions reuse them.
 */
export interface ChatRowSlots {
  readonly scope: ChatRowScope;
  readonly rows: readonly ChatRowSlot[];
  readonly nextSlot: number;
}

function slotRows(scope: ChatRowScope, firstSlot: number, count: number): readonly ChatRowSlot[] {
  return Array.from({ length: count }, (_, offset) => ({
    key: JSON.stringify([scope.machineId, scope.paneId, scope.historyId, scope.incarnation, firstSlot + offset]),
  }));
}

export function createChatRowSlots(scope: ChatRowScope, count: number): ChatRowSlots {
  return { scope, rows: slotRows(scope, 0, count), nextSlot: count };
}

/**
 * Inserts rows at their known logical position without shifting existing row
 * identities. Use for both prepended pages and gap-fill pages.
 */
export function insertChatRowSlots(slots: ChatRowSlots, index: number, count: number): ChatRowSlots {
  const rows = slotRows(slots.scope, slots.nextSlot, count);
  return {
    scope: slots.scope,
    rows: [...slots.rows.slice(0, index), ...rows, ...slots.rows.slice(index)],
    nextSlot: slots.nextSlot + count,
  };
}

export function prependChatRowSlots(slots: ChatRowSlots, count: number): ChatRowSlots {
  return insertChatRowSlots(slots, 0, count);
}

export function appendChatRowSlots(slots: ChatRowSlots, count: number): ChatRowSlots {
  return insertChatRowSlots(slots, slots.rows.length, count);
}
