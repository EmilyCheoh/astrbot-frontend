/* ================================================================
   Den — Composer
   Input, send, image paste, readonly state.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { appendUser } from "./messages.js";

// ---- Image handling ----

function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingImages.push(reader.result);
      renderImagePreview();
    };
    reader.readAsDataURL(file);
  }
}

function renderImagePreview() {
  dom.imgPreview.innerHTML = "";
  if (state.pendingImages.length === 0) {
    dom.imgPreview.classList.add("hidden");
    return;
  }
  dom.imgPreview.classList.remove("hidden");
  state.pendingImages.forEach((uri, i) => {
    const item = document.createElement("div");
    item.className = "img-preview-item";

    const img = document.createElement("img");
    img.src = uri;

    const rm = document.createElement("button");
    rm.className = "img-preview-remove";
    rm.textContent = "\u00D7";
    rm.addEventListener("click", () => {
      state.pendingImages.splice(i, 1);
      renderImagePreview();
    });

    item.appendChild(img);
    item.appendChild(rm);
    dom.imgPreview.appendChild(item);
  });
}

function clearPendingImages() {
  state.pendingImages.length = 0;
  renderImagePreview();
}

// ---- Send message ----

export function sendMessage() {
  if (state.isReadonly) return;
  const text = dom.msgInput.value.trim();
  const images = state.pendingImages.slice();
  if ((!text && images.length === 0) || !isConnected()) return;

  const id = crypto.randomUUID();
  const payload = { type: "message", id, content: text };
  if (images.length > 0) payload.images = images;

  send(payload);
  appendUser(text || "[image]");
  dom.msgInput.value = "";
  dom.msgInput.style.height = "auto";
  clearPendingImages();
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
    if (dom.fileInput.files.length > 0) addImages(dom.fileInput.files);
    dom.fileInput.value = "";
  });

  // Paste image from clipboard
  dom.msgInput.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImages(imageFiles);
    }
  });

  // Drag-and-drop images
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
    if (files && files.length > 0) addImages(files);
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
