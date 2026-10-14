/* ================================================================
   Den — Image Viewer (Lightbox)
   Click-to-zoom for chat images.  Single overlay, event delegation.
   ================================================================ */

import { dom } from "./dom.js";

// ---- Selectors that qualify as zoomable chat images ----
const IMG_SELECTOR = ".msg-attachment-images img, .msg-bot img";

// ---- State ----

export function isLightboxOpen() {
  return !dom.imageLightbox.classList.contains("hidden");
}

export function closeLightbox() {
  dom.imageLightbox.classList.add("hidden");
  dom.lightboxImg.src = "";
}

// ---- Init ----

export function initImageViewer() {
  // Delegate: any click on a qualifying chat image opens the lightbox
  dom.messages.addEventListener("click", (e) => {
    const img = e.target.closest(IMG_SELECTOR);
    if (!img) return;

    const src = img.currentSrc || img.src;
    if (!src) return;

    e.preventDefault();
    e.stopPropagation();
    dom.lightboxImg.src = src;
    dom.imageLightbox.classList.remove("hidden");
  });

  // Click on the overlay backdrop closes; click on the image itself does not
  dom.imageLightbox.addEventListener("click", (e) => {
    if (e.target === dom.imageLightbox) {
      closeLightbox();
    }
  });
}
