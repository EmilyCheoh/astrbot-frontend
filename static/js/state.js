/* ================================================================
   Den — Shared State
   Single exported object — imported bindings are read-only,
   so all mutable state lives on this object's properties.
   ================================================================ */

export const state = {
  // -- Message / composer state --
  pendingImages: [],       // { dataUri, size }
  pendingFiles: [],        // { name, size, dataUri }
  pendingReads: 0,         // In-flight FileReader count
  pendingAttachmentBytes: 0,  // Reserved budget (images + files)
  isProcessing: false,
  isBranching: false,
  batchRendering: false,
  currentMessages: [],
  currentConvTitle: "",
  isReadonly: false,
  searchMode: "title",

  // -- Unified conversation store --
  // Single source of truth: all conversation objects keyed by ID
  conversationById: new Map(),

  // Ordered ID arrays — render pulls from the Map
  conversationIds: [],   // IDs for "All conversations" (cursor-loaded)
  favoriteIds: [],       // IDs for "Favorites" (globally loaded)

  // Active / pending selection
  currentConversationId: null,    // Confirmed by server (history arrived)
  pendingConversationId: null,    // Set on click, cleared on history arrival
  activeAnchorId: null,           // Search result not yet in loaded list

  // Cursor pagination
  listGeneration: 0,    // Incremented on each sidebar open, stale responses rejected
  nextCursor: null,
  hasMore: true,
  isLoadingMore: false,
  listError: false,     // Set on list failure — blocks sentinel until sidebar reopened

  // Pin operation tracking (per-conversation)
  pendingPinIds: new Set(),
};
