"""Media and serialisation utilities for the A&F Web Frontend.

Stateless utility functions for converting between AstrBot message components
and JSON-serialisable segments. Some functions perform filesystem I/O
(reading media files, writing temp files).
"""

import base64
import mimetypes
import os
import uuid
from pathlib import Path

from astrbot.api.event import MessageChain
from astrbot.api.message_components import Node, Plain, Image, Record
from astrbot import logger


async def chain_to_segments(message_chain: MessageChain) -> list[dict]:
    """Convert a MessageChain into JSON-serialisable segments."""
    segments: list[dict] = []
    for comp in message_chain.chain:
        if isinstance(comp, Plain):
            text = comp.text
            if text and text.strip():
                segments.append({"type": "text", "data": text})
        elif isinstance(comp, Image):
            uri = await media_to_data_uri(comp)
            if uri:
                segments.append({"type": "image", "data": uri})
        elif isinstance(comp, Record):
            uri = await media_to_data_uri(comp)
            if uri:
                segments.append({"type": "audio", "data": uri})
        elif isinstance(comp, Node):
            # CoT / tool-call forwarded-message nodes
            texts = []
            for sub in comp.content:
                if isinstance(sub, Plain) and sub.text and sub.text.strip():
                    texts.append(sub.text.strip())
            if texts:
                joined = "\n".join(texts)
                node_name = getattr(comp, "name", "")
                if "\U0001f6e0\ufe0f" in node_name:  # wrench emoji
                    tc = parse_tool_call_text(joined)
                    if tc:
                        segments.append(tc)
                    else:
                        segments.append({"type": "reasoning", "data": joined})
                else:
                    segments.append({"type": "reasoning", "data": joined})
    return segments


def parse_tool_call_text(text: str) -> dict | None:
    """Parse show_tool_call plugin output into a structured tool_call segment."""
    try:
        tool_marker = "\U0001f527 Tool\n"           # wrench Tool
        args_marker = "\n\n\U0001f4e6 Arguments\n"  # package Arguments
        result_marker = "\n\n\U0001f4e8 Result\n"   # envelope Result

        if tool_marker not in text:
            return None

        # Tool name
        after_tool = text.split(tool_marker, 1)[1]
        name_end = after_tool.find("\n\n")
        tool_name = (
            after_tool[:name_end].strip() if name_end != -1
            else after_tool.strip()
        )

        # Arguments
        args_text = ""
        if args_marker in text:
            after_args = text.split(args_marker, 1)[1]
            r_idx = after_args.find("\n\n\U0001f4e8 Result")
            args_text = (
                after_args[:r_idx].strip() if r_idx != -1
                else after_args.strip()
            )
            # Unwrap single code field: "code:\n```\n...\n```" -> just the code
            prefix = "code:\n```\n"
            suffix = "\n```"
            if args_text.startswith(prefix) and args_text.endswith(suffix):
                args_text = args_text[len(prefix):-len(suffix)]

        # Result
        result_text = ""
        if result_marker in text:
            after_result = text.split(result_marker, 1)[1]
            stripped = after_result.strip()
            if stripped.startswith('"""') and stripped.endswith('"""'):
                stripped = stripped[3:-3].strip()
            result_text = stripped

        return {
            "type": "tool_call",
            "name": tool_name,
            "args": args_text,
            "result": result_text,
        }
    except Exception:
        return None


async def media_to_data_uri(component) -> str | None:
    """Best-effort conversion of a media component to a data-URI."""
    try:
        file_path = await component.convert_to_file_path()
        if file_path and os.path.exists(file_path):
            mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
            with open(file_path, "rb") as fh:
                encoded = base64.b64encode(fh.read()).decode("utf-8")
            return f"data:{mime};base64,{encoded}"
    except Exception as exc:
        logger.warning(f"Media conversion failed: {exc}")

    # Fallback — pass through any HTTP URL
    url = getattr(component, "url", None) or getattr(component, "file", None)
    if isinstance(url, str) and url.startswith("http"):
        return url
    return None


def save_temp_media(data_uri: str, media_type: str) -> str | None:
    """Decode a data-URI / raw base64 string and write it to a temp file."""
    try:
        if data_uri.startswith("data:"):
            header, encoded = data_uri.split(",", 1)
            mime = header.split(":")[1].split(";")[0]
            ext = mimetypes.guess_extension(mime) or ".bin"
        else:
            encoded = data_uri
            ext = ".png" if media_type == "image" else ".wav"

        raw = base64.b64decode(encoded)
        tmp_dir = Path("/tmp/abyss_frontend")
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = tmp_dir / f"{uuid.uuid4()}{ext}"
        tmp_path.write_bytes(raw)
        return str(tmp_path)
    except Exception as exc:
        logger.warning(f"Failed to save temp media: {exc}")
        return None


def save_temp_file(data_uri: str, original_name: str) -> str | None:
    """Decode a data-URI and write it to a temp file, preserving the original extension."""
    try:
        if data_uri.startswith("data:"):
            _, encoded = data_uri.split(",", 1)
        else:
            encoded = data_uri

        # Preserve original extension — more reliable than MIME for code files
        _, ext = os.path.splitext(original_name)
        if not ext:
            ext = ".bin"

        raw = base64.b64decode(encoded)
        tmp_dir = Path("/tmp/abyss_frontend")
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = tmp_dir / f"{uuid.uuid4()}{ext}"
        tmp_path.write_bytes(raw)
        return str(tmp_path)
    except Exception as exc:
        logger.warning(f"Failed to save temp file '{original_name}': {exc}")
        return None
