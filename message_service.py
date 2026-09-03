"""Message intake, retry/edit handling for the A&F Web Frontend.

Handles incoming user messages, AstrBotMessage construction,
event creation, and retry/edit truncation logic.
Does NOT import FrontendAdapter directly — receives adapter ref
via constructor to avoid circular imports.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from aiohttp import web

from astrbot.api.platform import (
    AstrBotMessage,
    MessageMember,
    MessageType,
)
from astrbot.api.message_components import File, Plain, Image
from astrbot import logger

from .frontend_event import FrontendEvent
from .media_utils import save_temp_media, save_temp_file
from . import runtime

if TYPE_CHECKING:
    from .conversation_service import ConversationService


class MessageService:
    """Handles message intake, retry/edit, and event construction."""

    def __init__(
        self,
        adapter,
        conversations: "ConversationService",
        umo: str,
    ) -> None:
        self._adapter = adapter
        self._conversations = conversations
        self._umo = umo

    async def on_message(
        self, data: dict, ws: web.WebSocketResponse, turn_token: object,
    ) -> bool:
        """Convert an incoming frontend message and commit it to the queue.

        Returns ``True`` if the event was committed (turn is now owned by
        the pipeline).  Returns ``False`` if processing failed before
        commit — the caller must release the turn and send idle.
        """

        # Acknowledge receipt immediately
        msg_id = data.get("id", str(uuid.uuid4()))
        await ws.send_json({"type": "message_ack", "id": msg_id})

        # Detect slash commands — they skip the thinking/idle lifecycle
        content = data.get("content", "").strip()
        is_command = content.startswith("/")

        # Notify frontend that processing has started (not for commands)
        if not is_command:
            await ws.send_json({"type": "status", "status": "thinking", "id": msg_id})

        # ---- Build message chain -------------------------------------------
        chain: list = []
        if content:
            chain.append(Plain(text=content))

        temp_files: list[str] = []
        save_failed = False

        # Images
        for img in data.get("images", []):
            path = save_temp_media(img, "image")
            if path:
                chain.append(Image.fromFileSystem(path))
                temp_files.append(path)
            else:
                save_failed = True
                break

        # Files (non-image attachments)
        if not save_failed:
            for file_obj in data.get("files", []):
                file_data = file_obj.get("data", "")
                file_name = file_obj.get("name", "attachment.bin")
                path = save_temp_file(file_data, file_name)
                if path:
                    chain.append(File(name=file_name, file=path))
                    temp_files.append(path)
                else:
                    save_failed = True
                    break

        # If any attachment failed, clean up all temp files and abort
        if save_failed:
            for fp in temp_files:
                try:
                    Path(fp).unlink(missing_ok=True)
                except OSError:
                    pass
            await ws.send_json({
                "type": "error",
                "id": msg_id,
                "message": "Failed to save attached file",
            })
            return False

        if not chain:
            return False

        # ---- Build AstrBotMessage ------------------------------------------
        abm = AstrBotMessage()
        abm.type = MessageType.FRIEND_MESSAGE
        abm.group_id = ""
        abm.message_str = content
        abm.sender = MessageMember(
            user_id="felis_abyssalis", nickname="Felis Abyssalis"
        )
        abm.message = chain
        abm.raw_message = data
        abm.self_id = "abyss_web"
        abm.session_id = "felis_abyssalis"
        abm.message_id = msg_id

        # ---- Create event and commit ---------------------------------------
        event = FrontendEvent(
            message_str=abm.message_str,
            message_obj=abm,
            platform_meta=self._adapter.meta(),
            session_id=abm.session_id,
            adapter=self._adapter,
            source_ws=ws,
            turn_token=turn_token,
            is_command=is_command,
        )

        # Register temp files so AstrBot cleans them up
        for fp in temp_files:
            event.track_temporary_local_file(fp)

        self._adapter.commit_event(event)
        return True

    # -- Stop ----------------------------------------------------------------

    async def on_stop(
        self, ws: web.WebSocketResponse, stop_id: str,
    ) -> None:
        """Create a fixed ``/stop`` event and commit it to AstrBot.

        Does NOT send ``status: thinking`` — the stop button state is
        managed entirely by the ``stop_ack`` round-trip.
        """
        abm = AstrBotMessage()
        abm.type = MessageType.FRIEND_MESSAGE
        abm.group_id = ""
        abm.message_str = "/stop"
        abm.sender = MessageMember(
            user_id="felis_abyssalis", nickname="Felis Abyssalis",
        )
        abm.message = [Plain(text="/stop")]
        abm.raw_message = {"type": "stop", "id": stop_id}
        abm.self_id = "abyss_web"
        abm.session_id = "felis_abyssalis"
        abm.message_id = stop_id

        event = FrontendEvent(
            message_str="/stop",
            message_obj=abm,
            platform_meta=self._adapter.meta(),
            session_id=abm.session_id,
            adapter=self._adapter,
            source_ws=ws,
            turn_token=None,
            is_stop=True,
        )

        self._adapter.commit_event(event)

    # -- Retry / Edit --------------------------------------------------------

    async def handle_retry_or_edit(
        self, ws: web.WebSocketResponse, content: str,
        *, action: str = "retry", turn_token: object = None,
    ) -> bool:
        """Handle retry or edit: truncate last exchange, re-fire message.

        Returns ``True`` if the event was committed (turn owned by
        pipeline).  Returns ``False`` if processing failed before commit
        — the caller must release the turn and send idle.
        """
        if not content.strip():
            return False

        success = await self._truncate_last_exchange(expected_content=content, action=action)
        if not success:
            logger.warning("Retry/edit failed: could not truncate history")
            return False

        # Re-fire as a normal message through the standard pipeline
        return await self.on_message(
            {"content": content, "id": str(uuid.uuid4())}, ws, turn_token,
        )

    # -- Edit assistant reply (no LLM re-fire) --------------------------------

    @staticmethod
    def _extract_assistant_text(message: dict) -> str:
        """Extract visible text from an assistant message."""
        content = message.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                block.get("text", "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        return ""

    async def handle_edit_assistant_message(
        self,
        ws: web.WebSocketResponse,
        conversation_id: str,
        new_text: str,
        original_content: str,
    ):
        """Replace the visible text of the last assistant reply in history.

        Does NOT trigger a new LLM response — purely a manual correction.
        """
        new_text = new_text.strip()
        if not new_text:
            await self._send_edit_failed(ws, conversation_id)
            return

        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available for assistant edit")
                await self._send_edit_failed(ws, conversation_id)
                return

            # Verify conversation ID matches the active one
            cid = await runtime.conversation_manager.get_curr_conversation_id(
                self._umo
            )
            if not cid or cid != conversation_id:
                logger.warning("Assistant edit: conversation ID mismatch")
                await self._send_edit_failed(ws, conversation_id)
                return

            # Load history (read-only SQLite, same pattern as _truncate)
            db_path = self._conversations.find_db()
            if not db_path:
                await self._send_edit_failed(ws, conversation_id)
                return

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cursor = conn.execute(
                "SELECT content FROM conversations WHERE conversation_id = ?",
                (cid,),
            )
            row = cursor.fetchone()
            conn.close()

            if not row or not row[0]:
                await self._send_edit_failed(ws, conversation_id)
                return

            history = json.loads(row[0])

            # Find last user message index
            last_user_idx = None
            for i in range(len(history) - 1, -1, -1):
                if history[i].get("role") == "user":
                    last_user_idx = i
                    break

            if last_user_idx is None:
                await self._send_edit_failed(ws, conversation_id)
                return

            # Reject if the current turn contains tool activity
            turn_has_tool_activity = any(
                isinstance(message, dict)
                and (
                    message.get("role") == "tool"
                    or bool(message.get("tool_calls"))
                )
                for message in history[last_user_idx + 1 :]
            )
            if turn_has_tool_activity:
                logger.warning(
                    "Assistant edit rejected: current reply contains tool activity"
                )
                await self._send_edit_failed(ws, conversation_id)
                return

            # Find last assistant with visible text AFTER last user message
            target_idx = None
            for i in range(len(history) - 1, last_user_idx, -1):
                msg = history[i]
                if msg.get("role") != "assistant":
                    continue
                visible = self._extract_assistant_text(msg)
                if visible.strip():
                    target_idx = i
                    break

            if target_idx is None:
                await self._send_edit_failed(ws, conversation_id)
                return

            # Verify original content matches what's in the DB
            stored_text = self._extract_assistant_text(history[target_idx])
            if stored_text.strip() != original_content.strip():
                logger.warning(
                    "Assistant edit: original content mismatch "
                    "(screen vs DB out of sync)"
                )
                await self._send_edit_failed(ws, conversation_id)
                return

            # Replace text content, preserving think blocks and tool records
            target = history[target_idx]
            target_content = target.get("content")

            if isinstance(target_content, str):
                target["content"] = new_text
            elif isinstance(target_content, list):
                updated_blocks = []
                text_replaced = False
                for block in target_content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        if not text_replaced:
                            updated_block = dict(block)
                            updated_block["text"] = new_text
                            updated_blocks.append(updated_block)
                            text_replaced = True
                    else:
                        updated_blocks.append(block)

                if not text_replaced:
                    await self._send_edit_failed(ws, conversation_id)
                    return

                target["content"] = updated_blocks
            else:
                await self._send_edit_failed(ws, conversation_id)
                return

            # Save via conversation_manager
            await runtime.conversation_manager.update_conversation(
                self._umo, cid, history=history,
            )

            logger.info(f"Assistant reply edited in conversation {cid}")

            await ws.send_json({
                "type": "assistant_message_edited",
                "conversation_id": conversation_id,
                "message_index": target_idx,
                "message": history[target_idx],
            })

        except Exception as exc:
            logger.warning(f"Failed to edit assistant message: {exc}")
            await self._send_edit_failed(ws, conversation_id)

    @staticmethod
    async def _send_edit_failed(ws: web.WebSocketResponse, conversation_id: str):
        """Send an edit-failed response."""
        try:
            await ws.send_json({
                "type": "assistant_message_edit_failed",
                "conversation_id": conversation_id,
            })
        except Exception:
            pass

    # -- User message patch (no LLM re-fire) --------------------------------

    @staticmethod
    def _message_revision(message: dict) -> str:
        """SHA-256 fingerprint of a message for optimistic concurrency."""
        canonical = json.dumps(
            message,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    async def _load_active_history(
        self,
        requested_cid: str,
    ) -> tuple[list[dict], str] | None:
        """Load history for the active conversation, verifying the ID matches."""
        manager = runtime.conversation_manager
        if not manager:
            return None

        active_cid = await manager.get_curr_conversation_id(self._umo)
        if not active_cid or active_cid != requested_cid:
            return None

        conversation = await manager.get_conversation(
            self._umo,
            active_cid,
        )
        if not conversation:
            return None

        history = json.loads(conversation.history or "[]")
        if not isinstance(history, list):
            return None

        return history, active_cid

    @staticmethod
    def _find_last_user_patch_target(history: list[dict]):
        """Locate the last user message and its first text block."""
        for message_index in range(len(history) - 1, -1, -1):
            message = history[message_index]
            if not isinstance(message, dict) or message.get("role") != "user":
                continue

            content = message.get("content")

            if isinstance(content, str):
                return message_index, None, "string", content

            if isinstance(content, list):
                for block_index, block in enumerate(content):
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "text"
                        and isinstance(block.get("text"), str)
                    ):
                        return (
                            message_index,
                            block_index,
                            "list",
                            block["text"],
                        )

            return None

        return None

    async def handle_prepare_user_message_patch(
        self,
        ws: web.WebSocketResponse,
        conversation_id: str,
        display_content: str,
    ):
        """Prepare a user message patch by returning the stored raw text."""
        display_content = display_content.strip()
        if not display_content:
            await self._send_user_patch_failed(
                ws, conversation_id, "content_mismatch"
            )
            return

        try:
            loaded = await self._load_active_history(conversation_id)
            if not loaded:
                await self._send_user_patch_failed(
                    ws, conversation_id, "conversation_mismatch"
                )
                return

            history, _ = loaded
            target = self._find_last_user_patch_target(history)
            if not target:
                await self._send_user_patch_failed(
                    ws, conversation_id, "message_not_found"
                )
                return

            message_index, block_index, content_kind, raw_text = target

            # Verify the bubble text appears in the stored message
            if display_content not in raw_text:
                await self._send_user_patch_failed(
                    ws, conversation_id, "content_mismatch"
                )
                return

            await ws.send_json({
                "type": "user_message_patch_ready",
                "conversation_id": conversation_id,
                "message_index": message_index,
                "block_index": block_index,
                "content_kind": content_kind,
                "raw_text": raw_text,
                "revision": self._message_revision(
                    history[message_index]
                ),
            })

        except Exception as exc:
            logger.warning(f"Failed to prepare user message patch: {exc}")
            await self._send_user_patch_failed(
                ws, conversation_id, "message_not_found"
            )

    async def handle_save_user_message_patch(
        self,
        ws: web.WebSocketResponse,
        data: dict,
    ):
        """Save a patched user message without triggering LLM response."""
        conversation_id = data.get("conversation_id", "")
        message_index = data.get("message_index")
        block_index = data.get("block_index")
        content_kind = data.get("content_kind")
        edited_raw_text = data.get("raw_text", "")
        revision = data.get("revision", "")

        try:
            loaded = await self._load_active_history(conversation_id)
            if not loaded:
                await self._send_user_patch_failed(
                    ws, conversation_id, "conversation_mismatch"
                )
                return

            history, cid = loaded
            target = self._find_last_user_patch_target(history)
            if not target:
                await self._send_user_patch_failed(
                    ws, conversation_id, "message_not_found"
                )
                return

            current_idx, current_block, current_kind, _ = target

            if (
                current_idx != message_index
                or current_block != block_index
                or current_kind != content_kind
                or self._message_revision(history[message_index]) != revision
            ):
                await self._send_user_patch_failed(
                    ws, conversation_id, "message_changed"
                )
                return

            # Apply the edit
            target_message = history[message_index]
            if content_kind == "string":
                target_message["content"] = edited_raw_text
            else:
                target_message["content"][block_index]["text"] = edited_raw_text

            await runtime.conversation_manager.update_conversation(
                self._umo, cid, history=history,
            )

            logger.info(f"User message patched in conversation {cid}")

            await ws.send_json({
                "type": "user_message_patched",
                "conversation_id": conversation_id,
                "message_index": message_index,
                "raw_text": edited_raw_text,
            })

        except Exception as exc:
            logger.warning(f"Failed to save user message patch: {exc}")
            await self._send_user_patch_failed(
                ws, conversation_id, "message_changed"
            )

    @staticmethod
    async def _send_user_patch_failed(
        ws: web.WebSocketResponse,
        conversation_id: str,
        reason: str,
    ):
        """Send a patch-failed response."""
        try:
            await ws.send_json({
                "type": "user_message_patch_failed",
                "conversation_id": conversation_id,
                "reason": reason,
            })
        except Exception:
            pass

    async def _truncate_last_exchange(self, expected_content: str = "", *, action: str = "retry") -> bool:
        """Remove the last user+assistant exchange from conversation history.

        Strips everything from the last user message onwards.  AstrBot's
        pipeline will re-add the user message when the re-fired event
        is processed.

        If *expected_content* is given, the method verifies that the last
        user message in the DB actually contains that text.  A mismatch
        means the frontend's "last message" is something that was never
        stored (e.g. an AstrBot command response) — in that case we skip
        truncation and return True so the caller still fires the message.
        """
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available for truncation")
                return False

            cid = await runtime.conversation_manager.get_curr_conversation_id(
                self._umo
            )
            if not cid:
                logger.warning("No active conversation to truncate")
                return False

            db_path = self._conversations.find_db()
            if not db_path:
                return False

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cursor = conn.execute(
                "SELECT content FROM conversations WHERE conversation_id = ?",
                (cid,),
            )
            row = cursor.fetchone()
            conn.close()

            if not row or not row[0]:
                return False

            history = json.loads(row[0])

            # Walk backwards to find the last user message
            last_user_idx = None
            for i in range(len(history) - 1, -1, -1):
                if history[i].get("role") == "user":
                    last_user_idx = i
                    break

            if last_user_idx is None:
                logger.warning("No user message found in history to truncate")
                return False

            # Verify that the DB's last user message matches the content
            # we are retrying / editing.  If it doesn't, the frontend's
            # "last message" was probably a command that AstrBot handled
            # without storing — skip truncation to avoid deleting a real
            # exchange.
            if expected_content.strip():
                db_content = history[last_user_idx].get("content", "")
                if isinstance(db_content, list):
                    db_content = "".join(
                        b.get("text", "")
                        for b in db_content
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                if expected_content.strip() not in str(db_content):
                    logger.info(
                        "Skipping truncation: retry/edit content not found "
                        "in last DB user message (likely a command response)"
                    )
                    return True

            # Truncate everything from the last user message onwards
            truncated = history[:last_user_idx]

            await runtime.conversation_manager.update_conversation(
                self._umo, cid, history=truncated,
            )

            logger.info(
                f"Truncated conversation {cid} ({action}): "
                f"{len(history)} -> {len(truncated)} messages"
            )
            return True

        except Exception as exc:
            logger.warning(f"Failed to truncate last exchange: {exc}")
            return False
