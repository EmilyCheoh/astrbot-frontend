/* ================================================================
   Den — Shared State
   Single exported object — imported bindings are read-only,
   so all mutable state lives on this object's properties.
   ================================================================ */

export const state = {
  pendingImages: [],
  isProcessing: false,
  batchRendering: false,
  currentMessages: [],
  isReadonly: false,
  currentConvTitle: "",
  currentPage: 1,
  pinnedIds: [],
  lastConvListData: null,
  searchMode: "title",
};
