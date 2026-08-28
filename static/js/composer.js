/* ================================================================
   Den — Composer
   Input, send, file/image attach, readonly state.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { appendUser } from "./messages.js";

// ---- Constants ----

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB raw budget

const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// ---- Composer availability ----

function updateComposerAvailability() {
  dom.sendBtn.disabled =
    state.pendingReads > 0 ||
    state.isProcessing ||
    state.isReadonly;
}

// ---- Size formatting ----

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ---- Attachment routing ----

function addAttachments(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  // Budget check (pre-read reservation)
  const newBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (state.pendingAttachmentBytes + newBytes > MAX_ATTACHMENT_BYTES) {
    showWarning("Attachments must be 10 MiB or smaller in total.");
    return;
  }

  // Reserve budget before any reads start
  state.pendingAttachmentBytes += newBytes;

  for (const file of files) {
    const isImage = PREVIEWABLE_IMAGE_TYPES.has(file.type);

    state.pendingReads++;
    updateComposerAvailability();

    const reader = new FileReader();

    reader.onload = () => {
      if (isImage) {
        state.pendingImages.push({
          dataUri: reader.result,
          size: file.size,
        });
        renderImagePreview();
      } else {
        state.pendingFiles.push({
          name: file.name,
          size: file.size,
          dataUri: reader.result,
        });
        renderFilePreview();
      }
    };

    reader.onerror = () => {
      // Release this file's reserved budget
      state.pendingAttachmentBytes -= file.size;
      showWarning(`Could not read ${file.name}`);
    };

    reader.onloadend = () => {
      state.pendingReads--;
      updateComposerAvailability();
    };

    reader.readAsDataURL(file);
  }
}

// ---- Warning display ----

function showWarning(message) {
  // Remove any existing warning
  const existing = document.querySelector(".composer-warning");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "composer-warning";
  el.textContent = message;
  const composer = document.querySelector(".composer");
  composer.insertBefore(el, composer.firstChild);

  setTimeout(() => el.remove(), 4000);
}

// ---- Image preview ----

function renderImagePreview() {
  dom.imgPreview.innerHTML = "";
  if (state.pendingImages.length === 0 && state.pendingFiles.length === 0) {
    dom.imgPreview.classList.add("hidden");
    return;
  }
  dom.imgPreview.classList.remove("hidden");

  // Render image thumbnails
  state.pendingImages.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "img-preview-item";

    const img = document.createElement("img");
    img.src = item.dataUri;

    const rm = document.createElement("button");
    rm.className = "img-preview-remove";
    rm.textContent = "\u00D7";
    rm.addEventListener("click", () => {
      state.pendingAttachmentBytes -= state.pendingImages[i].size;
      state.pendingImages.splice(i, 1);
      renderImagePreview();
    });

    el.appendChild(img);
    el.appendChild(rm);
    dom.imgPreview.appendChild(el);
  });

  // Render file chips inside the same preview container
  renderFileChips(dom.imgPreview);
}

// ---- File preview ----

function renderFilePreview() {
  // Re-render the shared preview container
  renderImagePreview();
}

function renderFileChips(container) {
  state.pendingFiles.forEach((file, i) => {
    const chip = document.createElement("div");
    chip.className = "file-preview-chip";

    const icon = document.createElement("span");
    icon.className = "file-preview-icon";
    icon.textContent = "\uD83D\uDCC4"; // page emoji

    const info = document.createElement("span");
    info.className = "file-preview-info";

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-preview-name";
    nameSpan.textContent = file.name;

    const sizeSpan = document.createElement("span");
    sizeSpan.className = "file-preview-size";
    sizeSpan.textContent = formatSize(file.size);

    info.appendChild(nameSpan);
    info.appendChild(sizeSpan);

    const rm = document.createElement("button");
    rm.className = "file-preview-remove";
    rm.textContent = "\u00D7";
    rm.addEventListener("click", () => {
      state.pendingAttachmentBytes -= state.pendingFiles[i].size;
      state.pendingFiles.splice(i, 1);
      renderImagePreview();
    });

    chip.appendChild(icon);
    chip.appendChild(info);
    chip.appendChild(rm);
    container.appendChild(chip);
  });
}

// ---- Clear all pending ----

function clearPending() {
  state.pendingImages.length = 0;
  state.pendingFiles.length = 0;
  state.pendingAttachmentBytes = 0;
  renderImagePreview();
}

// ---- Send message ----

export function sendMessage() {
  if (state.isReadonly || state.pendingReads > 0) return;
  const text = dom.msgInput.value.trim();
  const images = state.pendingImages.slice();
  const files = state.pendingFiles.slice();
  if (!text && images.length === 0 && files.length === 0) return;
  if (!isConnected()) return;

  const id = crypto.randomUUID();
  const payload = { type: "message", id, content: text };
  if (images.length > 0) payload.images = images.map((i) => i.dataUri);
  if (files.length > 0) payload.files = files.map((f) => ({ name: f.name, data: f.dataUri }));

  const hasAttachment = images.length > 0 || files.length > 0;

  send(payload);
  appendUser(
    text || (files.length > 0 ? "[file]" : "[image]"),
    { images, files, hasAttachment },
  );
  dom.msgInput.value = "";
  dom.msgInput.style.height = "auto";
  clearPending();
}

// ---- Bind events ----

export function initComposer() {
  // Auto-resize textarea
  dom.msgInput.addEventListener("input", () => {
    dom.msgInput.style.height = "auto";
    dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 120) + "px";
  });

  // Attach button
  dom.attachBtn.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    if (dom.fileInput.files.length > 0) addAttachments(dom.fileInput.files);
    dom.fileInput.value = "";
  });

  // Paste image from clipboard (images only — you don't paste .py files)
  dom.msgInput.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (PREVIEWABLE_IMAGE_TYPES.has(item.type)) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addAttachments(imageFiles);
    }
  });

  // Drag-and-drop (all file types)
  const composerEl = document.querySelector(".composer");
  let dragCounter = 0;

  dom.chat.addEventListener("dragenter", (e) => {
    if (state.isReadonly || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter++;
    composerEl.classList.add("drag-over");
  });

  dom.chat.addEventListener("dragleave", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      composerEl.classList.remove("drag-over");
    }
  });

  dom.chat.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  });

  dom.chat.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter = 0;
    composerEl.classList.remove("drag-over");
    if (state.isReadonly) return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) addAttachments(files);
  });

  // Keyboard behavior:
  // Desktop: Enter sends, Shift+Enter inserts a newline
  // Mobile: Enter always inserts a newline (send via button only)
  dom.msgInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;

    // Do not send while confirming text in an IME
    if (e.isComposing || e.keyCode === 229) return;

    const isMobile =
      navigator.userAgentData?.mobile === true ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    // Mobile Enter and desktop Shift+Enter keep the textarea's
    // normal newline behavior.
    if (isMobile || e.shiftKey) return;

    e.preventDefault();
    sendMessage();
  });

  // Send button
  dom.sendBtn.addEventListener("click", sendMessage);
}
